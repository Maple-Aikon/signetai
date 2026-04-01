use forge_core::hook::{AggregatedResult, HookEvent, HookInput};

use crate::registry::HookRegistry;

/// Convenience function: dispatch hooks for an event through a registry.
pub async fn dispatch(
    registry: &HookRegistry,
    event: HookEvent,
    input: HookInput,
) -> AggregatedResult {
    registry.dispatch(event, input).await
}
