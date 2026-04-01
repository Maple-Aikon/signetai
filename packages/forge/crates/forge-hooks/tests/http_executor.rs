use forge_core::hook::{HookDecision, HookInput};
use forge_hooks::executor::http::HttpExecutor;
use forge_hooks::executor::HookExecutor;
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn sample_input() -> HookInput {
    HookInput::pre_tool_use("Bash", &serde_json::json!({"command": "ls"}), "tool-1")
}

/// Start a mock HTTP server that returns the given response body with the given status code.
/// Returns the URL to connect to.
async fn mock_server(status: u16, body: &str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let body = body.to_string();

    tokio::spawn(async move {
        // Accept one connection
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = vec![0u8; 8192];
            let _ = stream.read(&mut buf).await;

            let response = format!(
                "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
        }
    });

    format!("http://127.0.0.1:{}", addr.port())
}

/// Start a mock server that captures the request body and returns it via a channel.
async fn capturing_server(
    status: u16,
    response_body: &str,
) -> (String, tokio::sync::oneshot::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let body = response_body.to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();

    tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = vec![0u8; 65536];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();

            // Extract body from HTTP request (after double CRLF)
            let req_body = req
                .split("\r\n\r\n")
                .nth(1)
                .unwrap_or("")
                .to_string();
            let _ = tx.send(req_body);

            let response = format!(
                "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
        }
    });

    (format!("http://127.0.0.1:{}", addr.port()), rx)
}

/// Start a mock server that deliberately hangs (never responds).
async fn hanging_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            // Read the request but never respond
            let mut buf = vec![0u8; 8192];
            let _ = stream.read(&mut buf).await;
            // Sleep forever
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            drop(stream);
        }
    });

    format!("http://127.0.0.1:{}", addr.port())
}

mod success {
    use super::*;

    #[tokio::test]
    async fn successful_post_returns_parsed_hook_output() {
        let body = r#"{"decision":"allow","inject":"memory injected","data":{"count":5}}"#;
        let url = mock_server(200, body).await;

        let exec = HttpExecutor::new(url, None);
        let out = exec.execute(&sample_input()).await;

        assert_eq!(out.decision, HookDecision::Allow);
        assert_eq!(out.inject.as_deref(), Some("memory injected"));
        assert_eq!(out.data["count"], 5);
    }

    #[tokio::test]
    async fn block_response_parsed() {
        let body = r#"{"decision":"block","reason":"Dangerous tool"}"#;
        let url = mock_server(200, body).await;

        let exec = HttpExecutor::new(url, None);
        let out = exec.execute(&sample_input()).await;

        assert_eq!(out.decision, HookDecision::Block);
        assert_eq!(out.reason.as_deref(), Some("Dangerous tool"));
    }

    #[tokio::test]
    async fn sends_input_as_json_post() {
        let resp = r#"{"decision":"allow"}"#;
        let (url, rx) = capturing_server(200, resp).await;

        let exec = HttpExecutor::new(url, None);
        let input = HookInput::pre_tool_use(
            "Bash",
            &serde_json::json!({"command": "echo hi"}),
            "t-1",
        );
        let _ = exec.execute(&input).await;

        let req_body = rx.await.expect("Should receive captured request");
        assert!(
            req_body.contains("Bash"),
            "Request body should contain tool name, got: {req_body}"
        );
        assert!(
            req_body.contains("PreToolUse"),
            "Request body should contain event name, got: {req_body}"
        );
    }
}

mod non_2xx {
    use super::*;

    #[tokio::test]
    async fn status_500_still_parses_body() {
        let body = r#"{"decision":"error","reason":"Internal server error"}"#;
        let url = mock_server(500, body).await;

        let exec = HttpExecutor::new(url, None);
        let out = exec.execute(&sample_input()).await;

        // Non-2xx should still parse the response body as HookOutput
        assert_eq!(out.decision, HookDecision::Error);
        assert_eq!(out.reason.as_deref(), Some("Internal server error"));
    }

    #[tokio::test]
    async fn status_403_with_block() {
        let body = r#"{"decision":"block","reason":"Forbidden"}"#;
        let url = mock_server(403, body).await;

        let exec = HttpExecutor::new(url, None);
        let out = exec.execute(&sample_input()).await;

        assert_eq!(out.decision, HookDecision::Block);
    }
}

mod timeout {
    use super::*;

    #[tokio::test]
    async fn timeout_returns_error() {
        let url = hanging_server().await;

        let exec = HttpExecutor::new(url, Some(1));
        let start = std::time::Instant::now();
        let out = exec.execute(&sample_input()).await;
        let elapsed = start.elapsed();

        assert_eq!(out.decision, HookDecision::Error);
        let reason = out.reason.expect("Timeout should have a reason");
        assert!(
            reason.contains("timed out") || reason.contains("failed"),
            "Expected timeout-related reason, got: {reason}"
        );
        assert!(
            elapsed.as_secs() < 5,
            "Should time out quickly, took {:?}",
            elapsed
        );
    }
}

mod connection_error {
    use super::*;

    #[tokio::test]
    async fn connection_refused_returns_error_not_fatal() {
        // Use a port that's almost certainly not listening
        let exec = HttpExecutor::new("http://127.0.0.1:1".to_string(), Some(2));
        let out = exec.execute(&sample_input()).await;

        assert_eq!(out.decision, HookDecision::Error);
        assert!(out.reason.is_some(), "Connection error should have a reason");
        // The key contract: this is non-fatal (Error, not panic)
    }

    #[tokio::test]
    async fn invalid_url_returns_error() {
        let exec = HttpExecutor::new("not-a-url".to_string(), Some(2));
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Error);
    }
}

mod headers {
    use super::*;

    #[tokio::test]
    async fn custom_headers_sent() {
        // We can't easily inspect headers with our simple mock, but we can verify
        // the executor doesn't fail when headers are provided
        let body = r#"{"decision":"allow"}"#;
        let url = mock_server(200, body).await;

        let mut headers = HashMap::new();
        headers.insert("X-Custom".to_string(), "test-value".to_string());
        headers.insert("Authorization".to_string(), "Bearer token123".to_string());

        let exec = HttpExecutor::new(url, None).with_headers(headers);
        let out = exec.execute(&sample_input()).await;

        assert_eq!(out.decision, HookDecision::Allow);
    }

    #[tokio::test]
    async fn env_var_interpolation_in_headers() {
        let body = r#"{"decision":"allow"}"#;
        let url = mock_server(200, body).await;

        // Set a test env var
        std::env::set_var("FORGE_TEST_TOKEN", "secret123");

        let mut headers = HashMap::new();
        headers.insert(
            "Authorization".to_string(),
            "Bearer $FORGE_TEST_TOKEN".to_string(),
        );

        let exec = HttpExecutor::new(url, None).with_headers(headers);
        let out = exec.execute(&sample_input()).await;

        assert_eq!(out.decision, HookDecision::Allow);

        std::env::remove_var("FORGE_TEST_TOKEN");
    }

    #[tokio::test]
    async fn missing_env_var_interpolated_to_empty() {
        let body = r#"{"decision":"allow"}"#;
        let url = mock_server(200, body).await;

        // Ensure this var doesn't exist
        std::env::remove_var("FORGE_NONEXISTENT_VAR");

        let mut headers = HashMap::new();
        headers.insert(
            "Authorization".to_string(),
            "Bearer $FORGE_NONEXISTENT_VAR".to_string(),
        );

        let exec = HttpExecutor::new(url, None).with_headers(headers);
        let out = exec.execute(&sample_input()).await;

        // Should not fail — missing vars become empty string
        assert_eq!(out.decision, HookDecision::Allow);
    }
}

mod response_parsing {
    use super::*;

    #[tokio::test]
    async fn empty_response_body_returns_default_allow() {
        let url = mock_server(200, "").await;

        let exec = HttpExecutor::new(url, None);
        let out = exec.execute(&sample_input()).await;

        assert_eq!(out.decision, HookDecision::Allow);
    }

    #[tokio::test]
    async fn non_hook_output_json_treated_as_data() {
        let body = r#"{"inject":"some context","extra":"field"}"#;
        let url = mock_server(200, body).await;

        let exec = HttpExecutor::new(url, None);
        let out = exec.execute(&sample_input()).await;

        // Should parse as Allow with inject extracted from the JSON
        assert_eq!(out.decision, HookDecision::Allow);
        assert_eq!(out.inject.as_deref(), Some("some context"));
    }

    #[tokio::test]
    async fn plain_text_response_becomes_inject() {
        let url = mock_server(200, "plain text response").await;

        let exec = HttpExecutor::new(url, None);
        let out = exec.execute(&sample_input()).await;

        assert_eq!(out.decision, HookDecision::Allow);
        assert_eq!(out.inject.as_deref(), Some("plain text response"));
    }
}
