use serde::{Deserialize, Serialize};

/// Lifecycle events that hooks can subscribe to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum HookEvent {
    SessionStart,
    SessionEnd,
    UserPromptSubmit,
    PreCompact,
    PostCompact,
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
    Stop,
    PermissionRequest,
    PermissionDenied,
    Notification,
    SubagentStart,
    CwdChanged,
}

impl HookEvent {
    /// Whether this event supports blocking (returning Block to prevent the action).
    pub fn supports_blocking(self) -> bool {
        matches!(
            self,
            Self::PreToolUse | Self::UserPromptSubmit | Self::PermissionRequest
        )
    }
}

/// Decision returned by a hook execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookDecision {
    /// Proceed normally (exit code 0).
    Allow,
    /// Block the action (exit code 2).
    Block,
    /// Non-blocking error — log and continue.
    Error,
}

impl Default for HookDecision {
    fn default() -> Self {
        Self::Allow
    }
}

/// Output returned by a single hook execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookOutput {
    #[serde(default)]
    pub decision: HookDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Text to inject into the conversation context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inject: Option<String>,
    /// Event-specific structured data.
    #[serde(default)]
    pub data: serde_json::Value,
}

impl Default for HookOutput {
    fn default() -> Self {
        Self {
            decision: HookDecision::Allow,
            reason: None,
            inject: None,
            data: serde_json::Value::Null,
        }
    }
}

impl HookOutput {
    pub fn allow() -> Self {
        Self::default()
    }

    pub fn block(reason: impl Into<String>) -> Self {
        Self {
            decision: HookDecision::Block,
            reason: Some(reason.into()),
            ..Self::default()
        }
    }

    pub fn error(reason: impl Into<String>) -> Self {
        Self {
            decision: HookDecision::Error,
            reason: Some(reason.into()),
            ..Self::default()
        }
    }

    pub fn with_inject(mut self, text: impl Into<String>) -> Self {
        self.inject = Some(text.into());
        self
    }

    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = data;
        self
    }
}

/// Input passed to hook executors, containing event-specific data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookInput {
    pub event: HookEvent,
    /// The tool name or other matchable identifier for this event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Event-specific payload as dynamic JSON.
    #[serde(default)]
    pub payload: serde_json::Value,
}

impl HookInput {
    pub fn new(event: HookEvent) -> Self {
        Self {
            event,
            tool_name: None,
            payload: serde_json::Value::Null,
        }
    }

    pub fn session_start(session_id: &str, cwd: Option<&str>) -> Self {
        Self {
            event: HookEvent::SessionStart,
            tool_name: None,
            // harness:"forge" satisfies the daemon's required field; sessionKey mirrors
            // the daemon's expected field name for session tracking.
            payload: serde_json::json!({
                "harness": "forge",
                "sessionKey": session_id,
                "cwd": cwd,
            }),
        }
    }

    pub fn session_end(session_id: &str, transcript: &str) -> Self {
        Self {
            event: HookEvent::SessionEnd,
            tool_name: None,
            payload: serde_json::json!({
                "harness": "forge",
                "sessionKey": session_id,
                "transcript": transcript,
            }),
        }
    }

    pub fn prompt_submit(session_id: &str, message: &str) -> Self {
        Self {
            event: HookEvent::UserPromptSubmit,
            tool_name: None,
            payload: serde_json::json!({
                "harness": "forge",
                "sessionKey": session_id,
                "userMessage": message,
            }),
        }
    }

    pub fn pre_tool_use(name: &str, input: &serde_json::Value, id: &str) -> Self {
        Self {
            event: HookEvent::PreToolUse,
            tool_name: Some(name.to_string()),
            payload: serde_json::json!({
                "toolName": name,
                "toolInput": input,
                "toolUseId": id,
            }),
        }
    }

    pub fn post_tool_use(
        name: &str,
        input: &serde_json::Value,
        result: &crate::ToolResult,
    ) -> Self {
        Self {
            event: HookEvent::PostToolUse,
            tool_name: Some(name.to_string()),
            payload: serde_json::json!({
                "toolName": name,
                "toolInput": input,
                "toolOutput": result.content,
                "isError": result.is_error,
            }),
        }
    }

    pub fn pre_compact(session_id: &str) -> Self {
        Self {
            event: HookEvent::PreCompact,
            tool_name: None,
            payload: serde_json::json!({
                "harness": "forge",
                "sessionKey": session_id,
            }),
        }
    }

    pub fn post_compact(summary: &str, message_count: usize) -> Self {
        Self {
            event: HookEvent::PostCompact,
            tool_name: None,
            payload: serde_json::json!({
                "summary": summary,
                "messageCount": message_count,
            }),
        }
    }

    pub fn stop(session_id: &str) -> Self {
        Self {
            event: HookEvent::Stop,
            tool_name: None,
            payload: serde_json::json!({
                "sessionId": session_id,
            }),
        }
    }

    pub fn post_tool_use_failure(name: &str, input: &serde_json::Value, error: &str, id: &str) -> Self {
        Self {
            event: HookEvent::PostToolUseFailure,
            tool_name: Some(name.to_string()),
            payload: serde_json::json!({
                "toolName": name,
                "toolInput": input,
                "error": error,
                "toolUseId": id,
            }),
        }
    }

    pub fn permission_request(tool_name: &str, tool_input: &serde_json::Value, permission_level: &str) -> Self {
        Self {
            event: HookEvent::PermissionRequest,
            tool_name: Some(tool_name.to_string()),
            payload: serde_json::json!({
                "toolName": tool_name,
                "toolInput": tool_input,
                "permissionLevel": permission_level,
            }),
        }
    }

    pub fn permission_denied(tool_name: &str, tool_input: &serde_json::Value) -> Self {
        Self {
            event: HookEvent::PermissionDenied,
            tool_name: Some(tool_name.to_string()),
            payload: serde_json::json!({
                "toolName": tool_name,
                "toolInput": tool_input,
            }),
        }
    }

    pub fn notification(message: &str, level: &str) -> Self {
        Self {
            event: HookEvent::Notification,
            tool_name: None,
            payload: serde_json::json!({
                "message": message,
                "level": level,
            }),
        }
    }

    /// The matchable string for this input (tool name if present).
    pub fn match_target(&self) -> Option<&str> {
        self.tool_name.as_deref()
    }
}

/// Matcher pattern for filtering which hooks fire on which inputs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Matcher {
    /// Match everything (empty string, "*", or omitted).
    All,
    /// Pattern string: exact, pipe-separated, or regex.
    Pattern(String),
}

impl Default for Matcher {
    fn default() -> Self {
        Self::All
    }
}

/// How a hook is executed.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookType {
    Command,
    Http,
    Prompt,
    Agent,
}

/// A single hook entry from configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookEntry {
    #[serde(rename = "type")]
    pub hook_type: HookType,
    /// Shell command (for Command hooks).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// URL (for Http hooks).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// LLM prompt template (for Prompt hooks).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Matcher pattern.
    #[serde(default)]
    pub matcher: Matcher,
    /// Timeout in seconds.
    #[serde(default)]
    pub timeout: Option<u64>,
    /// Fire-and-forget mode (don't wait for completion).
    #[serde(default, rename = "async")]
    pub fire_and_forget: bool,
}

/// Top-level hook configuration from agent.yaml.
/// Maps event names to lists of hook entries.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HookConfig {
    #[serde(flatten)]
    pub events: std::collections::HashMap<HookEvent, Vec<HookEntry>>,
}

/// Aggregated result from dispatching hooks for a single event.
#[derive(Debug, Clone)]
pub struct AggregatedResult {
    pub decision: HookDecision,
    pub reason: Option<String>,
    /// Combined injection text from all hooks.
    pub inject: Option<String>,
    /// Structured data from the first hook that returned data.
    pub data: serde_json::Value,
    /// Individual outputs for inspection.
    pub outputs: Vec<HookOutput>,
}

impl Default for AggregatedResult {
    fn default() -> Self {
        Self {
            decision: HookDecision::Allow,
            reason: None,
            inject: None,
            data: serde_json::Value::Null,
            outputs: Vec::new(),
        }
    }
}

impl AggregatedResult {
    /// Aggregate multiple hook outputs into a single result.
    /// Any Block = Block. All Error (no Allow) = Error. Otherwise Allow.
    pub fn aggregate(outputs: Vec<HookOutput>) -> Self {
        if outputs.is_empty() {
            return Self::default();
        }

        let mut decision = HookDecision::Allow;
        let mut reason = None;
        let mut injections = Vec::new();
        let mut data = serde_json::Value::Null;

        let mut has_allow = false;

        for output in &outputs {
            match output.decision {
                HookDecision::Block => {
                    decision = HookDecision::Block;
                    if reason.is_none() {
                        reason = output.reason.clone();
                    }
                }
                HookDecision::Allow => {
                    has_allow = true;
                }
                HookDecision::Error => {}
            }

            if let Some(ref text) = output.inject {
                if !text.is_empty() {
                    injections.push(text.clone());
                }
            }

            if data.is_null() && !output.data.is_null() {
                data = output.data.clone();
            }
        }

        // If no Block and no Allow, all were Error
        if decision != HookDecision::Block && !has_allow {
            decision = HookDecision::Error;
            reason = outputs
                .iter()
                .find_map(|o| o.reason.clone());
        }

        let inject = if injections.is_empty() {
            None
        } else {
            Some(injections.join("\n\n"))
        };

        Self {
            decision,
            reason,
            inject,
            data,
            outputs,
        }
    }
}
