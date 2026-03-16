//! Summary worker: session-end summarization and fact extraction.
//!
//! Polls `summary_jobs` for completed sessions, calls LLM to produce
//! markdown summaries and extract key facts, writes results to DB.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tracing::{info, warn};

use signet_core::db::DbPool;

use crate::provider::{GenerateOpts, LlmProvider, LlmSemaphore};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// Configuration for the summary worker.
#[derive(Debug, Clone)]
pub struct SummaryConfig {
    pub poll_ms: u64,
    pub max_retries: u32,
    pub max_tokens: u32,
    pub timeout_ms: u64,
    pub min_message_count: usize,
    pub chunk_size: usize,
}

impl Default for SummaryConfig {
    fn default() -> Self {
        Self {
            poll_ms: 5_000,
            max_retries: 3,
            max_tokens: 4096,
            timeout_ms: 120_000,
            min_message_count: 3,
            chunk_size: 20_000,
        }
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A leased summary job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryJob {
    pub id: String,
    pub session_key: String,
    pub transcript: Option<String>,
    pub project: Option<String>,
    pub attempts: i64,
}

/// Result of summary processing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryResult {
    pub facts_extracted: usize,
    pub summary_length: usize,
    pub chunks_processed: usize,
}

// ---------------------------------------------------------------------------
// Worker handle
// ---------------------------------------------------------------------------

/// Handle for controlling the summary worker.
pub struct SummaryHandle {
    shutdown: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl SummaryHandle {
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.handle.await;
    }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/// Start the summary worker.
pub fn start(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: SummaryConfig,
) -> SummaryHandle {
    let (tx, rx) = watch::channel(false);
    let handle = tokio::spawn(worker_loop(pool, provider, semaphore, config, rx));
    SummaryHandle {
        shutdown: tx,
        handle,
    }
}

async fn worker_loop(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: SummaryConfig,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut failures: u32 = 0;
    let base = Duration::from_millis(config.poll_ms);
    let max = Duration::from_secs(120);

    info!(poll_ms = config.poll_ms, "summary worker started");

    loop {
        if *shutdown.borrow() {
            info!("summary worker shutting down");
            break;
        }

        let delay = if failures > 0 {
            (base * 2u32.pow(failures.min(6))).min(max)
        } else {
            base
        };

        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = shutdown.changed() => {
                info!("summary worker shutting down");
                break;
            }
        }

        // Lease a summary job
        let job = match lease_summary_job(&pool, config.max_retries).await {
            Ok(Some(j)) => j,
            Ok(None) => continue,
            Err(e) => {
                warn!(err = %e, "failed to lease summary job");
                failures += 1;
                continue;
            }
        };

        info!(job_id = %job.id, session = %job.session_key, "processing summary job");

        match process_summary(&pool, &job, &provider, &semaphore, &config).await {
            Ok(result) => {
                failures = 0;
                let json = serde_json::to_string(&result).unwrap_or_default();
                if let Err(e) = complete_summary_job(&pool, &job.id, &json).await {
                    warn!(err = %e, job_id = %job.id, "failed to complete summary job");
                }
                info!(
                    job_id = %job.id,
                    facts = result.facts_extracted,
                    length = result.summary_length,
                    "summary completed"
                );
            }
            Err(e) => {
                failures += 1;
                warn!(err = %e, job_id = %job.id, "summary job failed");
                if let Err(fe) = fail_summary_job(&pool, &job.id, &e).await {
                    warn!(err = %fe, "failed to record summary failure");
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Job processing
// ---------------------------------------------------------------------------

async fn process_summary(
    _pool: &DbPool,
    job: &SummaryJob,
    provider: &Arc<dyn LlmProvider>,
    semaphore: &Arc<LlmSemaphore>,
    config: &SummaryConfig,
) -> Result<SummaryResult, String> {
    let transcript = job
        .transcript
        .as_deref()
        .ok_or("summary job missing transcript")?;

    if transcript.trim().len() < 50 {
        return Ok(SummaryResult {
            facts_extracted: 0,
            summary_length: 0,
            chunks_processed: 0,
        });
    }

    // Split into chunks for context window
    let chunks: Vec<&str> = transcript
        .as_bytes()
        .chunks(config.chunk_size)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .filter(|c| !c.is_empty())
        .collect();

    let mut total_facts = 0;
    let mut total_length = 0;

    for (i, chunk) in chunks.iter().enumerate() {
        let prompt = build_summary_prompt(chunk, i, chunks.len());
        let opts = GenerateOpts {
            timeout_ms: Some(config.timeout_ms),
            max_tokens: Some(config.max_tokens),
        };

        let provider = provider.clone();
        let raw = semaphore
            .run(async { provider.generate(&prompt, &opts).await })
            .await
            .map_err(|e| format!("LLM summary failed: {e}"))?;

        total_length += raw.text.len();

        // Parse facts from summary output
        let parsed = crate::extraction::parse(&raw.text);
        total_facts += parsed.facts.len();

        // TODO: Phase 5.3 — write summary to file, insert facts, update session_summaries DAG
    }

    Ok(SummaryResult {
        facts_extracted: total_facts,
        summary_length: total_length,
        chunks_processed: chunks.len(),
    })
}

fn build_summary_prompt(chunk: &str, index: usize, total: usize) -> String {
    let part = if total > 1 {
        format!(" (part {}/{})", index + 1, total)
    } else {
        String::new()
    };

    format!(
        r#"Summarize this session transcript{part} into:
1. A concise markdown summary (2-5 paragraphs)
2. Key facts extracted (JSON array with "content", "type", "confidence")

Focus on decisions made, preferences expressed, and important context.
Skip routine interactions and obvious statements.

Transcript:
{chunk}

Respond with a JSON object containing "summary" (string) and "facts" (array)."#
    )
}

// ---------------------------------------------------------------------------
// Job queue
// ---------------------------------------------------------------------------

async fn lease_summary_job(pool: &DbPool, max_attempts: u32) -> Result<Option<SummaryJob>, String> {
    let val = pool
        .write(signet_core::db::Priority::Low, move |conn| {
            let ts = chrono::Utc::now().to_rfc3339();
            let mut stmt = conn.prepare_cached(
                "UPDATE summary_jobs SET status = 'leased', leased_at = ?1, updated_at = ?1, attempts = attempts + 1
                 WHERE id = (
                    SELECT id FROM summary_jobs
                    WHERE status = 'pending' AND attempts < ?2
                    ORDER BY created_at ASC LIMIT 1
                 ) RETURNING id, session_key, transcript, project, attempts",
            )?;

            let job = stmt
                .query_row(rusqlite::params![ts, max_attempts], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "session_key": row.get::<_, String>(1)?,
                        "transcript": row.get::<_, Option<String>>(2)?,
                        "project": row.get::<_, Option<String>>(3)?,
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

async fn complete_summary_job(pool: &DbPool, job_id: &str, result: &str) -> Result<(), String> {
    let id = job_id.to_string();
    let result = result.to_string();
    pool.write(signet_core::db::Priority::Low, move |conn| {
        let ts = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE summary_jobs SET status = 'completed', result = ?1, completed_at = ?2, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![result, ts, id],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

async fn fail_summary_job(pool: &DbPool, job_id: &str, error: &str) -> Result<(), String> {
    let id = job_id.to_string();
    let error = error.to_string();
    pool.write(signet_core::db::Priority::Low, move |conn| {
        let ts = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE summary_jobs SET status = 'pending', error = ?1, failed_at = ?2, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![error, ts, id],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}
