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
    running: bool,
    overloaded: bool,
    load_per_cpu: Option<f64>,
    overload_since_ms: Option<i64>,
    next_tick_at_ms: Option<i64>,
}

impl ExtractionOverloadTracker {
    pub fn update_sample(
        &mut self,
        running: bool,
        load_per_cpu: Option<f64>,
        overloaded: bool,
        now_ms: i64,
        overload_backoff_ms: u64,
    ) {
        self.running = running;
        self.load_per_cpu = load_per_cpu;
        self.overloaded = overloaded;

        if !running || !overloaded {
            self.overload_since_ms = None;
            self.next_tick_at_ms = None;
            return;
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
    }

    pub fn snapshot(&self, now_ms: i64) -> ExtractionOverloadSnapshot {
        let next_tick_in_ms = self.next_tick_at_ms.map(|at| at.saturating_sub(now_ms).max(0) as u64);
        ExtractionOverloadSnapshot {
            running: self.running,
            overloaded: self.overloaded,
            load_per_cpu: self.load_per_cpu,
            overload_since_ms: self.overload_since_ms,
            next_tick_in_ms,
        }
    }
}

#[derive(Default)]
pub struct ExtractionOverloadSnapshot {
    pub running: bool,
    pub overloaded: bool,
    pub load_per_cpu: Option<f64>,
    pub overload_since_ms: Option<i64>,
    pub next_tick_in_ms: Option<u64>,
}

#[cfg(test)]
impl ExtractionOverloadTracker {
    fn next_tick_at_ms(&self) -> Option<i64> {
        self.next_tick_at_ms
    }
}

#[cfg(test)]
mod tests {
    use super::ExtractionOverloadTracker;

    #[test]
    fn overload_tracker_sets_since_once_and_counts_down() {
        let mut tracker = ExtractionOverloadTracker::default();

        tracker.update_sample(true, Some(1.5), true, 1_000, 30_000);
        let snap_1 = tracker.snapshot(1_000);
        assert!(snap_1.running);
        assert!(snap_1.overloaded);
        assert_eq!(snap_1.load_per_cpu, Some(1.5));
        assert_eq!(snap_1.overload_since_ms, Some(1_000));
        assert_eq!(snap_1.next_tick_in_ms, Some(30_000));

        tracker.update_sample(true, Some(1.4), true, 11_000, 30_000);
        let snap_2 = tracker.snapshot(11_000);
        assert_eq!(snap_2.overload_since_ms, Some(1_000));
        assert_eq!(snap_2.next_tick_in_ms, Some(20_000));
    }

    #[test]
    fn overload_tracker_rolls_forward_after_backoff_window() {
        let mut tracker = ExtractionOverloadTracker::default();

        tracker.update_sample(true, Some(1.5), true, 1_000, 30_000);
        tracker.update_sample(true, Some(1.5), true, 31_500, 30_000);
        let snap = tracker.snapshot(31_500);

        assert_eq!(snap.overload_since_ms, Some(1_000));
        assert_eq!(snap.next_tick_in_ms, Some(29_500));
    }

    #[test]
    fn overload_tracker_clears_when_not_overloaded() {
        let mut tracker = ExtractionOverloadTracker::default();

        tracker.update_sample(true, Some(1.5), true, 1_000, 30_000);
        tracker.update_sample(true, Some(0.3), false, 2_000, 30_000);
        let snap = tracker.snapshot(2_000);

        assert!(snap.running);
        assert!(!snap.overloaded);
        assert_eq!(snap.overload_since_ms, None);
        assert_eq!(snap.next_tick_in_ms, None);
    }

    #[test]
    fn overload_tracker_clears_when_not_running() {
        let mut tracker = ExtractionOverloadTracker::default();

        tracker.update_sample(true, Some(1.5), true, 1_000, 30_000);
        tracker.update_sample(false, None, false, 2_000, 30_000);
        let snap = tracker.snapshot(2_000);

        assert!(!snap.running);
        assert!(!snap.overloaded);
        assert_eq!(snap.load_per_cpu, None);
        assert_eq!(snap.overload_since_ms, None);
        assert_eq!(snap.next_tick_in_ms, None);
    }

    #[test]
    fn snapshot_counts_down_without_mutating_tracker() {
        let mut tracker = ExtractionOverloadTracker::default();

        tracker.update_sample(true, Some(1.5), true, 1_000, 30_000);
        let before = tracker.next_tick_at_ms();
        let snap = tracker.snapshot(16_000);
        let after = tracker.next_tick_at_ms();

        assert_eq!(before, after);
        assert_eq!(snap.next_tick_in_ms, Some(15_000));
    }
}
