use forge_core::hook::{HookDecision, HookInput};
use forge_hooks::executor::daemon::DaemonExecutor;
use forge_hooks::executor::HookExecutor;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn sample_input() -> HookInput {
    HookInput::pre_tool_use("Bash", &serde_json::json!({"command": "ls -la"}), "tool-1")
}

/// Start a mock server returning the given body. Also captures the request
/// and returns it via a oneshot channel so tests can inspect the POST.
async fn mock_daemon(body: &str) -> (String, tokio::sync::oneshot::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let body = body.to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();

    tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = vec![0u8; 65536];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            let raw = String::from_utf8_lossy(&buf[..n]).to_string();

            // Capture the full HTTP request (including path) for endpoint checks
            let _ = tx.send(raw);

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

/// Mock server that never responds (for timeout tests).
async fn hanging_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = vec![0u8; 8192];
            let _ = stream.read(&mut buf).await;
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            drop(stream);
        }
    });

    format!("http://127.0.0.1:{}", addr.port())
}

mod ok_field {
    use super::*;

    #[tokio::test]
    async fn ok_true_returns_allow() {
        let (url, _rx) = mock_daemon(r#"{"ok": true}"#).await;
        let exec = DaemonExecutor::new(url, None, Some(5), false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Allow);
    }

    #[tokio::test]
    async fn ok_false_returns_block() {
        let (url, _rx) = mock_daemon(r#"{"ok": false}"#).await;
        let exec = DaemonExecutor::new(url, None, Some(5), false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Block);
    }

    #[tokio::test]
    async fn ok_false_with_reason() {
        let (url, _rx) =
            mock_daemon(r#"{"ok": false, "reason": "Dangerous command detected"}"#).await;
        let exec = DaemonExecutor::new(url, None, Some(5), false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Block);
        assert_eq!(out.reason.as_deref(), Some("Dangerous command detected"));
    }

    #[tokio::test]
    async fn ok_false_default_reason() {
        let (url, _rx) = mock_daemon(r#"{"ok": false}"#).await;
        let exec = DaemonExecutor::new(url, None, Some(5), false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Block);
        assert_eq!(
            out.reason.as_deref(),
            Some("Denied by daemon evaluation")
        );
    }

    #[tokio::test]
    async fn ok_true_with_inject() {
        let (url, _rx) =
            mock_daemon(r#"{"ok": true, "inject": "relevant context here"}"#).await;
        let exec = DaemonExecutor::new(url, None, Some(5), false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Allow);
        assert_eq!(out.inject.as_deref(), Some("relevant context here"));
    }
}

mod interpolation {
    use super::*;

    #[tokio::test]
    async fn tool_name_interpolated() {
        let (url, rx) = mock_daemon(r#"{"ok": true}"#).await;
        let exec = DaemonExecutor::new(
            url,
            Some("Tool is {{tool_name}}".to_string()),
            Some(5),
            false,
        );
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Allow);

        let req = rx.await.unwrap();
        assert!(
            req.contains("Tool is Bash"),
            "Expected interpolated tool_name, got: {req}"
        );
    }

    #[tokio::test]
    async fn tool_input_interpolated() {
        let (url, rx) = mock_daemon(r#"{"ok": true}"#).await;
        let exec = DaemonExecutor::new(
            url,
            Some("Input: {{tool_input}}".to_string()),
            Some(5),
            false,
        );
        let input = HookInput::pre_tool_use(
            "Bash",
            &serde_json::json!({"command": "rm -rf /"}),
            "t-1",
        );
        let _ = exec.execute(&input).await;

        let req = rx.await.unwrap();
        // toolInput from the payload should be interpolated
        assert!(
            req.contains("rm -rf"),
            "Expected interpolated tool_input, got: {req}"
        );
    }

    #[tokio::test]
    async fn event_interpolated() {
        let (url, rx) = mock_daemon(r#"{"ok": true}"#).await;
        let exec = DaemonExecutor::new(
            url,
            Some("Event: {{event}}".to_string()),
            Some(5),
            false,
        );
        let _ = exec.execute(&sample_input()).await;

        let req = rx.await.unwrap();
        assert!(
            req.contains("Event: PreToolUse"),
            "Expected interpolated event, got: {req}"
        );
    }

    #[tokio::test]
    async fn payload_interpolated() {
        let (url, rx) = mock_daemon(r#"{"ok": true}"#).await;
        let exec = DaemonExecutor::new(
            url,
            Some("Payload: {{payload}}".to_string()),
            Some(5),
            false,
        );
        let _ = exec.execute(&sample_input()).await;

        let req = rx.await.unwrap();
        assert!(
            req.contains("toolName"),
            "Expected payload JSON in request, got: {req}"
        );
    }

    #[tokio::test]
    async fn no_template_sends_raw_input() {
        let (url, rx) = mock_daemon(r#"{"ok": true}"#).await;
        let exec = DaemonExecutor::new(url, None, Some(5), false);
        let _ = exec.execute(&sample_input()).await;

        let req = rx.await.unwrap();
        // Without a template, the prompt field is the serialized HookInput
        assert!(
            req.contains("PreToolUse"),
            "Expected raw input with event, got: {req}"
        );
        assert!(
            req.contains("Bash"),
            "Expected raw input with tool_name, got: {req}"
        );
    }
}

mod endpoint {
    use super::*;

    #[tokio::test]
    async fn prompt_uses_prompt_eval_endpoint() {
        let (url, rx) = mock_daemon(r#"{"ok": true}"#).await;
        let exec = DaemonExecutor::new(url, None, Some(5), false);
        let _ = exec.execute(&sample_input()).await;

        let req = rx.await.unwrap();
        assert!(
            req.contains("/api/hooks/prompt-eval"),
            "Expected prompt-eval path, got first line: {}",
            req.lines().next().unwrap_or("")
        );
    }

    #[tokio::test]
    async fn agent_uses_agent_eval_endpoint() {
        let (url, rx) = mock_daemon(r#"{"ok": true}"#).await;
        let exec = DaemonExecutor::new(url, None, Some(5), true);
        let _ = exec.execute(&sample_input()).await;

        let req = rx.await.unwrap();
        assert!(
            req.contains("/api/hooks/agent-eval"),
            "Expected agent-eval path, got first line: {}",
            req.lines().next().unwrap_or("")
        );
    }
}

mod errors {
    use super::*;

    #[tokio::test]
    async fn timeout_returns_error() {
        let url = hanging_server().await;
        let exec = DaemonExecutor::new(url, None, Some(1), false);
        let start = std::time::Instant::now();
        let out = exec.execute(&sample_input()).await;
        let elapsed = start.elapsed();

        assert_eq!(out.decision, HookDecision::Error);
        let reason = out.reason.expect("Timeout should have a reason");
        assert!(
            reason.contains("timed out") || reason.contains("failed"),
            "Expected timeout reason, got: {reason}"
        );
        assert!(
            elapsed.as_secs() < 5,
            "Should time out quickly, took {:?}",
            elapsed
        );
    }

    #[tokio::test]
    async fn connection_refused_returns_error() {
        let exec = DaemonExecutor::new(
            "http://127.0.0.1:1".to_string(),
            None,
            Some(2),
            false,
        );
        let out = exec.execute(&sample_input()).await;

        assert_eq!(out.decision, HookDecision::Error);
        assert!(
            out.reason.is_some(),
            "Connection error should have a reason"
        );
    }
}

mod response_parsing {
    use super::*;

    #[tokio::test]
    async fn empty_response_returns_allow() {
        let (url, _rx) = mock_daemon("").await;
        let exec = DaemonExecutor::new(url, None, Some(5), false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Allow);
        assert!(out.inject.is_none());
    }

    #[tokio::test]
    async fn plain_text_response_becomes_inject() {
        let (url, _rx) = mock_daemon("some plain text").await;
        let exec = DaemonExecutor::new(url, None, Some(5), false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Allow);
        assert_eq!(out.inject.as_deref(), Some("some plain text"));
    }

    #[tokio::test]
    async fn missing_ok_field_defaults_to_allow() {
        let (url, _rx) = mock_daemon(r#"{"inject": "context"}"#).await;
        let exec = DaemonExecutor::new(url, None, Some(5), false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Allow);
        assert_eq!(out.inject.as_deref(), Some("context"));
    }

    #[tokio::test]
    async fn data_preserved_in_output() {
        let (url, _rx) =
            mock_daemon(r#"{"ok": true, "inject": "ctx", "score": 0.95}"#).await;
        let exec = DaemonExecutor::new(url, None, Some(5), false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Allow);
        assert_eq!(out.data["score"], 0.95);
    }
}
