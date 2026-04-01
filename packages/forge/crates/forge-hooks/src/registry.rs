use std::collections::HashMap;
use std::sync::Arc;

use forge_core::hook::{
    AggregatedResult, HookConfig, HookDecision, HookEntry, HookEvent, HookInput, HookOutput,
    HookType, Matcher,
};
use tracing::{debug, info, warn};

use crate::executor::command::CommandExecutor;
use crate::executor::daemon::DaemonExecutor;
use crate::executor::http::HttpExecutor;
use crate::executor::HookExecutor;

/// Source of a registered hook (built-in vs user-configured).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookSource {
    Builtin,
    User,
}

/// A registered hook with its source, entry configuration, and optional headers.
/// Headers are stored separately from HookEntry (which is YAML-serializable) so
/// that auth headers injected at runtime don't pollute the config schema.
#[derive(Debug, Clone)]
pub struct RegisteredHook {
    pub source: HookSource,
    pub entry: HookEntry,
    /// Extra headers forwarded to HttpExecutor (e.g. daemon auth headers for built-ins).
    pub headers: HashMap<String, String>,
}

/// Shared, hot-reloadable hook registry behind a tokio RwLock.
pub type SharedRegistry = Arc<tokio::sync::RwLock<HookRegistry>>;

/// Central registry of all hooks, supporting built-in and user-configured hooks.
pub struct HookRegistry {
    hooks: HashMap<HookEvent, Vec<RegisteredHook>>,
    daemon_url: Option<String>,
}

impl HookRegistry {
    pub fn new() -> Self {
        Self {
            hooks: HashMap::new(),
            daemon_url: None,
        }
    }

    /// Set the daemon base URL for Prompt/Agent hook delegation.
    pub fn with_daemon_url(mut self, url: String) -> Self {
        self.daemon_url = Some(url);
        self
    }

    /// Register a single built-in HTTP hook for a specific event.
    pub fn register_builtin_http(
        &mut self,
        event: HookEvent,
        url: &str,
        headers: HashMap<String, String>,
    ) {
        let entry = HookEntry {
            hook_type: HookType::Http,
            command: None,
            url: Some(url.to_string()),
            prompt: None,
            matcher: Matcher::All,
            timeout: Some(10),
            fire_and_forget: false,
        };
        self.hooks.entry(event).or_default().push(RegisteredHook {
            source: HookSource::Builtin,
            entry,
            headers,
        });
        debug!("Registered built-in HTTP hook for {:?}: {}", event, url);
    }

    /// Register the 4 built-in Signet daemon HTTP hooks with auth headers.
    ///
    /// Pass the daemon auth headers (e.g. from `build_daemon_headers`) so that
    /// the built-in hooks authenticate identically to direct daemon calls.
    /// Pass `HashMap::new()` only in tests where auth is not needed.
    pub fn register_builtin(&mut self, base_url: &str, headers: HashMap<String, String>) {
        self.register_builtin_http(
            HookEvent::SessionStart,
            &format!("{base_url}/api/hooks/session-start"),
            headers.clone(),
        );
        self.register_builtin_http(
            HookEvent::UserPromptSubmit,
            &format!("{base_url}/api/hooks/user-prompt-submit"),
            headers.clone(),
        );
        self.register_builtin_http(
            HookEvent::PreCompact,
            &format!("{base_url}/api/hooks/pre-compaction"),
            headers.clone(),
        );
        self.register_builtin_http(
            HookEvent::SessionEnd,
            &format!("{base_url}/api/hooks/session-end"),
            headers,
        );
        info!("Registered 4 built-in daemon hooks");
    }

    /// Register hooks from user configuration (agent.yaml hooks section).
    /// User HTTP hooks to the same URL as a built-in suppress the built-in.
    pub fn register_from_config(&mut self, config: &HookConfig) {
        let mut count = 0;

        for (event, entries) in &config.events {
            let registered = self.hooks.entry(*event).or_default();

            for entry in entries {
                // Check if a user HTTP hook targets the same URL as a built-in
                if entry.hook_type == HookType::Http {
                    if let Some(url) = &entry.url {
                        let suppressed = registered.iter().position(|h| {
                            h.source == HookSource::Builtin
                                && h.entry.url.as_deref() == Some(url)
                        });
                        if let Some(idx) = suppressed {
                            debug!(
                                "User HTTP hook suppresses built-in for {:?}: {}",
                                event, url
                            );
                            registered.remove(idx);
                        }
                    }
                }

                registered.push(RegisteredHook {
                    source: HookSource::User,
                    entry: entry.clone(),
                    headers: HashMap::new(),
                });
                count += 1;
            }
        }

        if count > 0 {
            info!("Registered {count} user hooks from config");
        }
    }

    /// Hot-reload: clear user hooks and re-register from new config.
    /// Built-in hooks are preserved.
    pub fn reload(&mut self, config: &HookConfig) {
        for hooks in self.hooks.values_mut() {
            hooks.retain(|h| h.source == HookSource::Builtin);
        }
        self.register_from_config(config);
        debug!("Hot-reloaded hook registry");
    }

    /// Get all registered hooks for a given event.
    pub fn get(&self, event: HookEvent) -> &[RegisteredHook] {
        self.hooks.get(&event).map(|v| v.as_slice()).unwrap_or(&[])
    }

    /// Total number of registered hooks across all events.
    pub fn count(&self) -> usize {
        self.hooks.values().map(|v| v.len()).sum()
    }

    /// Dispatch hooks for an event directly on an owned/borrowed registry.
    ///
    /// For production code behind a `SharedRegistry` (Arc<RwLock<>>), prefer
    /// the free `dispatch()` function which releases the read lock before async
    /// execution. This method is ergonomic for tests and single-owner contexts.
    pub async fn dispatch(&self, event: HookEvent, input: HookInput) -> AggregatedResult {
        use crate::matcher::matches;
        use futures::future::join_all;

        let hooks = self.get(event);
        if hooks.is_empty() {
            return AggregatedResult::default();
        }
        let target = input.match_target().map(|s| s.to_string());
        let matching: Vec<RegisteredHook> = hooks
            .iter()
            .filter(|h| matches(&h.entry.matcher, target.as_deref()))
            .cloned()
            .collect();

        if matching.is_empty() {
            return AggregatedResult::default();
        }

        let daemon_url = self.daemon_url().map(str::to_string);
        debug!(
            "Dispatching {:?}: {} matching hooks (of {} registered)",
            event,
            matching.len(),
            hooks.len()
        );

        let futures: Vec<_> = matching
            .iter()
            .map(|hook| {
                let input = input.clone();
                let entry = hook.entry.clone();
                let headers = hook.headers.clone();
                let daemon = daemon_url.clone();
                async move { execute_hook(&entry, &headers, &input, daemon.as_deref()).await }
            })
            .collect();

        let outputs = join_all(futures).await;
        let result = AggregatedResult::aggregate(outputs);

        if result.decision == HookDecision::Block && !event.supports_blocking() {
            warn!(
                "Hook returned Block for {:?} which doesn't support blocking — treating as Allow",
                event
            );
            return AggregatedResult {
                decision: HookDecision::Allow,
                ..result
            };
        }

        result
    }
}

impl Default for HookRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Access daemon_url for external callers (e.g. dispatch module).
impl HookRegistry {
    pub fn daemon_url(&self) -> Option<&str> {
        self.daemon_url.as_deref()
    }
}

/// Execute a single hook entry, building the appropriate executor.
pub(crate) async fn execute_hook(
    entry: &HookEntry,
    headers: &HashMap<String, String>,
    input: &HookInput,
    daemon_url: Option<&str>,
) -> HookOutput {
    match entry.hook_type {
        HookType::Command => {
            let cmd = match &entry.command {
                Some(c) => c.clone(),
                None => return HookOutput::error("Command hook missing 'command' field"),
            };
            let executor = CommandExecutor::new(cmd, entry.timeout, entry.fire_and_forget);
            executor.execute(input).await
        }
        HookType::Http => {
            let url = match &entry.url {
                Some(u) => u.clone(),
                None => return HookOutput::error("HTTP hook missing 'url' field"),
            };
            let executor = HttpExecutor::new(url, entry.timeout)
                .with_headers(headers.clone());
            executor.execute(input).await
        }
        HookType::Prompt | HookType::Agent => {
            let base = match daemon_url {
                Some(u) => u.to_string(),
                None => {
                    warn!("Prompt/Agent hook requires daemon_url but none configured");
                    return HookOutput::error(
                        "Prompt/Agent hook requires daemon_url configuration",
                    );
                }
            };
            let agent = entry.hook_type == HookType::Agent;
            let executor = DaemonExecutor::new(base, entry.prompt.clone(), entry.timeout, agent)
                .with_headers(headers.clone());
            executor.execute(input).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_hooks_registered() {
        let mut reg = HookRegistry::new();
        reg.register_builtin("http://localhost:3850", HashMap::new());
        assert_eq!(reg.count(), 4);

        let start = reg.get(HookEvent::SessionStart);
        assert_eq!(start.len(), 1);
        assert_eq!(start[0].source, HookSource::Builtin);
    }

    #[test]
    fn user_hooks_alongside_builtins() {
        let mut reg = HookRegistry::new();
        reg.register_builtin("http://localhost:3850", HashMap::new());

        let mut config = HookConfig::default();
        config.events.insert(
            HookEvent::PreToolUse,
            vec![HookEntry {
                hook_type: HookType::Command,
                command: Some("echo test".into()),
                url: None,
                prompt: None,
                matcher: Matcher::Pattern("Bash".into()),
                timeout: Some(5),
                fire_and_forget: false,
            }],
        );
        reg.register_from_config(&config);
        assert_eq!(reg.count(), 5);
    }

    #[test]
    fn user_http_suppresses_builtin() {
        let mut reg = HookRegistry::new();
        reg.register_builtin("http://localhost:3850", HashMap::new());

        let mut config = HookConfig::default();
        config.events.insert(
            HookEvent::SessionStart,
            vec![HookEntry {
                hook_type: HookType::Http,
                command: None,
                url: Some("http://localhost:3850/api/hooks/session-start".into()),
                prompt: None,
                matcher: Matcher::All,
                timeout: Some(15),
                fire_and_forget: false,
            }],
        );
        reg.register_from_config(&config);

        let start = reg.get(HookEvent::SessionStart);
        assert_eq!(start.len(), 1);
        assert_eq!(start[0].source, HookSource::User);
    }

    #[test]
    fn reload_preserves_builtins() {
        let mut reg = HookRegistry::new();
        reg.register_builtin("http://localhost:3850", HashMap::new());

        let mut config = HookConfig::default();
        config.events.insert(
            HookEvent::PreToolUse,
            vec![HookEntry {
                hook_type: HookType::Command,
                command: Some("echo v1".into()),
                url: None,
                prompt: None,
                matcher: Matcher::All,
                timeout: None,
                fire_and_forget: false,
            }],
        );
        reg.register_from_config(&config);
        assert_eq!(reg.count(), 5);

        let mut new_config = HookConfig::default();
        new_config.events.insert(
            HookEvent::Stop,
            vec![HookEntry {
                hook_type: HookType::Command,
                command: Some("echo v2".into()),
                url: None,
                prompt: None,
                matcher: Matcher::All,
                timeout: None,
                fire_and_forget: false,
            }],
        );
        reg.reload(&new_config);

        assert_eq!(reg.count(), 5);
        assert!(reg.get(HookEvent::PreToolUse).is_empty());
        assert_eq!(reg.get(HookEvent::Stop).len(), 1);
    }
}
