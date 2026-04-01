use forge_core::hook::{HookDecision, HookInput};
use forge_hooks::executor::command::CommandExecutor;
use forge_hooks::executor::HookExecutor;
use std::path::PathBuf;

fn fixture(name: &str) -> String {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("tests/fixtures");
    path.push(name);
    path.to_string_lossy().to_string()
}

fn sample_input() -> HookInput {
    HookInput::pre_tool_use("Bash", &serde_json::json!({"command": "ls"}), "tool-1")
}

mod exit_codes {
    use super::*;

    #[tokio::test]
    async fn exit_0_returns_allow() {
        let exec = CommandExecutor::new(fixture("allow-hook.sh"), None, false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Allow);
    }

    #[tokio::test]
    async fn exit_0_parses_json_stdout() {
        let exec = CommandExecutor::new(fixture("allow-hook.sh"), None, false);
        let out = exec.execute(&sample_input()).await;
        // allow-hook.sh outputs valid HookOutput JSON with decision "allow"
        assert_eq!(out.decision, HookDecision::Allow);
    }

    #[tokio::test]
    async fn exit_2_returns_block() {
        let exec = CommandExecutor::new(fixture("block-hook.sh"), None, false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Block);
    }

    #[tokio::test]
    async fn exit_2_captures_stderr_as_reason() {
        let exec = CommandExecutor::new(fixture("block-hook.sh"), None, false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Block);
        let reason = out.reason.expect("Block should have a reason");
        assert!(
            reason.contains("Blocked by test hook"),
            "Expected stderr reason, got: {reason}"
        );
    }

    #[tokio::test]
    async fn exit_1_returns_error() {
        let cmd = "exit 1".to_string();
        let exec = CommandExecutor::new(cmd, None, false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Error);
    }

    #[tokio::test]
    async fn exit_1_is_nonblocking() {
        // Error should not be Block — it's a non-blocking failure
        let cmd = "echo 'oops' >&2; exit 1".to_string();
        let exec = CommandExecutor::new(cmd, None, false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Error);
        assert_ne!(out.decision, HookDecision::Block);
    }

    #[tokio::test]
    async fn exit_137_returns_error() {
        let cmd = "exit 137".to_string();
        let exec = CommandExecutor::new(cmd, None, false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Error);
    }
}

mod timeout {
    use super::*;

    #[tokio::test]
    async fn timeout_kills_subprocess_returns_error() {
        let exec = CommandExecutor::new(fixture("slow-hook.sh"), Some(1), false);
        let start = std::time::Instant::now();
        let out = exec.execute(&sample_input()).await;
        let elapsed = start.elapsed();

        assert_eq!(out.decision, HookDecision::Error);
        let reason = out.reason.expect("Timeout should have a reason");
        assert!(
            reason.contains("timed out"),
            "Expected timeout reason, got: {reason}"
        );
        // Should complete in ~1s, not 30s
        assert!(
            elapsed.as_secs() < 5,
            "Timeout should have killed the process, took {:?}",
            elapsed
        );
    }
}

mod async_mode {
    use super::*;

    #[tokio::test]
    async fn fire_and_forget_returns_immediately() {
        // async-hook.sh sleeps 1s, but fire_and_forget should return instantly
        let exec = CommandExecutor::new(fixture("async-hook.sh"), None, true);
        let start = std::time::Instant::now();
        let out = exec.execute(&sample_input()).await;
        let elapsed = start.elapsed();

        assert_eq!(out.decision, HookDecision::Allow);
        assert!(
            elapsed.as_millis() < 500,
            "Async mode should return immediately, took {:?}",
            elapsed
        );
    }

    #[tokio::test]
    async fn fire_and_forget_slow_hook_does_not_block() {
        let exec = CommandExecutor::new(fixture("slow-hook.sh"), None, true);
        let start = std::time::Instant::now();
        let out = exec.execute(&sample_input()).await;
        let elapsed = start.elapsed();

        assert_eq!(out.decision, HookDecision::Allow);
        assert!(
            elapsed.as_secs() < 2,
            "Async slow hook should not block, took {:?}",
            elapsed
        );
    }
}

mod stdout_parsing {
    use super::*;

    #[tokio::test]
    async fn malformed_json_falls_back_to_plain_text_inject() {
        let cmd = r#"echo 'not valid json at all'"#.to_string();
        let exec = CommandExecutor::new(cmd, None, false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Allow);
        // Plain text should be injected
        let inject = out.inject.expect("Non-JSON stdout should become inject text");
        assert_eq!(inject, "not valid json at all");
    }

    #[tokio::test]
    async fn empty_stdout_returns_default_allow() {
        let cmd = "true".to_string(); // exit 0, no output
        let exec = CommandExecutor::new(cmd, None, false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Allow);
        assert!(out.inject.is_none(), "Empty stdout should not produce inject");
    }

    #[tokio::test]
    async fn valid_json_hook_output_parsed() {
        let cmd = r#"echo '{"decision":"allow","inject":"hello from hook","data":{"key":"val"}}'"#
            .to_string();
        let exec = CommandExecutor::new(cmd, None, false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Allow);
        assert_eq!(out.inject.as_deref(), Some("hello from hook"));
        assert_eq!(out.data["key"], "val");
    }

    #[tokio::test]
    async fn large_stdout_handled_without_panic() {
        // Generate ~1MB of output
        let cmd = "head -c 1048576 /dev/urandom | base64; exit 0".to_string();
        let exec = CommandExecutor::new(cmd, Some(10), false);
        let out = exec.execute(&sample_input()).await;
        // Should not panic — either parses or falls back
        assert_eq!(out.decision, HookDecision::Allow);
    }

    #[tokio::test]
    async fn large_stderr_handled_without_panic() {
        let cmd = "head -c 1048576 /dev/urandom | base64 >&2; exit 1".to_string();
        let exec = CommandExecutor::new(cmd, Some(10), false);
        let out = exec.execute(&sample_input()).await;
        assert_eq!(out.decision, HookDecision::Error);
    }
}

mod stdin_piping {
    use super::*;

    #[tokio::test]
    async fn hook_receives_correct_json_on_stdin() {
        // echo-hook.sh cats stdin back to stdout
        let exec = CommandExecutor::new(fixture("echo-hook.sh"), None, false);
        let input = HookInput::pre_tool_use(
            "Bash",
            &serde_json::json!({"command": "ls -la"}),
            "tool-42",
        );
        let out = exec.execute(&input).await;

        // The echoed input should be in inject (since it's valid JSON but not HookOutput format)
        // or parsed as data. Either way, we can verify the tool name appears.
        assert_eq!(out.decision, HookDecision::Allow);
        // The echo-hook returns the input JSON, which has an "event" field.
        // It won't parse as HookOutput (no "decision" field), so it falls back
        // to raw JSON in inject or data.
        let data_str = serde_json::to_string(&out.data).unwrap_or_default();
        let inject_str = out.inject.unwrap_or_default();
        let combined = format!("{data_str}{inject_str}");
        assert!(
            combined.contains("Bash") || combined.contains("tool-42"),
            "Hook should have received the input JSON containing tool info"
        );
    }

    #[tokio::test]
    async fn session_start_input_piped_correctly() {
        let exec = CommandExecutor::new(fixture("echo-hook.sh"), None, false);
        let input = HookInput::session_start("sess-123", Some("/home/user"));
        let out = exec.execute(&input).await;
        assert_eq!(out.decision, HookDecision::Allow);

        let data_str = serde_json::to_string(&out.data).unwrap_or_default();
        let inject_str = out.inject.unwrap_or_default();
        let combined = format!("{data_str}{inject_str}");
        assert!(
            combined.contains("sess-123"),
            "Session ID should be in piped input"
        );
    }
}
