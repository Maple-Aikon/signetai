use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use signet_core::config::DaemonConfig;
use signet_core::db::DbPool;
use signet_pipeline::embedding::EmbeddingProvider;
use signet_pipeline::worker::SharedWorkerRuntimeStats;
use signet_services::session::{ContinuityTracker, DedupState, SessionTracker};
use tokio::sync::RwLock;

use crate::auth::rate_limiter::AuthRateLimiter;
use crate::auth::types::AuthMode;

/// Runtime extraction provider resolution state, matching the JS daemon contract.
#[derive(Debug, Clone)]
pub struct ExtractionRuntimeState {
    pub configured: Option<String>,
    pub resolved: String,
    pub effective: String,
    pub fallback_provider: String,
    pub status: String,
    pub degraded: bool,
    pub fallback_applied: bool,
    pub reason: Option<String>,
    pub since: Option<String>,
}

/// Shared application state passed to all route handlers.
pub struct AppState {
    pub config: DaemonConfig,
    pub pool: DbPool,
    pub embedding: RwLock<Option<Arc<dyn EmbeddingProvider>>>,
    pub pipeline_paused: AtomicBool,
    pub pipeline_transition: AtomicBool,
    pub extraction_worker_stats: Option<SharedWorkerRuntimeStats>,
    pub auth_mode: AuthMode,
    pub auth_secret: Option<Vec<u8>>,
    pub auth_admin_limiter: AuthRateLimiter,
    pub sessions: SessionTracker,
    pub continuity: ContinuityTracker,
    pub dedup: DedupState,
    pub extraction_state: RwLock<Option<ExtractionRuntimeState>>,
}

impl AppState {
    pub fn new(
        config: DaemonConfig,
        pool: DbPool,
        embedding: Option<Arc<dyn EmbeddingProvider>>,
        extraction_worker_stats: Option<SharedWorkerRuntimeStats>,
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

        // Derive initial extraction runtime state from config, mirroring
        // the JS daemon's startup resolution contract.
        let extraction_state = config
            .manifest
            .memory
            .as_ref()
            .and_then(|m| m.pipeline_v2.as_ref())
            .map(|pipeline| {
                let extraction = &pipeline.extraction;
                let status = if !pipeline.enabled || extraction.provider == "none" {
                    "disabled"
                } else if paused {
                    "paused"
                } else {
                    "active"
                };
                ExtractionRuntimeState {
                    configured: Some(extraction.provider.clone()),
                    resolved: extraction.provider.clone(),
                    effective: extraction.provider.clone(),
                    fallback_provider: extraction.fallback_provider.clone(),
                    status: status.to_string(),
                    degraded: false,
                    fallback_applied: false,
                    reason: None,
                    since: None,
                }
            });

        Self {
            config,
            pool,
            embedding: RwLock::new(embedding),
            pipeline_paused: AtomicBool::new(paused),
            pipeline_transition: AtomicBool::new(false),
            extraction_worker_stats,
            auth_mode,
            auth_secret,
            auth_admin_limiter,
            sessions: SessionTracker::new(),
            continuity: ContinuityTracker::new(),
            dedup: DedupState::new(),
            extraction_state: RwLock::new(extraction_state),
        }
    }

    pub fn pipeline_paused(&self) -> bool {
        self.pipeline_paused.load(Ordering::SeqCst)
    }
}
