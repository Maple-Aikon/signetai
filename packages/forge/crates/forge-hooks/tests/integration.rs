use forge_core::hook::{
    HookConfig, HookDecision, HookEntry, HookEvent, HookInput, HookType, Matcher,
};
use forge_core::ToolResult;
use forge_hooks::HookRegistry;
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn fixture(name: &str) -> String {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("tests/fixtures");
    path.push(name);
    path.to_string_lossy().to_string()
}

/// Start a mock HTTP server that returns a HookOutput JSON.
async fn mock_hook_server(response: &str) -> (String, tokio::sync::oneshot::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let body = response.to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();

    tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = vec![0u8; 65536];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let req_body = req.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
            let _ = tx.send(req_body);

            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
        }
    });

    (format!("http://127.0.0.1:{}", addr.port()), rx)
}

mod command_hook_blocks_dangerous_tools {
    use super::*;

    #[tokio::test]
    async fn blocks_bash_calls_containing_rm_rf() {
        let mut registry = HookRegistry::new();

        // Register a command hook that blocks rm -rf via shell logic
        let script = r#"
            input=$(cat)
            if echo "$input" | grep -q 'rm -rf'; then
                echo 'Blocked rm -rf' >&2
                exit 2
            fi
            exit 0
        "#;

        let config = HookConfig {
            events: {
                let mut m = HashMap::new();
                m.insert(
                    HookEvent::PreToolUse,
                    vec![HookEntry {
                        hook_type: HookType::Command,
                        command: Some(script.to_string()),
                        url: None,
                        prompt: None,
                        matcher: Matcher::Pattern("Bash".into()),
                        timeout: Some(5),
                        fire_and_forget: false,
                    }],
                );
                m
            },
        };
        registry.register_from_config(&config);

        // Dispatch with rm -rf in tool input
        let input = HookInput::pre_tool_use(
            "Bash",
            &serde_json::json!({"command": "rm -rf /"}),
            "tool-danger",
        );
        let result = registry.dispatch(HookEvent::PreToolUse, input).await;

        assert_eq!(
            result.decision,
            HookDecision::Block,
            "Hook should block rm -rf command"
        );

        // Safe command should pass
        let input = HookInput::pre_tool_use(
            "Bash",
            &serde_json::json!({"command": "ls -la"}),
            "tool-safe",
        );
        let result = registry.dispatch(HookEvent::PreToolUse, input).await;

        assert_eq!(
            result.decision,
            HookDecision::Allow,
            "Safe command should be allowed"
        );
    }

    #[tokio::test]
    async fn non_matching_tool_name_skips_hook() {
        let mut registry = HookRegistry::new();

        let config = HookConfig {
            events: {
                let mut m = HashMap::new();
                m.insert(
                    HookEvent::PreToolUse,
                    vec![HookEntry {
                        hook_type: HookType::Command,
                        command: Some(fixture("block-hook.sh")),
                        url: None,
                        prompt: None,
                        matcher: Matcher::Pattern("Bash".into()),
                        timeout: None,
                        fire_and_forget: false,
                    }],
                );
                m
            },
        };
        registry.register_from_config(&config);

        // Write tool should not trigger Bash-only hook
        let input = HookInput::pre_tool_use(
            "Write",
            &serde_json::json!({"path": "/tmp/test"}),
            "tool-write",
        );
        let result = registry.dispatch(HookEvent::PreToolUse, input).await;

        assert_eq!(result.decision, HookDecision::Allow);
        assert!(result.outputs.is_empty());
    }
}

mod async_post_tool_use {
    use super::*;

    #[tokio::test]
    async fn async_hook_writes_to_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("hook-executed");
        let marker_path = marker.to_string_lossy().to_string();

        let mut registry = HookRegistry::new();
        let config = HookConfig {
            events: {
                let mut m = HashMap::new();
                m.insert(
                    HookEvent::PostToolUse,
                    vec![HookEntry {
                        hook_type: HookType::Command,
                        command: Some(format!("touch {marker_path}")),
                        url: None,
                        prompt: None,
                        matcher: Matcher::All,
                        timeout: None,
                        fire_and_forget: true,
                    }],
                );
                m
            },
        };
        registry.register_from_config(&config);

        let input = HookInput::post_tool_use("Bash", &serde_json::json!({}), &ToolResult::success("t1", "ok"));
        let result = registry.dispatch(HookEvent::PostToolUse, input).await;

        // Async mode returns immediately with Allow
        assert_eq!(result.decision, HookDecision::Allow);

        // Wait briefly for the background process to complete
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        assert!(
            marker.exists(),
            "Async hook should have created marker file at {}",
            marker_path
        );
    }
}

mod http_hook_round_trip {
    use super::*;

    #[tokio::test]
    async fn http_hook_receives_request_and_returns_output() {
        let resp = r#"{"decision":"allow","inject":"memory: user prefers vim","data":{"count":3}}"#;
        let (url, rx) = mock_hook_server(resp).await;

        let mut registry = HookRegistry::new();
        let config = HookConfig {
            events: {
                let mut m = HashMap::new();
                m.insert(
                    HookEvent::UserPromptSubmit,
                    vec![HookEntry {
                        hook_type: HookType::Http,
                        command: None,
                        url: Some(url),
                        prompt: None,
                        matcher: Matcher::All,
                        timeout: Some(5),
                        fire_and_forget: false,
                    }],
                );
                m
            },
        };
        registry.register_from_config(&config);

        let input = HookInput::prompt_submit("sess-1", "open my config");
        let result = registry
            .dispatch(HookEvent::UserPromptSubmit, input)
            .await;

        assert_eq!(result.decision, HookDecision::Allow);
        assert_eq!(
            result.inject.as_deref(),
            Some("memory: user prefers vim")
        );

        // Verify the mock server received the request
        let req_body = rx.await.expect("Mock server should have received request");
        assert!(
            req_body.contains("UserPromptSubmit"),
            "Request should contain event name"
        );
        assert!(
            req_body.contains("open my config"),
            "Request should contain user message"
        );
    }
}

mod mixed_hook_types {
    use super::*;

    #[tokio::test]
    async fn command_and_http_on_same_event_both_execute() {
        let resp = r#"{"decision":"allow","inject":"from http"}"#;
        let (url, _rx) = mock_hook_server(resp).await;

        let mut registry = HookRegistry::new();
        let config = HookConfig {
            events: {
                let mut m = HashMap::new();
                m.insert(
                    HookEvent::PreToolUse,
                    vec![
                        HookEntry {
                            hook_type: HookType::Command,
                            command: Some(
                                r#"echo '{"decision":"allow","inject":"from cmd"}'"#.to_string(),
                            ),
                            url: None,
                            prompt: None,
                            matcher: Matcher::All,
                            timeout: None,
                            fire_and_forget: false,
                        },
                        HookEntry {
                            hook_type: HookType::Http,
                            command: None,
                            url: Some(url),
                            prompt: None,
                            matcher: Matcher::All,
                            timeout: Some(5),
                            fire_and_forget: false,
                        },
                    ],
                );
                m
            },
        };
        registry.register_from_config(&config);

        let input = HookInput::pre_tool_use("Bash", &serde_json::json!({}), "t1");
        let result = registry.dispatch(HookEvent::PreToolUse, input).await;

        assert_eq!(
            result.outputs.len(),
            2,
            "Both command and HTTP hook should execute"
        );
        assert_eq!(result.decision, HookDecision::Allow);

        // Combined inject should contain text from both hooks
        let inject = result.inject.expect("Should have combined inject text");
        assert!(inject.contains("from cmd"), "Should contain command inject");
        assert!(inject.contains("from http"), "Should contain HTTP inject");
    }
}

mod builtin_daemon_hooks {
    use super::*;

    #[tokio::test]
    async fn builtin_http_hook_with_mock_produces_inject() {
        let resp = r#"{"decision":"allow","inject":"relevant memories injected","data":{"count":2}}"#;
        let (url, _rx) = mock_hook_server(resp).await;

        let mut registry = HookRegistry::new();
        registry.register_builtin_http(HookEvent::UserPromptSubmit, &url, HashMap::new());

        let input = HookInput::prompt_submit("sess-1", "what do I prefer?");
        let result = registry
            .dispatch(HookEvent::UserPromptSubmit, input)
            .await;

        assert_eq!(result.decision, HookDecision::Allow);
        assert_eq!(
            result.inject.as_deref(),
            Some("relevant memories injected")
        );
        assert_eq!(result.data["count"], 2);
    }
}

mod hook_input_constructors {
    use super::*;

    #[test]
    fn session_start_has_session_id() {
        let input = HookInput::session_start("sess-abc", Some("/home"));
        assert_eq!(input.event, HookEvent::SessionStart);
        assert_eq!(input.payload["sessionKey"], "sess-abc");
        assert_eq!(input.payload["cwd"], "/home");
    }

    #[test]
    fn session_end_has_transcript() {
        let input = HookInput::session_end("sess-abc", "conversation text");
        assert_eq!(input.event, HookEvent::SessionEnd);
        assert_eq!(input.payload["transcript"], "conversation text");
    }

    #[test]
    fn pre_tool_use_has_tool_info() {
        let input = HookInput::pre_tool_use("Bash", &serde_json::json!({"cmd": "ls"}), "t1");
        assert_eq!(input.event, HookEvent::PreToolUse);
        assert_eq!(input.tool_name.as_deref(), Some("Bash"));
        assert_eq!(input.payload["toolName"], "Bash");
        assert_eq!(input.payload["toolUseId"], "t1");
    }

    #[test]
    fn post_tool_use_has_output() {
        let result = ToolResult::success("t1", "success");
        let input = HookInput::post_tool_use("Write", &serde_json::json!({}), &result);
        assert_eq!(input.event, HookEvent::PostToolUse);
        assert_eq!(input.tool_name.as_deref(), Some("Write"));
        assert_eq!(input.payload["toolOutput"], "success");
        assert_eq!(input.payload["isError"], false);
    }

    #[test]
    fn post_compact_has_summary() {
        let input = HookInput::post_compact("summary text", 42);
        assert_eq!(input.event, HookEvent::PostCompact);
        assert_eq!(input.payload["summary"], "summary text");
        assert_eq!(input.payload["messageCount"], 42);
    }

    #[test]
    fn stop_has_session_id() {
        let input = HookInput::stop("sess-xyz");
        assert_eq!(input.event, HookEvent::Stop);
        assert_eq!(input.payload["sessionId"], "sess-xyz");
    }

    #[test]
    fn prompt_submit_has_message() {
        let input = HookInput::prompt_submit("s1", "hello world");
        assert_eq!(input.event, HookEvent::UserPromptSubmit);
        assert_eq!(input.payload["userMessage"], "hello world");
    }

    #[test]
    fn match_target_returns_tool_name() {
        let input = HookInput::pre_tool_use("Bash", &serde_json::json!({}), "t1");
        assert_eq!(input.match_target(), Some("Bash"));

        let input = HookInput::stop("s1");
        assert_eq!(input.match_target(), None);
    }
}

mod tier2_input_constructors {
    use super::*;

    #[test]
    fn post_tool_use_failure_has_error_info() {
        let input = HookInput::post_tool_use_failure(
            "Bash",
            &serde_json::json!({"command": "bad-cmd"}),
            "command not found",
            "t-fail-1",
        );
        assert_eq!(input.event, HookEvent::PostToolUseFailure);
        assert_eq!(input.tool_name.as_deref(), Some("Bash"));
        assert_eq!(input.payload["toolName"], "Bash");
        assert_eq!(input.payload["error"], "command not found");
        assert_eq!(input.payload["toolUseId"], "t-fail-1");
        assert_eq!(input.payload["toolInput"]["command"], "bad-cmd");
    }

    #[test]
    fn permission_request_has_level() {
        let input = HookInput::permission_request(
            "Write",
            &serde_json::json!({"path": "/etc/passwd"}),
            "Write",
        );
        assert_eq!(input.event, HookEvent::PermissionRequest);
        assert_eq!(input.tool_name.as_deref(), Some("Write"));
        assert_eq!(input.payload["toolName"], "Write");
        assert_eq!(input.payload["permissionLevel"], "Write");
        assert_eq!(input.payload["toolInput"]["path"], "/etc/passwd");
    }

    #[test]
    fn permission_denied_has_tool_info() {
        let input = HookInput::permission_denied(
            "Bash",
            &serde_json::json!({"command": "rm -rf /"}),
        );
        assert_eq!(input.event, HookEvent::PermissionDenied);
        assert_eq!(input.tool_name.as_deref(), Some("Bash"));
        assert_eq!(input.payload["toolName"], "Bash");
        assert_eq!(input.payload["toolInput"]["command"], "rm -rf /");
    }

    #[test]
    fn notification_has_message_and_level() {
        let input = HookInput::notification("Loop detected", "error");
        assert_eq!(input.event, HookEvent::Notification);
        assert!(input.tool_name.is_none());
        assert_eq!(input.payload["message"], "Loop detected");
        assert_eq!(input.payload["level"], "error");
    }

    #[test]
    fn notification_match_target_is_none() {
        let input = HookInput::notification("test", "info");
        assert_eq!(input.match_target(), None);
    }

    #[test]
    fn permission_request_match_target_is_tool_name() {
        let input = HookInput::permission_request("Bash", &serde_json::json!({}), "Read");
        assert_eq!(input.match_target(), Some("Bash"));
    }
}
