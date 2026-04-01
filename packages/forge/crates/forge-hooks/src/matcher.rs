use forge_core::hook::Matcher;
use regex_lite::Regex;

/// Test whether a matcher pattern matches a given target string.
///
/// Matching rules:
/// - `Matcher::All` or `Pattern("*")` or empty pattern: matches everything
/// - Simple alphanumeric (no special chars): exact match
/// - Contains `|`: pipe-separated exact matches
/// - Contains regex special chars: compiled as regex
/// - All matching is case-sensitive
pub fn matches(matcher: &Matcher, target: Option<&str>) -> bool {
    match matcher {
        Matcher::All => true,
        Matcher::Pattern(pattern) => {
            if pattern.is_empty() || pattern == "*" {
                return true;
            }
            let target = match target {
                Some(t) => t,
                // No target to match against and pattern is specific
                None => return false,
            };
            if pattern.contains('|') && !has_regex_chars_except_pipe(pattern) {
                // Pipe-separated exact match
                pattern.split('|').any(|p| p == target)
            } else if has_regex_chars(pattern) {
                // Regex match
                match Regex::new(pattern) {
                    Ok(re) => re.is_match(target),
                    Err(_) => {
                        tracing::warn!("Invalid regex in hook matcher: {pattern}");
                        false
                    }
                }
            } else {
                // Simple exact match
                pattern == target
            }
        }
    }
}

/// Check if a string contains regex special characters (excluding pipe).
fn has_regex_chars_except_pipe(s: &str) -> bool {
    s.chars()
        .any(|c| matches!(c, '^' | '$' | '.' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '\\' | '*'))
}

/// Check if a string contains any regex special characters.
fn has_regex_chars(s: &str) -> bool {
    s.chars()
        .any(|c| matches!(c, '^' | '$' | '.' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '\\' | '*' | '|'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_matches_everything() {
        assert!(matches(&Matcher::All, Some("Bash")));
        assert!(matches(&Matcher::All, None));
    }

    #[test]
    fn wildcard_matches_everything() {
        let m = Matcher::Pattern("*".into());
        assert!(matches(&m, Some("anything")));
        assert!(matches(&m, None));
    }

    #[test]
    fn empty_matches_everything() {
        let m = Matcher::Pattern(String::new());
        assert!(matches(&m, Some("anything")));
        assert!(matches(&m, None));
    }

    #[test]
    fn exact_match() {
        let m = Matcher::Pattern("Bash".into());
        assert!(matches(&m, Some("Bash")));
        assert!(!matches(&m, Some("BashTool")));
        assert!(!matches(&m, Some("bash")));
        assert!(!matches(&m, None));
    }

    #[test]
    fn pipe_separated() {
        let m = Matcher::Pattern("Write|Edit|Bash".into());
        assert!(matches(&m, Some("Write")));
        assert!(matches(&m, Some("Edit")));
        assert!(matches(&m, Some("Bash")));
        assert!(!matches(&m, Some("ReadWrite")));
        assert!(!matches(&m, Some("Delete")));
    }

    #[test]
    fn regex_pattern() {
        let m = Matcher::Pattern("^Write.*".into());
        assert!(matches(&m, Some("Write")));
        assert!(matches(&m, Some("WriteFile")));
        assert!(!matches(&m, Some("ReadWrite")));
    }

    #[test]
    fn case_sensitive() {
        let m = Matcher::Pattern("bash".into());
        assert!(matches(&m, Some("bash")));
        assert!(!matches(&m, Some("Bash")));
    }

    #[test]
    fn specific_pattern_no_target() {
        let m = Matcher::Pattern("Bash".into());
        assert!(!matches(&m, None));
    }
}
