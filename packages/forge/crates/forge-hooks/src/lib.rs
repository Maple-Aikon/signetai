pub mod config;
pub mod dispatch;
pub mod executor;
pub mod matcher;
pub mod registry;

pub use config::parse_hook_config;
pub use dispatch::dispatch;
pub use matcher::matches;
pub use registry::{HookRegistry, RegisteredHook, SharedRegistry};

// Re-export core types for convenience
pub use forge_core::hook::{
    AggregatedResult, HookConfig, HookDecision, HookEntry, HookEvent, HookInput, HookOutput,
    HookType, Matcher,
};
