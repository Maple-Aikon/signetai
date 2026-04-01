use forge_core::hook::Matcher;
use forge_hooks::matches;

mod all_matcher {
    use super::*;

    #[test]
    fn matches_any_string() {
        assert!(matches(&Matcher::All, Some("Bash")));
        assert!(matches(&Matcher::All, Some("Write")));
        assert!(matches(&Matcher::All, Some("")));
    }

    #[test]
    fn matches_none_target() {
        assert!(matches(&Matcher::All, None));
    }
}

mod wildcard {
    use super::*;

    #[test]
    fn star_matches_everything() {
        let m = Matcher::Pattern("*".into());
        assert!(matches(&m, Some("anything")));
        assert!(matches(&m, Some("Bash")));
    }

    #[test]
    fn star_matches_none_target() {
        let m = Matcher::Pattern("*".into());
        assert!(matches(&m, None));
    }
}

mod empty_pattern {
    use super::*;

    #[test]
    fn empty_string_matches_everything() {
        let m = Matcher::Pattern(String::new());
        assert!(matches(&m, Some("anything")));
    }

    #[test]
    fn empty_string_matches_none_target() {
        let m = Matcher::Pattern(String::new());
        assert!(matches(&m, None));
    }
}

mod exact_match {
    use super::*;

    #[test]
    fn matches_exactly() {
        let m = Matcher::Pattern("Bash".into());
        assert!(matches(&m, Some("Bash")));
    }

    #[test]
    fn does_not_match_prefix() {
        let m = Matcher::Pattern("Bash".into());
        assert!(!matches(&m, Some("BashTool")));
    }

    #[test]
    fn does_not_match_suffix() {
        let m = Matcher::Pattern("Bash".into());
        assert!(!matches(&m, Some("MyBash")));
    }

    #[test]
    fn does_not_match_none() {
        let m = Matcher::Pattern("Bash".into());
        assert!(!matches(&m, None));
    }
}

mod pipe_separated {
    use super::*;

    #[test]
    fn matches_first_option() {
        let m = Matcher::Pattern("Write|Edit".into());
        assert!(matches(&m, Some("Write")));
    }

    #[test]
    fn matches_second_option() {
        let m = Matcher::Pattern("Write|Edit".into());
        assert!(matches(&m, Some("Edit")));
    }

    #[test]
    fn does_not_match_partial() {
        let m = Matcher::Pattern("Write|Edit".into());
        assert!(!matches(&m, Some("ReadWrite")));
    }

    #[test]
    fn does_not_match_combined() {
        let m = Matcher::Pattern("Write|Edit".into());
        assert!(!matches(&m, Some("WriteEdit")));
    }

    #[test]
    fn three_options() {
        let m = Matcher::Pattern("Write|Edit|Bash".into());
        assert!(matches(&m, Some("Write")));
        assert!(matches(&m, Some("Edit")));
        assert!(matches(&m, Some("Bash")));
        assert!(!matches(&m, Some("Delete")));
    }
}

mod regex_patterns {
    use super::*;

    #[test]
    fn caret_prefix_match() {
        let m = Matcher::Pattern("^Write.*".into());
        assert!(matches(&m, Some("Write")));
        assert!(matches(&m, Some("WriteFile")));
        assert!(!matches(&m, Some("ReadWrite")));
    }

    #[test]
    fn dollar_suffix_match() {
        let m = Matcher::Pattern(".*File$".into());
        assert!(matches(&m, Some("WriteFile")));
        assert!(matches(&m, Some("ReadFile")));
        assert!(!matches(&m, Some("FileReader")));
    }

    #[test]
    fn dot_star_matches_substring() {
        let m = Matcher::Pattern(".*ool.*".into());
        assert!(matches(&m, Some("BashTool")));
        assert!(matches(&m, Some("ToolBox")));
    }

    #[test]
    fn character_class() {
        let m = Matcher::Pattern("[BW]ash".into());
        assert!(matches(&m, Some("Bash")));
        assert!(matches(&m, Some("Wash")));
        assert!(!matches(&m, Some("Cash")));
    }

    #[test]
    fn invalid_regex_returns_false() {
        let m = Matcher::Pattern("[unclosed".into());
        // Should not panic, just return false
        assert!(!matches(&m, Some("anything")));
    }
}

mod case_sensitivity {
    use super::*;

    #[test]
    fn exact_match_is_case_sensitive() {
        let m = Matcher::Pattern("bash".into());
        assert!(matches(&m, Some("bash")));
        assert!(!matches(&m, Some("Bash")));
        assert!(!matches(&m, Some("BASH")));
    }

    #[test]
    fn pipe_separated_is_case_sensitive() {
        let m = Matcher::Pattern("write|edit".into());
        assert!(matches(&m, Some("write")));
        assert!(!matches(&m, Some("Write")));
    }
}
