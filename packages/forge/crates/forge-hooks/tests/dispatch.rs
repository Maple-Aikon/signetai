use forge_core::hook::{
    AggregatedResult, HookConfig, HookDecision, HookEntry, HookEvent, HookInput, HookOutput,
    HookType, Matcher,
};
use forge_hooks::HookRegistry;
use std::collections::HashMap;
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

fn make_entry(cmd: &str) -> HookEntry {
    HookEntry {
        hook_type: HookType::Command,
        command: Some(cmd.to_string()),
        url: None,
        prompt: None,
        matcher: Matcher::All,
        timeout: None,
        fire_and_forget: false,
    }
}

mod aggregation {
    use super::*;

    #[test]
    fn empty_outputs_returns_allow() {
        let result = AggregatedResult::aggregate(vec![]);
        assert_eq!(result.decision, HookDecision::Allow);
    }

    #[test]
    fn single_allow() {
        let result = AggregatedResult::aggregate(vec![HookOutput::allow()]);
        assert_eq!(result.decision, HookDecision::Allow);
    }

    #[test]
    fn single_block() {
        let result =
            AggregatedResult::aggregate(vec![HookOutput::block("reason")]);
        assert_eq!(result.decision, HookDecision::Block);
        assert_eq!(result.reason.as_deref(), Some("reason"));
    }

    #[test]
    fn any_block_results_in_block() {
        let result = AggregatedResult::aggregate(vec![
            HookOutput::allow(),
            HookOutput::allow(),
            HookOutput::block("blocked"),
        ]);
        assert_eq!(result.decision, HookDecision::Block);
    }

    #[test]
    fn all_error_no_allow_returns_error() {
        let result = AggregatedResult::aggregate(vec![
            HookOutput::error("err1"),
            HookOutput::error("err2"),
        ]);
        assert_eq!(result.decision, HookDecision::Error);
    }

    #[test]
    fn allow_plus_error_returns_allow() {
        let result = AggregatedResult::aggregate(vec![
            HookOutput::allow(),
            HookOutput::error("some error"),
        ]);
        assert_eq!(result.decision, HookDecision::Allow);
    }

    #[test]
    fn inject_text_concatenated() {
        let result = AggregatedResult::aggregate(vec![
            HookOutput::allow().with_inject("first"),
            HookOutput::allow().with_inject("second"),
        ]);
        let inject = result.inject.expect("Should have combined inject");
        assert!(inject.contains("first"));
        assert!(inject.contains("second"));
    }

    #[test]
    fn data_from_first_non_null_hook() {
        let result = AggregatedResult::aggregate(vec![
            HookOutput::allow(), // null data
            HookOutput::allow().with_data(serde_json::json!({"key": "val"})),
            HookOutput::allow().with_data(serde_json::json!({"other": "data"})),
        ]);
        assert_eq!(result.data["key"], "val");
    }
}

mod dispatch_execution {
    use super::*;

    #[tokio::test]
    async fn multiple_matching_hooks_all_execute() {
        let mut registry = HookRegistry::new();
        let config = HookConfig {
            events: {
                let mut m = HashMap::new();
                m.insert(
                    HookEvent::PreToolUse,
                    vec![
                        make_entry("echo hook1"),
                        make_entry("echo hook2"),
                        make_entry("echo hook3"),
                    ],
                );
                m
            },
        };
        registry.register_from_config(&config);

        let result = registry
            .dispatch(HookEvent::PreToolUse, sample_input())
            .await;

        assert_eq!(
            result.outputs.len(),
            3,
            "All three hooks should execute, got {}",
            result.outputs.len()
        );
    }

    #[tokio::test]
    async fn any_block_blocks_overall() {
        let mut registry = HookRegistry::new();
        let config = HookConfig {
            events: {
                let mut m = HashMap::new();
                m.insert(
                    HookEvent::PreToolUse,
                    vec![
                        make_entry("true"),                             // Allow
                        make_entry("true"),                             // Allow
                        make_entry(&fixture("block-hook.sh")),          // Block
                    ],
                );
                m
            },
        };
        registry.register_from_config(&config);

        let result = registry
            .dispatch(HookEvent::PreToolUse, sample_input())
            .await;

        assert_eq!(
            result.decision,
            HookDecision::Block,
            "Any Block should make overall result Block"
        );
    }

    #[tokio::test]
    async fn all_error_does_not_block() {
        let mut registry = HookRegistry::new();
        let config = HookConfig {
            events: {
                let mut m = HashMap::new();
                m.insert(
                    HookEvent::PreToolUse,
                    vec![
                        make_entry("exit 1"), // Error
                        make_entry("exit 1"), // Error
                    ],
                );
                m
            },
        };
        registry.register_from_config(&config);

        let result = registry
            .dispatch(HookEvent::PreToolUse, sample_input())
            .await;

        assert_ne!(
            result.decision,
            HookDecision::Block,
            "Error-only results should not block"
        );
        assert_eq!(result.decision, HookDecision::Error);
    }

    #[tokio::test]
    async fn timeout_on_one_hook_does_not_prevent_others() {
        let mut registry = HookRegistry::new();
        let config = HookConfig {
            events: {
                let mut m = HashMap::new();
                m.insert(
                    HookEvent::PreToolUse,
                    vec![
                        // Fast hook — completes immediately
                        HookEntry {
                            hook_type: HookType::Command,
                            command: Some("echo fast".to_string()),
                            url: None,
                            prompt: None,
                            matcher: Matcher::All,
                            timeout: Some(5),
                            fire_and_forget: false,
                        },
                        // Slow hook — will timeout at 1s
                        HookEntry {
                            hook_type: HookType::Command,
                            command: Some(fixture("slow-hook.sh")),
                            url: None,
                            prompt: None,
                            matcher: Matcher::All,
                            timeout: Some(1),
                            fire_and_forget: false,
                        },
                    ],
                );
                m
            },
        };
        registry.register_from_config(&config);

        let result = registry
            .dispatch(HookEvent::PreToolUse, sample_input())
            .await;

        // Both should have outputs (one Allow from fast, one Error from timeout)
        assert_eq!(
            result.outputs.len(),
            2,
            "Both hooks should produce output, got {}",
            result.outputs.len()
        );

        // Overall should be Allow because fast hook succeeded and timeout is Error (not Block)
        assert_eq!(result.decision, HookDecision::Allow);
    }

    #[tokio::test]
    async fn empty_hook_list_returns_allow() {
        let registry = HookRegistry::new();
        let result = registry
            .dispatch(HookEvent::PreToolUse, sample_input())
            .await;
        assert_eq!(result.decision, HookDecision::Allow);
        assert!(result.outputs.is_empty());
    }
}

mod blocking_semantics {
    use super::*;

    #[tokio::test]
    async fn pre_tool_use_block_returns_block_decision() {
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
            .dispatch(HookEvent::PreToolUse, sample_input())
            .await;

        assert_eq!(result.decision, HookDecision::Block);
    }

    #[tokio::test]
    async fn post_tool_use_block_is_observe_only() {
        // PostToolUse should never block — even if hook exits 2, the event
        // doesn't support blocking per supports_blocking().
        // The registry should enforce this by downgrading Block to Allow/Error
        // for non-blocking events, or the hook still returns Block but the
        // caller (agent_loop) ignores it. We test the event's contract.
        assert!(
            !HookEvent::PostToolUse.supports_blocking(),
            "PostToolUse should not support blocking"
        );
        assert!(
            HookEvent::PreToolUse.supports_blocking(),
            "PreToolUse should support blocking"
        );
    }

    #[tokio::test]
    async fn stop_does_not_support_blocking() {
        assert!(
            !HookEvent::Stop.supports_blocking(),
            "Stop should not support blocking"
        );
    }

    #[tokio::test]
    async fn user_prompt_submit_supports_blocking() {
        assert!(
            HookEvent::UserPromptSubmit.supports_blocking(),
            "UserPromptSubmit should support blocking"
        );
    }
}

mod matcher_filtering {
    use super::*;

    #[tokio::test]
    async fn matcher_filters_by_tool_name() {
        let mut registry = HookRegistry::new();
        let config = HookConfig {
            events: {
                let mut m = HashMap::new();
                m.insert(
                    HookEvent::PreToolUse,
                    vec![HookEntry {
                        hook_type: HookType::Command,
                        command: Some("true".to_string()),
                        url: None,
                        prompt: None,
                        matcher: Matcher::Pattern("Write".into()),
                        timeout: None,
                        fire_and_forget: false,
                    }],
                );
                m
            },
        };
        registry.register_from_config(&config);

        // Bash tool — should not match Write matcher
        let result = registry
            .dispatch(
                HookEvent::PreToolUse,
                HookInput::pre_tool_use("Bash", &serde_json::json!({}), "t1"),
            )
            .await;
        assert!(
            result.outputs.is_empty(),
            "Write matcher should not fire for Bash tool"
        );

        // Write tool — should match
        let result = registry
            .dispatch(
                HookEvent::PreToolUse,
                HookInput::pre_tool_use("Write", &serde_json::json!({}), "t2"),
            )
            .await;
        assert!(
            !result.outputs.is_empty(),
            "Write matcher should fire for Write tool"
        );
    }
}
