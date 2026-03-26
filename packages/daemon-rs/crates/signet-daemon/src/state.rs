use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use signet_core::config::DaemonConfig;
use signet_core::db::DbPool;
use signet_pipeline::embedding::EmbeddingProvider;
use signet_services::session::{ContinuityTracker, DedupState, SessionTracker};
use tokio::sync::RwLock;

use crate::auth::rate_limiter::AuthRateLimiter;
use crate::auth::types::AuthMode;

/// Shared application state passed to all route handlers.
pub struct AppState {
    pub config: DaemonConfig,
    pub pool: DbPool,
    pub embedding: RwLock<Option<Arc<dyn EmbeddingProvider>>>,
    pub pipeline_paused: AtomicBool,
    pub pipeline_transition: AtomicBool,
    pub extraction_overload: Mutex<ExtractionOverloadTracker>,
    pub auth_mode: AuthMode,
    pub auth_secret: Option<Vec<u8>>,
    pub auth_admin_limiter: AuthRateLimiter,
    pub sessions: SessionTracker,
    pub continuity: ContinuityTracker,
    pub dedup: DedupState,
}

impl AppState {
    pub fn new(
        config: DaemonConfig,
        pool: DbPool,
        embedding: Option<Arc<dyn EmbeddingProvider>>,
        auth_mode: AuthMode,
        auth_secret: Option<Vec<u8>>,
        auth_admin_limiter: AuthRateLimiter,
    ) -> Self {
        let paused = config
            .manifest
            .memory
            .as_ref()
            .and_then(|m| m.pipeline_v2.as_ref())
            .map(|p| p.paused)
            .unwrap_or(false);

        Self {
            config,
            pool,
            embedding: RwLock::new(embedding),
            pipeline_paused: AtomicBool::new(paused),
            pipeline_transition: AtomicBool::new(false),
            extraction_overload: Mutex::new(ExtractionOverloadTracker::default()),
            auth_mode,
            auth_secret,
            auth_admin_limiter,
            sessions: SessionTracker::new(),
            continuity: ContinuityTracker::new(),
            dedup: DedupState::new(),
        }
    }

    pub fn pipeline_paused(&self) -> bool {
        self.pipeline_paused.load(Ordering::SeqCst)
    }
}

#[derive(Default)]
pub struct ExtractionOverloadTracker {
    overload_since_ms: Option<i64>,
    next_tick_at_ms: Option<i64>,
}

impl ExtractionOverloadTracker {
    pub fn update(
        &mut self,
        overloaded: bool,
        now_ms: i64,
        overload_backoff_ms: u64,
    ) -> (Option<i64>, Option<u64>) {
        if !overloaded {
            self.overload_since_ms = None;
            self.next_tick_at_ms = None;
            return (None, None);
        }

        if self.overload_since_ms.is_none() {
            self.overload_since_ms = Some(now_ms);
        }

        let backoff_ms = overload_backoff_ms as i64;
        let mut next_tick_at = self
            .next_tick_at_ms
            .unwrap_or_else(|| now_ms.saturating_add(backoff_ms));

        while next_tick_at <= now_ms {
            next_tick_at = next_tick_at.saturating_add(backoff_ms);
        }

        self.next_tick_at_ms = Some(next_tick_at);
        let next_tick_in_ms = next_tick_at.saturating_sub(now_ms) as u64;
        (self.overload_since_ms, Some(next_tick_in_ms))
    }
}

#[cfg(test)]
mod tests {
    use super::ExtractionOverloadTracker;

    #[test]
    fn overload_tracker_sets_since_once_and_counts_down() {
        let mut tracker = ExtractionOverloadTracker::default();

        let (since_1, next_1) = tracker.update(true, 1_000, 30_000);
        assert_eq!(since_1, Some(1_000));
        assert_eq!(next_1, Some(30_000));

        let (since_2, next_2) = tracker.update(true, 11_000, 30_000);
        assert_eq!(since_2, Some(1_000));
        assert_eq!(next_2, Some(20_000));
    }

    #[test]
    fn overload_tracker_rolls_forward_after_backoff_window() {
        let mut tracker = ExtractionOverloadTracker::default();

        let _ = tracker.update(true, 1_000, 30_000);
        let (since, next) = tracker.update(true, 31_500, 30_000);

        assert_eq!(since, Some(1_000));
        assert_eq!(next, Some(29_500));
    }

    #[test]
    fn overload_tracker_clears_when_not_overloaded() {
        let mut tracker = ExtractionOverloadTracker::default();

        let _ = tracker.update(true, 1_000, 30_000);
        let (since, next) = tracker.update(false, 2_000, 30_000);

        assert_eq!(since, None);
        assert_eq!(next, None);
    }
}
