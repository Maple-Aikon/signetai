use async_trait::async_trait;
use forge_core::hook::{HookInput, HookOutput};
use reqwest::Client;
use std::time::Duration;
use tracing::{debug, warn};

use super::HookExecutor;

/// Daemon-delegated executor for Prompt and Agent hooks.
///
/// Routes to the Signet daemon at `/api/hooks/prompt-eval` (prompt hooks)
/// and `/api/hooks/agent-eval` (agent hooks). The daemon already has
/// LLM provider access for extraction/synthesis, so Forge delegates
/// evaluation rather than running its own LLM call.
pub struct DaemonExecutor {
    endpoint: String,
    client: Client,
    timeout: Duration,
    prompt_template: Option<String>,
}

impl DaemonExecutor {
    pub fn new(
        base_url: String,
        prompt_template: Option<String>,
        timeout: Option<u64>,
        agent: bool,
    ) -> Self {
        let path = if agent {
            "/api/hooks/agent-eval"
        } else {
            "/api/hooks/prompt-eval"
        };
        Self {
            endpoint: format!("{base_url}{path}"),
            client: Client::new(),
            timeout: Duration::from_secs(timeout.unwrap_or(30)),
            prompt_template,
        }
    }

    /// Interpolate template placeholders with values from the hook input.
    fn interpolate(template: &str, input: &HookInput) -> String {
        let mut result = template.to_string();

        result = result.replace("{{event}}", &format!("{:?}", input.event));

        let name = input.tool_name.as_deref().unwrap_or("");
        result = result.replace("{{tool_name}}", name);

        let tool_input = input
            .payload
            .get("toolInput")
            .map(|v| v.to_string())
            .unwrap_or_default();
        result = result.replace("{{tool_input}}", &tool_input);

        result = result.replace("{{payload}}", &input.payload.to_string());

        result
    }
}

#[async_trait]
impl HookExecutor for DaemonExecutor {
    async fn execute(&self, input: &HookInput) -> HookOutput {
        debug!("Executing daemon hook: POST {}", self.endpoint);

        let prompt = match &self.prompt_template {
            Some(tpl) => Self::interpolate(tpl, input),
            None => serde_json::to_string(input).unwrap_or_default(),
        };

        let body = serde_json::json!({
            "prompt": prompt,
            "event": format!("{:?}", input.event),
            "input": input,
        });

        let result = self
            .client
            .post(&self.endpoint)
            .json(&body)
            .timeout(self.timeout)
            .send()
            .await;

        let resp = match result {
            Ok(r) => r,
            Err(e) => {
                if e.is_timeout() {
                    warn!("Daemon hook timed out: {}", self.endpoint);
                    return HookOutput::error(format!(
                        "Daemon hook timed out after {}s",
                        self.timeout.as_secs()
                    ));
                }
                warn!("Daemon hook request failed: {e}");
                return HookOutput::error(format!("Request failed: {e}"));
            }
        };

        let text = match resp.text().await {
            Ok(t) => t,
            Err(e) => {
                warn!("Daemon hook response read failed: {e}");
                return HookOutput::error(format!("Response read failed: {e}"));
            }
        };

        if text.is_empty() {
            return HookOutput::allow();
        }

        // Try to parse as daemon response: {ok, reason, inject}
        let val = match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(v) => v,
            Err(_) => {
                // Non-JSON — treat as inject text
                return HookOutput::allow().with_inject(text);
            }
        };

        let ok = val.get("ok").and_then(|v| v.as_bool()).unwrap_or(true);
        if !ok {
            let reason = val
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("Denied by daemon evaluation")
                .to_string();
            return HookOutput::block(reason);
        }

        let mut output = HookOutput::allow();
        if let Some(inject) = val.get("inject").and_then(|v| v.as_str()) {
            output = output.with_inject(inject.to_string());
        }
        output.with_data(val)
    }
}
