use async_trait::async_trait;
use forge_core::hook::{HookInput, HookOutput};
use reqwest::Client;
use std::collections::HashMap;
use std::time::Duration;
use tracing::{debug, warn};

use super::HookExecutor;

/// Executes hooks as HTTP POST requests.
///
/// - POSTs HookInput as JSON to the configured URL
/// - Parses response body as JSON HookOutput
/// - Supports custom headers with env var interpolation ($VAR_NAME)
/// - Connection errors return Error (non-blocking, not fatal)
/// - Non-2xx still parses body (like Claude Code behavior)
/// Build the HTTP request body for a hook: flatten `input.payload` fields to
/// the top level and add an `event` key.  Daemon endpoints (session-start,
/// user-prompt-submit, etc.) parse their expected fields directly from the body
/// root; the extra `event` key is ignored by them but available to user hooks.
fn flatten_payload(input: &HookInput) -> serde_json::Value {
    let event = format!("{:?}", input.event);
    let mut map = match &input.payload {
        serde_json::Value::Object(m) => m.clone(),
        other => {
            let mut m = serde_json::Map::new();
            m.insert("payload".to_string(), other.clone());
            m
        }
    };
    map.insert("event".to_string(), serde_json::Value::String(event));
    serde_json::Value::Object(map)
}

pub struct HttpExecutor {
    url: String,
    client: Client,
    timeout: Duration,
    headers: HashMap<String, String>,
}

impl HttpExecutor {
    pub fn new(url: String, timeout_secs: Option<u64>) -> Self {
        Self {
            url,
            client: Client::new(),
            timeout: Duration::from_secs(timeout_secs.unwrap_or(10)),
            headers: HashMap::new(),
        }
    }

    pub fn with_client(mut self, client: Client) -> Self {
        self.client = client;
        self
    }

    pub fn with_headers(mut self, headers: HashMap<String, String>) -> Self {
        self.headers = headers;
        self
    }

    /// Interpolate environment variables in header values.
    /// Replaces `$VAR_NAME` with the env var value (empty string if missing).
    /// Scans forward from after each substitution to avoid infinite loops when
    /// a substituted value itself contains `$`.
    fn interpolate(value: &str) -> String {
        let mut result = value.to_string();
        let mut cursor = 0;
        while let Some(rel) = result[cursor..].find('$') {
            let pos = cursor + rel;
            let rest = &result[pos + 1..];
            let end = rest
                .find(|c: char| !c.is_alphanumeric() && c != '_')
                .unwrap_or(rest.len());
            if end == 0 {
                // Bare `$` with no valid var name — skip past it
                cursor = pos + 1;
                continue;
            }
            let var = &rest[..end];
            let val = std::env::var(var).unwrap_or_default();
            result = format!("{}{}{}", &result[..pos], val, &rest[end..]);
            // Advance past the substituted value to avoid rescanning it
            cursor = pos + val.len();
        }
        result
    }
}

#[async_trait]
impl HookExecutor for HttpExecutor {
    async fn execute(&self, input: &HookInput) -> HookOutput {
        debug!("Executing HTTP hook: POST {}", self.url);

        // Send payload fields flattened at top level, plus an `event` discriminator.
        // This matches the shape daemon endpoints expect (e.g. {harness, userMessage, …})
        // while still letting user hooks identify the event type.
        // Sending the full HookInput envelope would break built-in daemon endpoints that
        // parse `body.harness` / `body.userMessage` at the root.
        let body = flatten_payload(input);
        let mut req = self
            .client
            .post(&self.url)
            .json(&body)
            .timeout(self.timeout);

        for (key, value) in &self.headers {
            let interpolated = Self::interpolate(value);
            req = req.header(key, interpolated);
        }

        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                if e.is_timeout() {
                    warn!("HTTP hook timed out: {}", self.url);
                    return HookOutput::error(format!(
                        "HTTP hook timed out after {}s",
                        self.timeout.as_secs()
                    ));
                }
                warn!("HTTP hook connection error: {e}");
                return HookOutput::error(format!("HTTP hook failed: {e}"));
            }
        };

        let status = resp.status();
        let body = match resp.text().await {
            Ok(b) => b,
            Err(e) => {
                warn!("HTTP hook failed to read response body: {e}");
                return HookOutput::error(format!("Failed to read response: {e}"));
            }
        };

        debug!("HTTP hook response: status={}, body_len={}", status, body.len());

        // Parse body as HookOutput regardless of status code
        match serde_json::from_str::<HookOutput>(&body) {
            Ok(output) => output,
            Err(_) => {
                // If not valid HookOutput JSON, try to extract inject/data from raw response
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                    let inject = val
                        .get("inject")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    HookOutput {
                        decision: forge_core::hook::HookDecision::Allow,
                        reason: None,
                        inject,
                        data: val,
                    }
                } else if !body.trim().is_empty() {
                    HookOutput::allow().with_inject(body.trim().to_string())
                } else {
                    HookOutput::allow()
                }
            }
        }
    }
}
