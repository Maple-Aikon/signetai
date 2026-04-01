use forge_core::hook::{HookConfig, HookEvent, HookType, Matcher};

mod yaml_parsing {
    use super::*;

    #[test]
    fn valid_hooks_section_parses_all_fields() {
        let yaml = r#"
PreToolUse:
  - type: command
    command: "~/.agents/hooks/validate.sh"
    matcher: "Bash|Shell"
    timeout: 5
    async: false
  - type: http
    url: "http://localhost:3850/api/hooks/check"
    timeout: 10
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();

        let entries = config.events.get(&HookEvent::PreToolUse).unwrap();
        assert_eq!(entries.len(), 2);

        let first = &entries[0];
        assert_eq!(first.hook_type, HookType::Command);
        assert_eq!(first.command.as_deref(), Some("~/.agents/hooks/validate.sh"));
        assert_eq!(first.timeout, Some(5));
        assert!(!first.fire_and_forget);

        if let Matcher::Pattern(ref p) = first.matcher {
            assert_eq!(p, "Bash|Shell");
        } else {
            panic!("Expected Pattern matcher, got All");
        }

        let second = &entries[1];
        assert_eq!(second.hook_type, HookType::Http);
        assert_eq!(
            second.url.as_deref(),
            Some("http://localhost:3850/api/hooks/check")
        );
        assert_eq!(second.timeout, Some(10));
    }

    #[test]
    fn multiple_events_parsed() {
        let yaml = r#"
PreToolUse:
  - type: command
    command: "echo pre"
PostToolUse:
  - type: command
    command: "echo post"
    async: true
Stop:
  - type: http
    url: "http://localhost:3850/api/hooks/stop"
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();

        assert!(config.events.contains_key(&HookEvent::PreToolUse));
        assert!(config.events.contains_key(&HookEvent::PostToolUse));
        assert!(config.events.contains_key(&HookEvent::Stop));
        assert_eq!(config.events.len(), 3);

        let post = &config.events[&HookEvent::PostToolUse][0];
        assert!(post.fire_and_forget);
    }

    #[test]
    fn empty_hooks_section_parses_to_empty() {
        let yaml = "{}";
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();
        assert!(config.events.is_empty());
    }

    #[test]
    fn missing_hooks_returns_default() {
        let config = HookConfig::default();
        assert!(config.events.is_empty());
    }
}

mod hook_entry_defaults {
    use super::*;

    #[test]
    fn omitted_timeout_is_none() {
        let yaml = r#"
PreToolUse:
  - type: command
    command: "true"
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();
        let entry = &config.events[&HookEvent::PreToolUse][0];
        assert_eq!(entry.timeout, None);
    }

    #[test]
    fn omitted_async_defaults_to_false() {
        let yaml = r#"
PreToolUse:
  - type: command
    command: "true"
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();
        let entry = &config.events[&HookEvent::PreToolUse][0];
        assert!(!entry.fire_and_forget);
    }

    #[test]
    fn omitted_matcher_defaults_to_all() {
        let yaml = r#"
PreToolUse:
  - type: command
    command: "true"
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();
        let entry = &config.events[&HookEvent::PreToolUse][0];
        assert_eq!(entry.matcher, Matcher::All);
    }

    #[test]
    fn hook_with_only_required_fields() {
        let yaml = r#"
Stop:
  - type: command
    command: "echo done"
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();
        let entry = &config.events[&HookEvent::Stop][0];
        assert_eq!(entry.hook_type, HookType::Command);
        assert_eq!(entry.command.as_deref(), Some("echo done"));
        assert_eq!(entry.url, None);
        assert_eq!(entry.prompt, None);
        assert_eq!(entry.timeout, None);
        assert!(!entry.fire_and_forget);
    }
}

mod matcher_syntax_variants {
    use super::*;

    #[test]
    fn exact_string() {
        let yaml = r#"
PreToolUse:
  - type: command
    command: "true"
    matcher: "Bash"
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();
        let entry = &config.events[&HookEvent::PreToolUse][0];
        assert_eq!(entry.matcher, Matcher::Pattern("Bash".into()));
    }

    #[test]
    fn pipe_separated() {
        let yaml = r#"
PreToolUse:
  - type: command
    command: "true"
    matcher: "Write|Edit|Bash"
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();
        let entry = &config.events[&HookEvent::PreToolUse][0];
        assert_eq!(entry.matcher, Matcher::Pattern("Write|Edit|Bash".into()));
    }

    #[test]
    fn regex_pattern() {
        let yaml = r#"
PreToolUse:
  - type: command
    command: "true"
    matcher: "^Write.*"
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();
        let entry = &config.events[&HookEvent::PreToolUse][0];
        assert_eq!(entry.matcher, Matcher::Pattern("^Write.*".into()));
    }

    #[test]
    fn wildcard() {
        let yaml = r#"
PreToolUse:
  - type: command
    command: "true"
    matcher: "*"
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();
        let entry = &config.events[&HookEvent::PreToolUse][0];
        assert_eq!(entry.matcher, Matcher::Pattern("*".into()));
    }
}

mod all_hook_types {
    use super::*;

    #[test]
    fn command_type() {
        let yaml = r#"
PreToolUse:
  - type: command
    command: "echo test"
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();
        assert_eq!(
            config.events[&HookEvent::PreToolUse][0].hook_type,
            HookType::Command
        );
    }

    #[test]
    fn http_type() {
        let yaml = r#"
PreToolUse:
  - type: http
    url: "http://localhost:3850/hook"
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();
        assert_eq!(
            config.events[&HookEvent::PreToolUse][0].hook_type,
            HookType::Http
        );
    }

    #[test]
    fn prompt_type() {
        let yaml = r#"
PreToolUse:
  - type: prompt
    prompt: "Is this safe? {{tool_input}}"
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();
        assert_eq!(
            config.events[&HookEvent::PreToolUse][0].hook_type,
            HookType::Prompt
        );
        assert_eq!(
            config.events[&HookEvent::PreToolUse][0].prompt.as_deref(),
            Some("Is this safe? {{tool_input}}")
        );
    }

    #[test]
    fn agent_type() {
        let yaml = r#"
PreToolUse:
  - type: agent
    prompt: "Evaluate this tool call"
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();
        assert_eq!(
            config.events[&HookEvent::PreToolUse][0].hook_type,
            HookType::Agent
        );
    }

    #[test]
    fn invalid_type_fails() {
        let yaml = r#"
PreToolUse:
  - type: invalid_type
    command: "echo"
"#;
        let result = serde_yml::from_str::<HookConfig>(yaml);
        assert!(
            result.is_err(),
            "Invalid hook type should produce parse error"
        );
    }
}

mod all_event_names {
    use super::*;

    #[test]
    fn all_tier1_events_parse() {
        let yaml = r#"
SessionStart:
  - type: command
    command: "echo start"
SessionEnd:
  - type: command
    command: "echo end"
UserPromptSubmit:
  - type: command
    command: "echo prompt"
PreCompact:
  - type: command
    command: "echo pre-compact"
PostCompact:
  - type: command
    command: "echo post-compact"
PreToolUse:
  - type: command
    command: "echo pre-tool"
PostToolUse:
  - type: command
    command: "echo post-tool"
Stop:
  - type: command
    command: "echo stop"
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();
        assert_eq!(config.events.len(), 8);
        assert!(config.events.contains_key(&HookEvent::SessionStart));
        assert!(config.events.contains_key(&HookEvent::SessionEnd));
        assert!(config.events.contains_key(&HookEvent::UserPromptSubmit));
        assert!(config.events.contains_key(&HookEvent::PreCompact));
        assert!(config.events.contains_key(&HookEvent::PostCompact));
        assert!(config.events.contains_key(&HookEvent::PreToolUse));
        assert!(config.events.contains_key(&HookEvent::PostToolUse));
        assert!(config.events.contains_key(&HookEvent::Stop));
    }

    #[test]
    fn tier2_events_parse() {
        let yaml = r#"
PostToolUseFailure:
  - type: command
    command: "echo failure"
PermissionRequest:
  - type: command
    command: "echo perm-req"
PermissionDenied:
  - type: command
    command: "echo denied"
Notification:
  - type: command
    command: "echo notify"
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();
        assert_eq!(config.events.len(), 4);
        assert!(config.events.contains_key(&HookEvent::PostToolUseFailure));
        assert!(config.events.contains_key(&HookEvent::PermissionRequest));
        assert!(config.events.contains_key(&HookEvent::PermissionDenied));
        assert!(config.events.contains_key(&HookEvent::Notification));
    }
}

mod serialization_roundtrip {
    use super::*;

    #[test]
    fn hook_config_roundtrips_through_yaml() {
        let yaml = r#"
PreToolUse:
  - type: command
    command: "echo test"
    matcher: "Bash"
    timeout: 5
    async: true
"#;
        let config: HookConfig = serde_yml::from_str(yaml).unwrap();
        let serialized = serde_yml::to_string(&config).unwrap();
        let reparsed: HookConfig = serde_yml::from_str(&serialized).unwrap();

        let entry = &reparsed.events[&HookEvent::PreToolUse][0];
        assert_eq!(entry.hook_type, HookType::Command);
        assert_eq!(entry.command.as_deref(), Some("echo test"));
        assert_eq!(entry.timeout, Some(5));
        assert!(entry.fire_and_forget);
    }
}

mod hook_event_properties {
    use super::*;

    #[test]
    fn supports_blocking_correct() {
        // Only PreToolUse, UserPromptSubmit, PermissionRequest support blocking
        assert!(HookEvent::PreToolUse.supports_blocking());
        assert!(HookEvent::UserPromptSubmit.supports_blocking());
        assert!(HookEvent::PermissionRequest.supports_blocking());

        // All others are observe-only
        assert!(!HookEvent::PostToolUse.supports_blocking());
        assert!(!HookEvent::PostToolUseFailure.supports_blocking());
        assert!(!HookEvent::SessionStart.supports_blocking());
        assert!(!HookEvent::SessionEnd.supports_blocking());
        assert!(!HookEvent::PreCompact.supports_blocking());
        assert!(!HookEvent::PostCompact.supports_blocking());
        assert!(!HookEvent::Stop.supports_blocking());
        assert!(!HookEvent::PermissionDenied.supports_blocking());
        assert!(!HookEvent::Notification.supports_blocking());
        assert!(!HookEvent::SubagentStart.supports_blocking());
        assert!(!HookEvent::CwdChanged.supports_blocking());
    }

    #[test]
    fn hook_decision_default_is_allow() {
        use forge_core::hook::HookDecision;
        assert_eq!(HookDecision::default(), HookDecision::Allow);
    }

    #[test]
    fn hook_output_default_is_allow() {
        use forge_core::hook::HookOutput;
        let out = HookOutput::default();
        assert_eq!(out.decision, forge_core::hook::HookDecision::Allow);
        assert!(out.reason.is_none());
        assert!(out.inject.is_none());
        assert!(out.data.is_null());
    }
}
