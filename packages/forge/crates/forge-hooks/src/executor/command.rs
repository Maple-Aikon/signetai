use async_trait::async_trait;
use forge_core::hook::{HookInput, HookOutput};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tracing::{debug, warn};

use super::HookExecutor;

/// Executes hooks as shell subprocesses via `sh -c`.
///
/// - Pipes HookInput as JSON to stdin
/// - Exit 0 = Allow (stdout parsed as JSON HookOutput, fallback to plain text)
/// - Exit 2 = Block (stderr as reason)
/// - Other = Error (non-blocking)
/// - Supports fire-and-forget mode (spawn and don't wait)
pub struct CommandExecutor {
    command: String,
    timeout: Duration,
    fire_and_forget: bool,
}

impl CommandExecutor {
    pub fn new(command: String, timeout_secs: Option<u64>, fire_and_forget: bool) -> Self {
        Self {
            command,
            timeout: Duration::from_secs(timeout_secs.unwrap_or(10)),
            fire_and_forget,
        }
    }
}

#[async_trait]
impl HookExecutor for CommandExecutor {
    async fn execute(&self, input: &HookInput) -> HookOutput {
        let json = match serde_json::to_string(input) {
            Ok(j) => j,
            Err(e) => {
                return HookOutput::error(format!("Failed to serialize hook input: {e}"));
            }
        };

        debug!("Executing command hook: {}", self.command);

        let mut child = match Command::new("sh")
            .arg("-c")
            .arg(&self.command)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                return HookOutput::error(format!("Failed to spawn command: {e}"));
            }
        };

        // Write input to stdin
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(json.as_bytes()).await;
            drop(stdin);
        }

        // Fire-and-forget: don't wait for exit
        if self.fire_and_forget {
            debug!("Command hook fired (async): {}", self.command);
            return HookOutput::allow();
        }

        // Take stdout/stderr handles — child stays outside the async block so
        // we can call child.kill() if the timeout fires.
        let stdout_handle = child.stdout.take();
        let stderr_handle = child.stderr.take();

        let read_streams = async move {
            let stdout = match stdout_handle {
                Some(mut out) => {
                    let mut buf = Vec::new();
                    AsyncReadExt::read_to_end(&mut out, &mut buf).await?;
                    buf
                }
                None => Vec::new(),
            };
            let stderr = match stderr_handle {
                Some(mut err) => {
                    let mut buf = Vec::new();
                    AsyncReadExt::read_to_end(&mut err, &mut buf).await?;
                    buf
                }
                None => Vec::new(),
            };
            Ok::<_, std::io::Error>((stdout, stderr))
        };

        match tokio::time::timeout(self.timeout, read_streams).await {
            Err(_) => {
                // Kill and wait to fully reap the child — kill() sends SIGKILL
                // but wait() is required to remove the zombie entry.
                let _ = child.kill().await;
                let _ = child.wait().await;
                warn!(
                    "Command hook timed out after {:?}: {}",
                    self.timeout, self.command
                );
                HookOutput::error(format!(
                    "Hook timed out after {}s",
                    self.timeout.as_secs()
                ))
            }
            Ok(Err(e)) => HookOutput::error(format!("Command execution failed: {e}")),
            Ok(Ok((stdout, stderr))) => {
                let status = match child.wait().await {
                    Ok(s) => s,
                    Err(e) => return HookOutput::error(format!("Failed to wait for command: {e}")),
                };
                let code = status.code().unwrap_or(-1);
                let stdout = String::from_utf8_lossy(&stdout).to_string();
                let stderr = String::from_utf8_lossy(&stderr).to_string();

                match code {
                    0 => parse_stdout(&stdout),
                    2 => {
                        let reason = if stderr.is_empty() {
                            "Blocked by hook".to_string()
                        } else {
                            stderr.trim().to_string()
                        };
                        HookOutput::block(reason)
                    }
                    _ => {
                        let msg = if stderr.is_empty() {
                            format!("Hook exited with code {code}")
                        } else {
                            format!("Hook exited with code {code}: {}", stderr.trim())
                        };
                        HookOutput::error(msg)
                    }
                }
            }
        }
    }
}

/// Parse stdout as JSON HookOutput, falling back to raw JSON or plain text.
fn parse_stdout(stdout: &str) -> HookOutput {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return HookOutput::allow();
    }

    // Try parsing as full HookOutput JSON (must have explicit "decision" field)
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if val.get("decision").is_some() {
            if let Ok(output) = serde_json::from_value::<HookOutput>(val.clone()) {
                return output;
            }
        }
        // Valid JSON but not HookOutput: store as data and inject as text
        return HookOutput::allow()
            .with_data(val)
            .with_inject(trimmed.to_string());
    }

    // Not JSON: treat as plain text injection
    HookOutput::allow().with_inject(trimmed.to_string())
}
