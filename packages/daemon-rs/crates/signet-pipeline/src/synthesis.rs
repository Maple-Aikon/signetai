//! Synthesis worker: MEMORY.md regeneration from session summaries.
//!
//! Activity-triggered worker that consolidates session summaries
//! into a unified MEMORY.md file. Uses exclusive write lock pattern.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{Mutex, watch};
use tracing::{info, warn};

use signet_core::db::DbPool;

use crate::provider::{GenerateOpts, LlmProvider, LlmSemaphore};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// Configuration for the synthesis worker.
#[derive(Debug, Clone)]
pub struct SynthesisConfig {
    pub poll_ms: u64,
    pub min_interval_secs: u64,
    pub timeout_ms: u64,
    pub max_tokens: u32,
    pub agents_dir: String,
}

impl Default for SynthesisConfig {
    fn default() -> Self {
        Self {
            poll_ms: 30_000,         // 30s
            min_interval_secs: 3600, // 1 hour min between syntheses
            timeout_ms: 120_000,
            max_tokens: 8192,
            agents_dir: std::env::var("SIGNET_PATH").unwrap_or_else(|_| {
                std::env::var("HOME")
                    .map(|h| format!("{h}/.agents"))
                    .unwrap_or_else(|_| "~/.agents".into())
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Result of synthesis.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisResult {
    pub summary_count: usize,
    pub output_length: usize,
    pub duration_ms: u64,
}

// ---------------------------------------------------------------------------
// Worker handle
// ---------------------------------------------------------------------------

pub struct SynthesisHandle {
    shutdown: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl SynthesisHandle {
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.handle.await;
    }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

pub fn start(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: SynthesisConfig,
) -> SynthesisHandle {
    let (tx, rx) = watch::channel(false);
    let handle = tokio::spawn(worker_loop(pool, provider, semaphore, config, rx));
    SynthesisHandle {
        shutdown: tx,
        handle,
    }
}

async fn worker_loop(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: SynthesisConfig,
    mut shutdown: watch::Receiver<bool>,
) {
    let write_lock: Arc<Mutex<()>> = Arc::new(Mutex::new(()));
    let mut last_synthesis: Option<std::time::Instant> = None;
    let base = Duration::from_millis(config.poll_ms);

    info!(poll_ms = config.poll_ms, "synthesis worker started");

    loop {
        tokio::select! {
            _ = tokio::time::sleep(base) => {}
            _ = shutdown.changed() => {
                info!("synthesis worker shutting down");
                break;
            }
        }

        if *shutdown.borrow() {
            break;
        }

        // Enforce minimum interval
        if let Some(last) = last_synthesis
            && last.elapsed() < Duration::from_secs(config.min_interval_secs)
        {
            continue;
        }

        // Check if synthesis is needed (any new summaries since last run)
        let needs_synthesis = match check_synthesis_needed(&pool, &last_synthesis).await {
            Ok(needed) => needed,
            Err(e) => {
                warn!(err = %e, "failed to check synthesis need");
                continue;
            }
        };

        if !needs_synthesis {
            continue;
        }

        // Acquire exclusive write lock
        let _guard = write_lock.lock().await;

        info!("starting MEMORY.md synthesis");
        let start = std::time::Instant::now();

        match run_synthesis(&pool, &provider, &semaphore, &config).await {
            Ok(result) => {
                last_synthesis = Some(std::time::Instant::now());
                info!(
                    summaries = result.summary_count,
                    length = result.output_length,
                    duration_ms = start.elapsed().as_millis() as u64,
                    "synthesis completed"
                );
            }
            Err(e) => {
                warn!(err = %e, "synthesis failed");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async fn check_synthesis_needed(
    pool: &DbPool,
    last_run: &Option<std::time::Instant>,
) -> Result<bool, String> {
    if last_run.is_none() {
        // First run — check if any summaries exist
        let count: usize = pool
            .read(|conn| {
                Ok(conn
                    .query_row("SELECT COUNT(*) FROM session_summaries", [], |r| r.get(0))
                    .unwrap_or(0))
            })
            .await
            .map_err(|e| e.to_string())?;
        return Ok(count > 0);
    }

    // Check for new completed summary jobs since last run
    let count: usize = pool
        .read(|conn| {
            Ok(conn
                .query_row(
                    "SELECT COUNT(*) FROM summary_jobs WHERE status = 'completed' AND completed_at > datetime('now', '-1 hour')",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0))
        })
        .await
        .map_err(|e| e.to_string())?;

    Ok(count > 0)
}

async fn run_synthesis(
    pool: &DbPool,
    provider: &Arc<dyn LlmProvider>,
    semaphore: &Arc<LlmSemaphore>,
    config: &SynthesisConfig,
) -> Result<SynthesisResult, String> {
    let start = std::time::Instant::now();

    // Load all session summaries
    let summaries = pool
        .read(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT summary, project, created_at FROM session_summaries ORDER BY created_at DESC LIMIT 50",
            )?;
            let rows: Vec<(String, Option<String>, String)> = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        })
        .await
        .map_err(|e| e.to_string())?;

    if summaries.is_empty() {
        return Ok(SynthesisResult {
            summary_count: 0,
            output_length: 0,
            duration_ms: start.elapsed().as_millis() as u64,
        });
    }

    let summary_count = summaries.len();

    // Build synthesis prompt
    let prompt = build_synthesis_prompt(&summaries);
    let opts = GenerateOpts {
        timeout_ms: Some(config.timeout_ms),
        max_tokens: Some(config.max_tokens),
    };

    let p = provider.clone();
    let raw = semaphore
        .run(async { p.generate(&prompt, &opts).await })
        .await
        .map_err(|e| format!("LLM synthesis failed: {e}"))?;

    // Validate output is markdown (not JSON error)
    let output = &raw.text;
    if output.starts_with('{') || output.starts_with('[') {
        return Err("synthesis produced JSON instead of markdown".into());
    }

    // Write MEMORY.md
    let memory_path = format!("{}/MEMORY.md", config.agents_dir);
    tokio::fs::write(&memory_path, output)
        .await
        .map_err(|e| format!("failed to write MEMORY.md: {e}"))?;

    Ok(SynthesisResult {
        summary_count,
        output_length: output.len(),
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

fn build_synthesis_prompt(summaries: &[(String, Option<String>, String)]) -> String {
    let entries: String = summaries
        .iter()
        .map(|(summary, project, date)| {
            let proj = project.as_deref().unwrap_or("general");
            format!("### [{date}] ({proj})\n{summary}\n")
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"You are a knowledge librarian. Synthesize the following session summaries into a unified MEMORY.md document.

Structure the document with clear markdown sections. Group related information together.
Focus on:
- Key decisions and their rationale
- User preferences and patterns
- Active projects and their status
- Important facts and constraints

Session summaries (most recent first):

{entries}

Write the MEMORY.md document in clean markdown format. Do not include JSON or code fences."#
    )
}
