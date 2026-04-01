pub mod command;
pub mod daemon;
pub mod http;

use async_trait::async_trait;
use forge_core::hook::{HookInput, HookOutput};

/// Trait for executing a hook and returning its output.
/// Implementations handle command subprocess, HTTP POST, daemon delegation, etc.
#[async_trait]
pub trait HookExecutor: Send + Sync {
    async fn execute(&self, input: &HookInput) -> HookOutput;
}
