use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use anyhow::Context;
use axum::{Router, extract::State, response::Json, routing::get};
use chrono::{SecondsFormat, Utc};
use signet_core::config::{DaemonConfig, PipelineV2Config, network_mode_from_bind};
use signet_core::db::DbPool;
use tokio::signal;
use tracing::info;

#[allow(dead_code)] // Auth module built but not wired into routes until later phases
mod auth;
mod feedback;
mod mcp;
mod routes;
mod service;
mod state;

use auth::rate_limiter::{AuthRateLimiter, RateLimitRule, default_limits};
use auth::tokens::load_or_create_secret;
use auth::types::AuthMode;
use state::{AppState, ExtractionProviderResolution};

fn read_auth_mode(config: &DaemonConfig) -> AuthMode {
    config
        .manifest
        .auth
        .as_ref()
        .and_then(|auth| auth.mode.as_deref())
        .map(AuthMode::from_str_lossy)
        .unwrap_or_default()
}

fn merge_rate_limits(config: &DaemonConfig) -> HashMap<String, RateLimitRule> {
    let mut rules = default_limits();

    let Some(auth) = config.manifest.auth.as_ref() else {
        return rules;
    };
    let Some(raw) = auth.rate_limits.as_ref() else {
        return rules;
    };

    for (name, cfg) in raw {
        let Some(rule) = rules.get_mut(name) else {
            continue;
        };
        if let Some(window_ms) = cfg.window_ms.filter(|n| *n > 0) {
            rule.window_ms = window_ms;
        }
        if let Some(max) = cfg.max.filter(|n| *n > 0) {
            rule.max = max;
        }
    }

    rules
}

fn resolve_extraction_provider_runtime(
    pipeline_cfg: &PipelineV2Config,
    anthropic_key_present: bool,
    now_iso: &str,
) -> ExtractionProviderResolution {
    let configured = pipeline_cfg.extraction.provider.clone();
    let resolved = pipeline_cfg.extraction.provider.clone();
    let fallback_provider = pipeline_cfg.extraction.fallback_provider.clone();

    let mut effective = resolved.clone();
    let mut status: &'static str = "active";
    let mut degraded = false;
    let mut fallback_applied = false;
    let mut reason: Option<String> = None;
    let mut since: Option<String> = None;

    let mut apply_unavailable = |msg: String| {
        degraded = true;
        reason = Some(msg);
        since = Some(now_iso.to_string());
        if fallback_provider == "ollama" {
            effective = "ollama".to_string();
            status = "degraded";
            fallback_applied = true;
        } else {
            effective = "none".to_string();
            status = "blocked";
            fallback_applied = false;
        }
    };

    if !pipeline_cfg.enabled || resolved == "none" {
        effective = "none".to_string();
        status = "disabled";
    } else if pipeline_cfg.paused {
        effective = "none".to_string();
        status = "paused";
    } else {
        match resolved.as_str() {
            "ollama" => {}
            "anthropic" => {
                if !anthropic_key_present {
                    apply_unavailable("ANTHROPIC_API_KEY not found for extraction startup".to_string());
                }
            }
            "claude-code" | "codex" | "opencode" | "openrouter" => {
                apply_unavailable(format!(
                    "Extraction provider '{}' is not implemented in daemon-rs runtime",
                    resolved
                ));
            }
            _ => {
                apply_unavailable(format!(
                    "Unsupported extraction provider '{}' in daemon-rs runtime",
                    resolved
                ));
            }
        }
    }

    ExtractionProviderResolution {
        configured,
        resolved,
        effective,
        fallback_provider,
        status,
        degraded,
        fallback_applied,
        reason,
        since,
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();

    // Service management subcommands (no logging needed)
    if args.iter().any(|a| a == "--install-service") {
        let config = DaemonConfig::from_env();
        service::install(config.port)?;
        println!("signet service installed (port {})", config.port);
        return Ok(());
    }
    if args.iter().any(|a| a == "--uninstall-service") {
        service::uninstall()?;
        println!("signet service uninstalled");
        return Ok(());
    }
    if args.iter().any(|a| a == "--service-status") {
        let installed = service::is_installed();
        let running = service::is_running();
        println!("installed={installed} running={running}",);
        return Ok(());
    }

    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "signet_daemon=info,signet_core=info".into()),
        )
        .json()
        .init();

    // Load config
    let config = DaemonConfig::from_env();

    // --check-migrations: open DB, run migrations, exit (for benchmarking startup)
    if args.iter().any(|a| a == "--check-migrations") {
        let start = Instant::now();
        std::fs::create_dir_all(config.memory_dir())?;
        let (_pool, _handle) = DbPool::open(&config.db_path).context("failed to open database")?;
        let elapsed = start.elapsed();
        info!(
            elapsed_ms = elapsed.as_millis(),
            "migrations check complete"
        );
        println!("ok ({}ms)", elapsed.as_millis());
        return Ok(());
    }

    info!(
        port = config.port,
        host = %config.host,
        bind = %config.bind.as_deref().unwrap_or(&config.host),
        db = %config.db_path.display(),
        base = %config.base_path.display(),
        "starting signet daemon"
    );

    // Ensure directories
    std::fs::create_dir_all(config.memory_dir())?;
    std::fs::create_dir_all(config.logs_dir())?;

    // Open database (runs migrations, starts writer task)
    let (pool, writer_handle) = DbPool::open(&config.db_path).context("failed to open database")?;

    // Initialize embedding provider
    let pipeline_paused = config
        .manifest
        .memory
        .as_ref()
        .and_then(|m| m.pipeline_v2.as_ref())
        .map(|p| p.paused)
        .unwrap_or(false);
    let embedding = if pipeline_paused {
        info!("pipeline paused; embedding provider startup deferred");
        None
    } else {
        config
            .manifest
            .embedding
            .as_ref()
            .map(|cfg| signet_pipeline::embedding::from_config(cfg, None))
    };

    let auth_mode = read_auth_mode(&config);
    let auth_secret = if auth_mode == AuthMode::Local {
        info!("auth mode local, admin routes unrestricted on loopback runtime");
        None
    } else {
        let path = config.base_path.join(".daemon").join("auth-secret");
        Some(load_or_create_secret(&path).context("failed to load auth secret")?)
    };
    let auth_admin_limiter = AuthRateLimiter::from_rules(&merge_rate_limits(&config));

    let pipeline_cfg = config
        .manifest
        .memory
        .as_ref()
        .and_then(|m| m.pipeline_v2.as_ref())
        .cloned();

    let (extraction_provider_resolution, extraction_worker_stats, mut extraction_worker_handle) =
        if let Some(pipeline_cfg) = pipeline_cfg.as_ref() {
            let anthropic_key_present = std::env::var("ANTHROPIC_API_KEY")
                .ok()
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false);
            let now_iso = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
            let resolution =
                resolve_extraction_provider_runtime(pipeline_cfg, anthropic_key_present, &now_iso);
            let effective = resolution.effective.clone();

            if effective != "none" {
                let llm_cfg = signet_pipeline::provider::LlmProviderConfig {
                    provider: effective,
                    model: pipeline_cfg.extraction.model.clone(),
                    base_url: pipeline_cfg.extraction.endpoint.clone(),
                    api_key: std::env::var("ANTHROPIC_API_KEY").ok(),
                    timeout_ms: Some(pipeline_cfg.extraction.timeout),
                };
                let provider = signet_pipeline::provider::from_config(&llm_cfg);
                let semaphore = Arc::new(signet_pipeline::provider::LlmSemaphore::default());
                let worker_cfg = signet_pipeline::worker::WorkerConfig {
                    poll_ms: pipeline_cfg.worker.poll_ms,
                    max_retries: pipeline_cfg.worker.max_retries,
                    lease_timeout_ms: pipeline_cfg.worker.lease_timeout_ms,
                    max_load_per_cpu: pipeline_cfg.worker.max_load_per_cpu,
                    overload_backoff_ms: pipeline_cfg.worker.overload_backoff_ms,
                    extraction_timeout_ms: pipeline_cfg.extraction.timeout,
                    extraction_max_tokens: 4096,
                    min_confidence: pipeline_cfg.extraction.min_confidence,
                    shadow_mode: pipeline_cfg.shadow_mode,
                    graph_enabled: pipeline_cfg.graph.enabled,
                    structural_enabled: pipeline_cfg.structural.enabled,
                };
                let handle = signet_pipeline::worker::start(
                    pool.clone(),
                    provider,
                    semaphore,
                    worker_cfg,
                );
                info!("extraction worker started");
                (Some(resolution), Some(handle.stats_handle()), Some(handle))
            } else {
                info!("extraction worker disabled at startup by pipeline config");
                (Some(resolution), None, None)
            }
        } else {
            (None, None, None)
        };

    // Build app state
    let state = Arc::new(AppState::new(
        config.clone(),
        pool,
        embedding,
        extraction_worker_stats,
        extraction_provider_resolution,
        auth_mode,
        auth_secret,
        auth_admin_limiter,
    ));

    // Build router
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/status", get(status))
        // Memory read routes
        .route("/api/memories", get(routes::memory::list))
        .route(
            "/api/memory/{id}",
            get(routes::memory::get).delete(routes::write::delete),
        )
        .route("/api/memory/{id}/history", get(routes::memory::history))
        // Search routes
        .route(
            "/api/memory/recall",
            axum::routing::post(routes::search::recall),
        )
        .route("/api/memory/search", get(routes::search::search_get))
        .route("/memory/search", get(routes::search::legacy_search))
        .route("/api/embeddings", get(routes::search::embeddings_stats))
        // Write routes
        .route(
            "/api/memory/remember",
            axum::routing::post(routes::write::remember),
        )
        .route(
            "/api/memory/save",
            axum::routing::post(routes::write::remember),
        )
        .route(
            "/api/hook/remember",
            axum::routing::post(routes::write::remember),
        )
        .route(
            "/api/memory/{id}/recover",
            axum::routing::post(routes::write::recover),
        )
        .route(
            "/api/memory/modify",
            axum::routing::post(routes::write::modify_batch),
        )
        .route(
            "/api/memory/feedback",
            axum::routing::post(routes::memory::feedback),
        )
        // Config routes
        .route(
            "/api/config",
            get(routes::config::get_config).post(routes::config::save_config),
        )
        .route("/api/identity", get(routes::config::identity))
        .route("/api/features", get(routes::config::features))
        // Hook lifecycle routes
        .route(
            "/api/hooks/session-start",
            axum::routing::post(routes::hooks::session_start),
        )
        .route(
            "/api/hooks/user-prompt-submit",
            axum::routing::post(routes::hooks::prompt_submit),
        )
        .route(
            "/api/hooks/session-end",
            axum::routing::post(routes::hooks::session_end),
        )
        .route(
            "/api/hooks/remember",
            axum::routing::post(routes::hooks::remember),
        )
        .route(
            "/api/hooks/recall",
            axum::routing::post(routes::hooks::recall),
        )
        .route(
            "/api/hooks/pre-compaction",
            axum::routing::post(routes::hooks::pre_compaction),
        )
        .route(
            "/api/hooks/compaction-complete",
            axum::routing::post(routes::hooks::compaction_complete),
        )
        // Agent roster routes (multi-agent support — migration 043)
        .route(
            "/api/agents",
            get(routes::agents::list).post(routes::agents::create),
        )
        .route(
            "/api/agents/{name}",
            get(routes::agents::get).delete(routes::agents::delete),
        )
        // Session routes
        .route("/api/sessions", get(routes::sessions::list))
        .route("/api/sessions/summaries", get(routes::sessions::summaries))
        .route(
            "/api/sessions/checkpoints",
            get(routes::sessions::checkpoints),
        )
        .route(
            "/api/sessions/checkpoints/latest",
            get(routes::sessions::checkpoint_latest),
        )
        .route("/api/sessions/{key}", get(routes::sessions::get))
        .route(
            "/api/sessions/{key}/bypass",
            axum::routing::post(routes::sessions::bypass),
        )
        // Knowledge graph routes
        .route(
            "/api/knowledge/entities",
            get(routes::knowledge::list_entities),
        )
        .route(
            "/api/knowledge/entities/pinned",
            get(routes::knowledge::list_pinned),
        )
        .route(
            "/api/knowledge/entities/{id}",
            get(routes::knowledge::get_entity_detail),
        )
        .route(
            "/api/knowledge/entities/{id}/aspects",
            get(routes::knowledge::get_aspects),
        )
        .route(
            "/api/knowledge/entities/{id}/aspects/{aspect_id}/attributes",
            get(routes::knowledge::get_attributes),
        )
        .route(
            "/api/knowledge/entities/{id}/dependencies",
            get(routes::knowledge::get_dependencies),
        )
        .route(
            "/api/knowledge/entities/{id}/pin",
            axum::routing::post(routes::knowledge::pin_entity)
                .delete(routes::knowledge::unpin_entity),
        )
        .route("/api/knowledge/stats", get(routes::knowledge::stats))
        .route(
            "/api/knowledge/constellation",
            get(routes::knowledge::constellation),
        )
        // Pipeline routes
        .route("/api/pipeline/status", get(routes::pipeline::status))
        .route(
            "/api/pipeline/pause",
            axum::routing::post(routes::pipeline::pause),
        )
        .route(
            "/api/pipeline/resume",
            axum::routing::post(routes::pipeline::resume),
        )
        .route("/api/pipeline/models", get(routes::pipeline::models))
        .route(
            "/api/pipeline/models/by-provider",
            get(routes::pipeline::models_by_provider),
        )
        .route(
            "/api/pipeline/models/refresh",
            axum::routing::post(routes::pipeline::models_refresh),
        )
        // Predictor routes
        .route("/api/predictor/status", get(routes::predictor::status))
        .route(
            "/api/predictor/comparisons",
            get(routes::predictor::comparisons),
        )
        .route(
            "/api/predictor/comparisons/by-project",
            get(routes::predictor::comparisons_by_project),
        )
        .route(
            "/api/predictor/comparisons/by-entity",
            get(routes::predictor::comparisons_by_entity),
        )
        .route("/api/predictor/training", get(routes::predictor::training))
        .route(
            "/api/predictor/training-pairs-count",
            get(routes::predictor::training_pairs_count),
        )
        .route(
            "/api/predictor/train",
            axum::routing::post(routes::predictor::train),
        )
        // Timeline routes
        .route("/api/memory/timeline", get(routes::timeline::activity))
        .route("/api/timeline/{id}", get(routes::timeline::incident))
        .route("/api/timeline/{id}/export", get(routes::timeline::export))
        // Repair routes
        .route(
            "/api/repair/requeue-dead",
            axum::routing::post(routes::repair::requeue_dead),
        )
        .route(
            "/api/repair/release-leases",
            axum::routing::post(routes::repair::release_leases),
        )
        .route(
            "/api/repair/check-fts",
            axum::routing::post(routes::repair::check_fts),
        )
        .route(
            "/api/repair/retention-sweep",
            axum::routing::post(routes::repair::retention_sweep),
        )
        .route(
            "/api/repair/embedding-gaps",
            get(routes::repair::embedding_gaps),
        )
        .route(
            "/api/repair/re-embed",
            axum::routing::post(routes::repair::re_embed),
        )
        .route(
            "/api/repair/resync-vec",
            axum::routing::post(routes::repair::resync_vec),
        )
        .route(
            "/api/repair/clean-orphans",
            axum::routing::post(routes::repair::clean_orphans),
        )
        .route("/api/repair/dedup-stats", get(routes::repair::dedup_stats))
        .route(
            "/api/repair/deduplicate",
            axum::routing::post(routes::repair::deduplicate),
        )
        .route(
            "/api/repair/backfill-skipped",
            axum::routing::post(routes::repair::backfill_skipped),
        )
        .route(
            "/api/repair/reclassify-entities",
            axum::routing::post(routes::repair::reclassify_entities),
        )
        .route(
            "/api/repair/prune-chunk-groups",
            axum::routing::post(routes::repair::prune_chunk_groups),
        )
        .route(
            "/api/repair/prune-singleton-entities",
            axum::routing::post(routes::repair::prune_singletons),
        )
        .route(
            "/api/repair/structural-backfill",
            axum::routing::post(routes::repair::structural_backfill),
        )
        .route("/api/repair/cold-stats", get(routes::repair::cold_stats))
        // MCP endpoint
        .route("/mcp", axum::routing::post(mcp::transport::handle))
        // Marketplace routes
        .route(
            "/api/marketplace/mcp",
            get(routes::marketplace::list_servers),
        )
        .route(
            "/api/marketplace/mcp/policy",
            get(routes::marketplace::get_policy).patch(routes::marketplace::set_policy),
        )
        .route(
            "/api/marketplace/mcp/tools",
            get(routes::marketplace::list_tools),
        )
        .route(
            "/api/marketplace/mcp/search",
            get(routes::marketplace::search_tools),
        )
        .route(
            "/api/marketplace/mcp/call",
            axum::routing::post(routes::marketplace::call_tool),
        )
        .route(
            "/api/marketplace/mcp/register",
            axum::routing::post(routes::marketplace::register_server),
        )
        .route(
            "/api/marketplace/mcp/browse",
            get(routes::marketplace::browse_catalog),
        )
        .route(
            "/api/marketplace/mcp/install",
            axum::routing::post(routes::marketplace::install_from_catalog),
        )
        .route(
            "/api/marketplace/mcp/test",
            axum::routing::post(routes::marketplace::test_config),
        )
        .route(
            "/api/marketplace/mcp/detail",
            get(routes::marketplace::catalog_detail),
        )
        .route(
            "/api/marketplace/mcp/{id}",
            get(routes::marketplace::get_server)
                .patch(routes::marketplace::update_server)
                .delete(routes::marketplace::delete_server),
        )
        // Secrets routes
        .route("/api/secrets", get(routes::secrets::list))
        .route(
            "/api/secrets/exec",
            axum::routing::post(routes::secrets::run_with_secrets),
        )
        .route(
            "/api/secrets/{name}",
            axum::routing::post(routes::secrets::put).delete(routes::secrets::delete),
        )
        // Scheduler routes
        .route(
            "/api/tasks",
            get(routes::scheduler::list).post(routes::scheduler::create),
        )
        .route(
            "/api/tasks/{id}",
            get(routes::scheduler::get)
                .patch(routes::scheduler::update)
                .delete(routes::scheduler::delete),
        )
        .route(
            "/api/tasks/{id}/run",
            axum::routing::post(routes::scheduler::trigger),
        )
        .route("/api/tasks/{id}/runs", get(routes::scheduler::runs))
        // Git routes
        .route("/api/git/status", get(routes::git::status))
        .route("/api/git/pull", axum::routing::post(routes::git::pull))
        .route("/api/git/push", axum::routing::post(routes::git::push))
        .route("/api/git/sync", axum::routing::post(routes::git::sync))
        .route(
            "/api/git/config",
            get(routes::git::get_config).post(routes::git::set_config),
        )
        // Cross-agent routes
        .route(
            "/api/cross-agent/presence",
            get(routes::crossagent::list_presence).post(routes::crossagent::upsert_presence),
        )
        .route(
            "/api/cross-agent/presence/{key}",
            axum::routing::delete(routes::crossagent::remove_presence),
        )
        .route(
            "/api/cross-agent/messages",
            get(routes::crossagent::list_messages).post(routes::crossagent::send_message),
        )
        // Connector routes
        .route(
            "/api/connectors",
            get(routes::connectors::list).post(routes::connectors::create),
        )
        .route(
            "/api/connectors/{id}",
            get(routes::connectors::get).delete(routes::connectors::delete),
        )
        .route(
            "/api/connectors/{id}/sync",
            axum::routing::post(routes::connectors::sync),
        )
        // Document routes
        .route(
            "/api/documents",
            get(routes::documents::list).post(routes::documents::ingest),
        )
        .route(
            "/api/documents/{id}",
            get(routes::documents::get).delete(routes::documents::delete),
        )
        .route("/api/documents/{id}/chunks", get(routes::documents::chunks))
        // Diagnostics routes
        .route("/api/diagnostics", get(routes::diagnostics::report))
        .route(
            "/api/diagnostics/{domain}",
            get(routes::diagnostics::domain),
        )
        .route("/api/logs", get(routes::diagnostics::logs))
        .route("/api/version", get(routes::diagnostics::version))
        .route("/api/update", get(routes::diagnostics::update_status))
        .with_state(state.clone());

    // Bind — use string form so "localhost" resolves via DNS
    let bind_host = config.bind.as_deref().unwrap_or(&config.host);
    let bind_addr = format!("{bind_host}:{}", config.port);

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .context("failed to bind")?;

    let addr = listener.local_addr()?;
    info!(%addr, "listening");

    // Serve with graceful shutdown
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .context("server error")?;

    info!("shutting down");
    if let Some(worker) = extraction_worker_handle.take() {
        worker.stop().await;
    }

    // Drop state to close DB channels, then await writer
    drop(state);
    let _ = writer_handle.await;

    info!("shutdown complete");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c().await.expect("failed to listen for ctrl+c");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to listen for SIGTERM")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => info!("received ctrl+c"),
        () = terminate => info!("received SIGTERM"),
    }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

fn current_epoch_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn iso_from_epoch_ms(ms: i64) -> Option<String> {
    chrono::DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
}

async fn status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let bind = state.config.bind.as_deref().unwrap_or(&state.config.host);
    let pipeline = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|memory| memory.pipeline_v2.as_ref());
    let extraction = pipeline.map(|pipeline| {
        if let Some(resolution) = state.extraction_provider_resolution.as_ref() {
            let paused = pipeline.paused || state.pipeline_paused();
            let status = if paused && resolution.status != "disabled" && resolution.status != "blocked" {
                "paused"
            } else {
                resolution.status
            };
            let effective = if status == "paused" {
                "none".to_string()
            } else {
                resolution.effective.clone()
            };
            serde_json::json!({
                "configured": resolution.configured.clone(),
                "resolved": resolution.resolved.clone(),
                "effective": effective,
                "fallbackProvider": resolution.fallback_provider.clone(),
                "status": status,
                "degraded": if status == "paused" { false } else { resolution.degraded },
                "fallbackApplied": if status == "paused" { false } else { resolution.fallback_applied },
                "reason": if status == "paused" { serde_json::Value::Null } else { resolution.reason.clone().map(serde_json::Value::String).unwrap_or(serde_json::Value::Null) },
                "since": if status == "paused" { serde_json::Value::Null } else { resolution.since.clone().map(serde_json::Value::String).unwrap_or(serde_json::Value::Null) },
            })
        } else {
            let extraction = &pipeline.extraction;
            let status = if !pipeline.enabled || extraction.provider == "none" {
                "disabled"
            } else if pipeline.paused || state.pipeline_paused() {
                "paused"
            } else {
                "active"
            };
            serde_json::json!({
                "configured": extraction.provider,
                "resolved": extraction.provider,
                "effective": extraction.provider,
                "fallbackProvider": extraction.fallback_provider,
                "status": status,
                "degraded": false,
                "fallbackApplied": false,
                "reason": serde_json::Value::Null,
                "since": serde_json::Value::Null,
            })
        }
    });
    let extraction_worker = if let Some(pipeline) = pipeline {
        let snapshot = if let Some(stats) = state.extraction_worker_stats.as_ref() {
            stats.lock().await.snapshot(current_epoch_ms())
        } else {
            signet_pipeline::worker::WorkerRuntimeSnapshot {
                running: false,
                overloaded: false,
                load_per_cpu: None,
                overload_since_ms: None,
                next_tick_in_ms: None,
                max_load_per_cpu: pipeline.worker.max_load_per_cpu,
                overload_backoff_ms: pipeline.worker.overload_backoff_ms,
            }
        };
        let paused = pipeline.paused || state.pipeline_paused();
        let running = snapshot.running && !paused;
        let overloaded = running && snapshot.overloaded;
        let overload_since = if overloaded {
            snapshot.overload_since_ms.and_then(iso_from_epoch_ms)
        } else {
            None
        };
        Some(serde_json::json!({
            "running": running,
            "overloaded": overloaded,
            "loadPerCpu": if running { snapshot.load_per_cpu } else { None },
            "maxLoadPerCpu": snapshot.max_load_per_cpu,
            "overloadBackoffMs": snapshot.overload_backoff_ms,
            "overloadSince": overload_since,
            "nextTickInMs": if running { snapshot.next_tick_in_ms } else { None },
        }))
    } else {
        None
    };
    let db_stats = state
        .pool
        .read(|conn| {
            let memories: i64 = conn
                .query_row("SELECT count(*) FROM memories", [], |r| r.get(0))
                .unwrap_or(0);
            let entities: i64 = conn
                .query_row("SELECT count(*) FROM entities", [], |r| r.get(0))
                .unwrap_or(0);
            let embeddings: i64 = conn
                .query_row("SELECT count(*) FROM embeddings", [], |r| r.get(0))
                .unwrap_or(0);
            let schema_version: i64 = conn
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| {
                    r.get(0)
                })
                .unwrap_or(0);

            Ok(serde_json::json!({
                "memories": memories,
                "entities": entities,
                "embeddings": embeddings,
                "schemaVersion": schema_version,
            }))
        })
        .await
        .unwrap_or_else(|_| serde_json::json!({"error": "db unavailable"}));

    Json(serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "port": state.config.port,
        "host": state.config.host,
        "bindHost": bind,
        "networkMode": network_mode_from_bind(bind),
        "db": db_stats,
        "agent": state.config.manifest.agent.name,
        "pipeline": {
            "extraction": extraction_worker,
        },
        "providerResolution": {
            "extraction": extraction,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::resolve_extraction_provider_runtime;
    use signet_core::config::PipelineV2Config;

    fn base_pipeline(provider: &str, fallback: &str) -> PipelineV2Config {
        let mut cfg = PipelineV2Config::default();
        cfg.enabled = true;
        cfg.paused = false;
        cfg.extraction.provider = provider.to_string();
        cfg.extraction.fallback_provider = fallback.to_string();
        cfg
    }

    #[test]
    fn unsupported_provider_respects_fallback_none() {
        let cfg = base_pipeline("codex", "none");
        let resolution =
            resolve_extraction_provider_runtime(&cfg, false, "2026-03-26T00:00:00.000Z");

        assert_eq!(resolution.effective, "none");
        assert_eq!(resolution.status, "blocked");
        assert!(resolution.degraded);
        assert!(!resolution.fallback_applied);
        assert!(resolution.reason.is_some());
        assert!(resolution.since.is_some());
    }

    #[test]
    fn unsupported_provider_respects_fallback_ollama() {
        let cfg = base_pipeline("codex", "ollama");
        let resolution =
            resolve_extraction_provider_runtime(&cfg, false, "2026-03-26T00:00:00.000Z");

        assert_eq!(resolution.effective, "ollama");
        assert_eq!(resolution.status, "degraded");
        assert!(resolution.degraded);
        assert!(resolution.fallback_applied);
    }
}
