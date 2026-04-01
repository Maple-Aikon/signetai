use forge_core::hook::HookConfig;
use tracing::{debug, warn};

/// Parse hook configuration from a YAML string (the full agent.yaml content).
/// Extracts the `hooks` section. Returns empty config if missing or invalid.
pub fn parse_hook_config(yaml: &str) -> HookConfig {
    // Parse the full YAML to extract just the hooks section
    let val: serde_json::Value = match serde_yml::from_str(yaml) {
        Ok(v) => v,
        Err(e) => {
            warn!("Failed to parse YAML for hooks config: {e}");
            return HookConfig::default();
        }
    };

    let hooks = match val.get("hooks") {
        Some(h) => h.clone(),
        None => {
            debug!("No hooks section in agent.yaml");
            return HookConfig::default();
        }
    };

    match serde_json::from_value(hooks) {
        Ok(config) => {
            debug!("Parsed hook config");
            config
        }
        Err(e) => {
            warn!("Failed to parse hooks config: {e}");
            HookConfig::default()
        }
    }
}

/// Load hook configuration from the agent.yaml file at the standard path.
pub fn load_hook_config() -> HookConfig {
    let path = forge_signet::config::agent_yaml_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => parse_hook_config(&content),
        Err(_) => {
            debug!("No agent.yaml found for hooks config");
            HookConfig::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::hook::{HookEvent, HookType, Matcher};

    #[test]
    fn parse_valid_hooks() {
        let yaml = r#"
name: test
hooks:
  PreToolUse:
    - matcher: "Bash|Shell"
      type: command
      command: "~/.agents/hooks/validate.sh"
      timeout: 5
    - matcher: "Write"
      type: http
      url: "http://localhost:3850/api/hooks/validate"
  PostToolUse:
    - type: command
      command: "~/.agents/hooks/log.sh"
      async: true
"#;
        let config = parse_hook_config(yaml);
        let pre = config.events.get(&HookEvent::PreToolUse).unwrap();
        assert_eq!(pre.len(), 2);
        assert_eq!(pre[0].hook_type, HookType::Command);
        assert_eq!(pre[0].matcher, Matcher::Pattern("Bash|Shell".into()));
        assert_eq!(pre[0].timeout, Some(5));
        assert_eq!(pre[1].hook_type, HookType::Http);

        let post = config.events.get(&HookEvent::PostToolUse).unwrap();
        assert_eq!(post.len(), 1);
        assert!(post[0].fire_and_forget);
    }

    #[test]
    fn missing_hooks_returns_empty() {
        let yaml = "name: test\nmemory: {}\n";
        let config = parse_hook_config(yaml);
        assert!(config.events.is_empty());
    }

    #[test]
    fn invalid_yaml_returns_empty() {
        let config = parse_hook_config("{{invalid yaml");
        assert!(config.events.is_empty());
    }

    #[test]
    fn empty_string_returns_empty() {
        let config = parse_hook_config("");
        assert!(config.events.is_empty());
    }
}
