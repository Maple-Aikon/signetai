//! Pipeline worker: leases jobs, calls LLM extraction, applies decisions.
//!
//! The worker polls the `memory_jobs` queue, processes extraction jobs
//! via the LLM provider, and writes results through the DB writer.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tracing::{info, warn};

use signet_core::db::DbPool;

use crate::extraction;
use crate::provider::{GenerateOpts, LlmProvider, LlmSemaphore};

// ---------------------------------------------------------------------------
// Worker config
// ---------------------------------------------------------------------------

/// Configuration for the pipeline worker.
#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub poll_ms: u64,
    pub max_retries: u32,
    pub lease_timeout_ms: u64,
    pub extraction_timeout_ms: u64,
    pub extraction_max_tokens: u32,
    pub min_confidence: f64,
    pub shadow_mode: bool,
    pub graph_enabled: bool,
    pub structural_enabled: bool,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            poll_ms: 500,
            max_retries: 3,
            lease_timeout_ms: 30_000,
            extraction_timeout_ms: 90_000,
            extraction_max_tokens: 4096,
            min_confidence: 0.5,
            shadow_mode: false,
            graph_enabled: true,
            structural_enabled: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Job types
// ---------------------------------------------------------------------------

/// A leased job from the queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeasedJob {
    pub id: String,
    pub memory_id: Option<String>,
    pub job_type: String,
    pub payload: Option<String>,
    pub attempts: i64,
}

/// Result of processing a job.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobResult {
    pub facts_extracted: usize,
    pub entities_extracted: usize,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Worker handle
// ---------------------------------------------------------------------------

/// Handle for controlling the pipeline worker.
pub struct WorkerHandle {
    shutdown: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl WorkerHandle {
    /// Signal the worker to stop and wait for it to finish.
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.handle.await;
    }
}

// ---------------------------------------------------------------------------
// Start the worker
// ---------------------------------------------------------------------------

/// Start the pipeline worker loop.
pub fn start(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: WorkerConfig,
) -> WorkerHandle {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    let handle = tokio::spawn(worker_loop(pool, provider, semaphore, config, shutdown_rx));

    WorkerHandle {
        shutdown: shutdown_tx,
        handle,
    }
}

async fn worker_loop(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: WorkerConfig,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut consecutive_failures: u32 = 0;
    let base_delay = Duration::from_millis(config.poll_ms);
    let max_delay = Duration::from_secs(60);

    info!(
        poll_ms = config.poll_ms,
        provider = provider.name(),
        "pipeline worker started"
    );

    loop {
        // Check shutdown
        if *shutdown.borrow() {
            info!("pipeline worker shutting down");
            break;
        }

        // Calculate backoff delay
        let delay = if consecutive_failures > 0 {
            let backoff = base_delay * 2u32.pow(consecutive_failures.min(6));
            backoff.min(max_delay)
        } else {
            base_delay
        };

        // Wait with shutdown check
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = shutdown.changed() => {
                info!("pipeline worker shutting down");
                break;
            }
        }

        // Try to lease a job
        let job = match lease_job(&pool, config.max_retries).await {
            Ok(Some(job)) => job,
            Ok(None) => continue, // No jobs available
            Err(e) => {
                warn!(err = %e, "failed to lease job");
                consecutive_failures += 1;
                continue;
            }
        };

        info!(job_id = %job.id, job_type = %job.job_type, "processing pipeline job");

        // Process based on job type
        let result = match job.job_type.as_str() {
            "extract" => process_extract(&pool, &job, &provider, &semaphore, &config).await,
            other => {
                warn!(job_type = other, "unknown job type");
                Err(format!("unknown job type: {other}"))
            }
        };

        // Record result
        match result {
            Ok(jr) => {
                consecutive_failures = 0;
                let result_json = serde_json::to_string(&jr).unwrap_or_default();
                if let Err(e) = complete_job(&pool, &job.id, &result_json).await {
                    warn!(err = %e, job_id = %job.id, "failed to complete job");
                }
                info!(
                    job_id = %job.id,
                    facts = jr.facts_extracted,
                    entities = jr.entities_extracted,
                    "job completed"
                );
            }
            Err(e) => {
                consecutive_failures += 1;
                warn!(err = %e, job_id = %job.id, "job failed");
                if let Err(fe) = fail_job(&pool, &job.id, &e).await {
                    warn!(err = %fe, job_id = %job.id, "failed to record job failure");
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Job processing
// ---------------------------------------------------------------------------

async fn process_extract(
    pool: &DbPool,
    job: &LeasedJob,
    provider: &Arc<dyn LlmProvider>,
    semaphore: &Arc<LlmSemaphore>,
    config: &WorkerConfig,
) -> Result<JobResult, String> {
    // Load memory content
    let memory_id = job
        .memory_id
        .as_deref()
        .ok_or("extract job missing memory_id")?
        .to_string();

    let content = pool
        .read(move |conn| {
            let mut stmt =
                conn.prepare_cached("SELECT content FROM memories WHERE id = ?1 AND deleted = 0")?;
            let content: Option<String> = stmt
                .query_row(rusqlite::params![memory_id], |r| r.get(0))
                .ok();
            Ok(content)
        })
        .await
        .map_err(|e| e.to_string())?
        .ok_or("memory not found or deleted")?;

    if content.trim().len() < 20 {
        return Ok(JobResult {
            facts_extracted: 0,
            entities_extracted: 0,
            warnings: vec!["content too short for extraction".into()],
        });
    }

    // Build prompt and call LLM (semaphore-guarded)
    let prompt = extraction::build_prompt(&content);
    let opts = GenerateOpts {
        timeout_ms: Some(config.extraction_timeout_ms),
        max_tokens: Some(config.extraction_max_tokens),
    };

    let provider = provider.clone();
    let raw = semaphore
        .run(async { provider.generate(&prompt, &opts).await })
        .await
        .map_err(|e| format!("LLM generation failed: {e}"))?;

    // Parse extraction output
    let result = extraction::parse(&raw.text);

    // Filter by confidence threshold
    let facts: Vec<_> = result
        .facts
        .into_iter()
        .filter(|f| f.confidence >= config.min_confidence)
        .collect();

    let facts_count = facts.len();
    let entities_count = result.entities.len();

    // TODO: Phase 5.3 — apply shadow decisions (add/update/delete)
    // For now, record extraction results without applying writes.
    // The full pipeline will:
    // 1. Search for existing similar memories (hybrid search)
    // 2. Run shadow decision engine (add/update/delete/none)
    // 3. Apply controlled writes with safety gates
    // 4. Persist graph entities
    // 5. Enqueue structural jobs (classify, dependency)

    Ok(JobResult {
        facts_extracted: facts_count,
        entities_extracted: entities_count,
        warnings: result.warnings,
    })
}

// ---------------------------------------------------------------------------
// Job queue operations
// ---------------------------------------------------------------------------

async fn lease_job(pool: &DbPool, max_attempts: u32) -> Result<Option<LeasedJob>, String> {
    let val = pool
        .write(signet_core::db::Priority::Low, move |conn| {
            let ts = chrono::Utc::now().to_rfc3339();
            let mut stmt = conn.prepare_cached(
                "UPDATE memory_jobs SET status = 'leased', leased_at = ?1, updated_at = ?1, attempts = attempts + 1
                 WHERE id = (
                    SELECT id FROM memory_jobs
                    WHERE status = 'pending' AND attempts < ?2
                    ORDER BY created_at ASC LIMIT 1
                 ) RETURNING id, memory_id, job_type, payload, attempts",
            )?;

            let job = stmt
                .query_row(rusqlite::params![ts, max_attempts], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "memory_id": row.get::<_, Option<String>>(1)?,
                        "job_type": row.get::<_, String>(2)?,
                        "payload": row.get::<_, Option<String>>(3)?,
                        "attempts": row.get::<_, i64>(4)?,
                    }))
                })
                .ok();

            Ok(job.unwrap_or(serde_json::Value::Null))
        })
        .await
        .map_err(|e| e.to_string())?;

    if val.is_null() {
        Ok(None)
    } else {
        serde_json::from_value(val).map_err(|e| e.to_string())
    }
}

async fn complete_job(pool: &DbPool, job_id: &str, result: &str) -> Result<(), String> {
    let id = job_id.to_string();
    let result = result.to_string();
    pool.write(signet_core::db::Priority::Low, move |conn| {
        let ts = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE memory_jobs SET status = 'completed', result = ?1, completed_at = ?2, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![result, ts, id],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

async fn fail_job(pool: &DbPool, job_id: &str, error: &str) -> Result<(), String> {
    let id = job_id.to_string();
    let error = error.to_string();
    pool.write(signet_core::db::Priority::Low, move |conn| {
        let ts = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE memory_jobs SET status = 'pending', error = ?1, failed_at = ?2, updated_at = ?2, attempts = attempts + 1 WHERE id = ?3",
            rusqlite::params![error, ts, id],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}
