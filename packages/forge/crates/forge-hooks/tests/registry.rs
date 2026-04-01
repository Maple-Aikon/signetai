use forge_core::hook::{
    HookConfig, HookDecision, HookEntry, HookEvent, HookInput, HookType, Matcher,
};
use forge_hooks::HookRegistry;
use std::collections::HashMap;

fn sample_input() -> HookInput {
    HookInput::pre_tool_use("Bash", &serde_json::json!({"command": "ls"}), "tool-1")
}

mod new_registry {
    use super::*;

    #[tokio::test]
    async fn empty_registry_returns_allow() {
        let registry = HookRegistry::new();
        let result = registry
            .dispatch(HookEvent::PreToolUse, sample_input())
            .await;
        assert_eq!(result.decision, HookDecision::Allow);
    }

    #[tokio::test]
    async fn empty_registry_no_outputs() {
        let registry = HookRegistry::new();
        let result = registry
            .dispatch(HookEvent::SessionStart, HookInput::session_start("s1", None))
            .await;
        assert_eq!(result.decision, HookDecision::Allow);
        assert!(result.outputs.is_empty());
    }
}

mod builtin_registration {
    use super::*;

    #[tokio::test]
    async fn register_builtin_http_fires_on_matching_event() {
        let mut registry = HookRegistry::new();
        // Register a built-in that would need a real server — we test registration only.
        // Since no server is listening, the HTTP executor will return Error (non-blocking).
        registry.register_builtin_http(
            HookEvent::SessionStart,
            "http://127.0.0.1:1/test",
            HashMap::new(),
        );

        let result = registry
            .dispatch(
                HookEvent::SessionStart,
                HookInput::session_start("s1", None),
            )
            .await;

        // Should have tried to execute (connection refused = Error, not empty)
        assert!(!result.outputs.is_empty(), "Built-in hook should have fired");
        // Connection refused is a non-blocking Error
        assert_eq!(result.decision, HookDecision::Error);
    }

    #[tokio::test]
    async fn builtin_does_not_fire_on_other_events() {
        let mut registry = HookRegistry::new();
        registry.register_builtin_http(
            HookEvent::SessionStart,
            "http://127.0.0.1:1/test",
            HashMap::new(),
        );

        let result = registry
            .dispatch(HookEvent::Stop, HookInput::stop("s1"))
            .await;

        assert!(
            result.outputs.is_empty(),
            "Hook registered for SessionStart should not fire on Stop"
        );
        assert_eq!(result.decision, HookDecision::Allow);
    }
}

mod config_registration {
    use super::*;

    fn make_config(event: HookEvent, entries: Vec<HookEntry>) -> HookConfig {
        let mut events = HashMap::new();
        events.insert(event, entries);
        HookConfig { events }
    }

    #[tokio::test]
    async fn register_from_config_command_hook() {
        let mut registry = HookRegistry::new();
        let config = make_config(
            HookEvent::PreToolUse,
            vec![HookEntry {
                hook_type: HookType::Command,
                command: Some("true".to_string()),
                url: None,
                prompt: None,
                matcher: Matcher::All,
                timeout: Some(5),
                fire_and_forget: false,
            }],
        );

        registry.register_from_config(&config);

        let result = registry
            .dispatch(HookEvent::PreToolUse, sample_input())
            .await;

        assert!(!result.outputs.is_empty(), "Config hook should fire");
        assert_eq!(result.decision, HookDecision::Allow);
    }

    #[tokio::test]
    async fn multiple_hooks_on_same_event_all_fire() {
        let mut registry = HookRegistry::new();
        // Use distinct commands so deduplication doesn't collapse them
        let config = make_config(
            HookEvent::PreToolUse,
            vec![
                HookEntry {
                    hook_type: HookType::Command,
                    command: Some("echo hook-a".to_string()),
                    url: None,
                    prompt: None,
                    matcher: Matcher::All,
                    timeout: None,
                    fire_and_forget: false,
                },
                HookEntry {
                    hook_type: HookType::Command,
                    command: Some("echo hook-b".to_string()),
                    url: None,
                    prompt: None,
                    matcher: Matcher::All,
                    timeout: None,
                    fire_and_forget: false,
                },
            ],
        );

        registry.register_from_config(&config);

        let result = registry
            .dispatch(HookEvent::PreToolUse, sample_input())
            .await;

        assert!(
            result.outputs.len() >= 2,
            "Both hooks should fire, got {} outputs",
            result.outputs.len()
        );
    }

    #[tokio::test]
    async fn hooks_on_different_events_only_matching_fires() {
        let mut registry = HookRegistry::new();

        let mut events = HashMap::new();
        events.insert(
            HookEvent::PreToolUse,
            vec![HookEntry {
                hook_type: HookType::Command,
                command: Some("echo pre-tool".to_string()),
                url: None,
                prompt: None,
                matcher: Matcher::All,
                timeout: None,
                fire_and_forget: false,
            }],
        );
        events.insert(
            HookEvent::Stop,
            vec![HookEntry {
                hook_type: HookType::Command,
                command: Some("echo stop".to_string()),
                url: None,
                prompt: None,
                matcher: Matcher::All,
                timeout: None,
                fire_and_forget: false,
            }],
        );

        registry.register_from_config(&HookConfig { events });

        let result = registry
            .dispatch(HookEvent::PreToolUse, sample_input())
            .await;
        assert_eq!(result.outputs.len(), 1, "Only PreToolUse hook should fire");

        let result = registry
            .dispatch(HookEvent::Stop, HookInput::stop("s1"))
            .await;
        assert_eq!(result.outputs.len(), 1, "Only Stop hook should fire");
    }
}

mod user_suppresses_builtin {
    use super::*;

    #[tokio::test]
    async fn user_http_same_url_suppresses_builtin() {
        let mut registry = HookRegistry::new();

        // Register a built-in HTTP hook
        registry.register_builtin_http(
            HookEvent::SessionStart,
            "http://127.0.0.1:3850/api/hooks/session-start",
            HashMap::new(),
        );

        // Register a user hook to the same URL
        let config = HookConfig {
            events: {
                let mut m = HashMap::new();
                m.insert(
                    HookEvent::SessionStart,
                    vec![HookEntry {
                        hook_type: HookType::Http,
                        command: None,
                        url: Some("http://127.0.0.1:3850/api/hooks/session-start".to_string()),
                        prompt: None,
                        matcher: Matcher::All,
                        timeout: None,
                        fire_and_forget: false,
                    }],
                );
                m
            },
        };

        registry.register_from_config(&config);

        let result = registry
            .dispatch(
                HookEvent::SessionStart,
                HookInput::session_start("s1", None),
            )
            .await;

        // Should fire only once (user suppresses built-in at same URL)
        assert_eq!(
            result.outputs.len(),
            1,
            "Duplicate URL should be deduplicated, got {} outputs",
            result.outputs.len()
        );
    }
}

mod reload {
    use super::*;

    #[tokio::test]
    async fn reload_replaces_user_hooks() {
        let mut registry = HookRegistry::new();

        // Register initial config
        let config1 = HookConfig {
            events: {
                let mut m = HashMap::new();
                m.insert(
                    HookEvent::PreToolUse,
                    vec![HookEntry {
                        hook_type: HookType::Command,
                        command: Some("echo first".to_string()),
                        url: None,
                        prompt: None,
                        matcher: Matcher::All,
                        timeout: None,
                        fire_and_forget: false,
                    }],
                );
                m
            },
        };
        registry.register_from_config(&config1);

        // Reload with different config
        let config2 = HookConfig {
            events: {
                let mut m = HashMap::new();
                m.insert(
                    HookEvent::Stop,
                    vec![HookEntry {
                        hook_type: HookType::Command,
                        command: Some("echo second".to_string()),
                        url: None,
                        prompt: None,
                        matcher: Matcher::All,
                        timeout: None,
                        fire_and_forget: false,
                    }],
                );
                m
            },
        };
        registry.reload(&config2);

        // Old hook should not fire
        let result = registry
            .dispatch(HookEvent::PreToolUse, sample_input())
            .await;
        assert!(
            result.outputs.is_empty(),
            "Old PreToolUse hook should be gone after reload"
        );

        // New hook should fire
        let result = registry
            .dispatch(HookEvent::Stop, HookInput::stop("s1"))
            .await;
        assert!(
            !result.outputs.is_empty(),
            "New Stop hook should fire after reload"
        );
    }

    #[tokio::test]
    async fn reload_keeps_builtins() {
        let mut registry = HookRegistry::new();

        // Register a built-in
        registry.register_builtin_http(
            HookEvent::SessionStart,
            "http://127.0.0.1:1/builtin",
            HashMap::new(),
        );

        // Register user config
        let config1 = HookConfig {
            events: {
                let mut m = HashMap::new();
                m.insert(
                    HookEvent::PreToolUse,
                    vec![HookEntry {
                        hook_type: HookType::Command,
                        command: Some("true".to_string()),
                        url: None,
                        prompt: None,
                        matcher: Matcher::All,
                        timeout: None,
                        fire_and_forget: false,
                    }],
                );
                m
            },
        };
        registry.register_from_config(&config1);

        // Reload with empty config
        registry.reload(&HookConfig::default());

        // Built-in should still fire
        let result = registry
            .dispatch(
                HookEvent::SessionStart,
                HookInput::session_start("s1", None),
            )
            .await;
        assert!(
            !result.outputs.is_empty(),
            "Built-in hooks should survive reload"
        );
    }
}
