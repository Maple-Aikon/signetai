use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

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
