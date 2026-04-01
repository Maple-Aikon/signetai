use std::sync::Arc;

use forge_core::hook::{AggregatedResult, HookDecision, HookEvent, HookInput};
use futures::future::join_all;
use tokio::sync::RwLock;
use tracing::{debug, warn};

use crate::matcher::matches;
use crate::registry::{execute_hook, HookRegistry, RegisteredHook};

/// Dispatch hooks for an event through a `SharedRegistry`.
///
/// The registry read lock is held only long enough to clone the matching hook
/// entries, then released before any async execution begins. This prevents
/// hot-reload write locks from blocking for the full hook timeout duration.
pub async fn dispatch(
    registry: &Arc<RwLock<HookRegistry>>,
    event: HookEvent,
    input: HookInput,
) -> AggregatedResult {
    // Snapshot matching hooks under a brief read lock.
    let (matching, daemon_url, total) = {
        let reg = registry.read().await;
        let hooks = reg.get(event);
        if hooks.is_empty() {
            return AggregatedResult::default();
        }
        let target = input.match_target().map(|s| s.to_string());
        let matching: Vec<RegisteredHook> = hooks
            .iter()
            .filter(|h| matches(&h.entry.matcher, target.as_deref()))
            .cloned()
            .collect();
        let daemon_url = reg.daemon_url().map(str::to_string);
        let total = hooks.len();
        (matching, daemon_url, total)
    }; // Read lock released here — hot-reload can proceed.

    if matching.is_empty() {
        return AggregatedResult::default();
    }

    debug!(
        "Dispatching {:?}: {} matching hooks (of {} registered)",
        event,
        matching.len(),
        total
    );

    let futures: Vec<_> = matching
        .iter()
        .map(|hook| {
            let input = input.clone();
            let entry = hook.entry.clone();
            let headers = hook.headers.clone();
            let daemon = daemon_url.clone();
            async move { execute_hook(&entry, &headers, &input, daemon.as_deref()).await }
        })
        .collect();

    let outputs = join_all(futures).await;
    let result = AggregatedResult::aggregate(outputs);

    if result.decision == HookDecision::Block && !event.supports_blocking() {
        warn!(
            "Hook returned Block for {:?} which doesn't support blocking — treating as Allow",
            event
        );
        return AggregatedResult {
            decision: HookDecision::Allow,
            ..result
        };
    }

    result
}
