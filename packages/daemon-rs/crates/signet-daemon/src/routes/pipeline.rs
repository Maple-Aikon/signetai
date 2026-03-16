//! Pipeline status and model management routes.

use std::sync::Arc;

use axum::{extract::State, response::Json};

use crate::state::AppState;

/// GET /api/pipeline/status — pipeline worker and queue status.
pub async fn status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let queues = state
        .pool
        .read(|conn| {
            let memory_pending: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_jobs WHERE status = 'pending'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let memory_leased: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_jobs WHERE status = 'leased'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let memory_completed: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_jobs WHERE status = 'completed'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let memory_failed: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_jobs WHERE status = 'failed'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let memory_dead: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_jobs WHERE status = 'dead'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            // Summary queue (table may not exist yet)
            let summary_pending: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM summary_jobs WHERE status = 'pending'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let summary_leased: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM summary_jobs WHERE status = 'leased'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let summary_completed: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM summary_jobs WHERE status = 'completed'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            Ok(serde_json::json!({
                "memory": {
                    "pending": memory_pending,
                    "leased": memory_leased,
                    "completed": memory_completed,
                    "failed": memory_failed,
                    "dead": memory_dead,
                },
                "summary": {
                    "pending": summary_pending,
                    "leased": summary_leased,
                    "completed": summary_completed,
                }
            }))
        })
        .await
        .unwrap_or_else(|_| serde_json::json!({}));

    let pipeline = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|m| m.pipeline_v2.as_ref());

    let mode = match pipeline {
        Some(p) if p.mutations_frozen => "frozen",
        Some(p) if p.shadow_mode => "shadow",
        Some(p) if p.enabled => "controlled-write",
        _ => "disabled",
    };

    Json(serde_json::json!({
        "queues": queues,
        "mode": mode,
        "predictor": {
            "running": false,
            "modelReady": false,
            "coldStartExited": false,
        },
    }))
}

/// GET /api/pipeline/models — list available LLM models.
pub async fn models(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let extraction = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|m| m.pipeline_v2.as_ref())
        .map(|p| &p.extraction);

    let provider = extraction.map(|e| e.provider.as_str()).unwrap_or("ollama");
    let model = extraction.map(|e| e.model.as_str()).unwrap_or("qwen3:4b");

    Json(serde_json::json!({
        "models": [
            {
                "name": model,
                "provider": provider,
                "active": true,
            }
        ],
    }))
}

/// GET /api/pipeline/models/by-provider — models grouped by provider.
pub async fn models_by_provider(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let extraction = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|m| m.pipeline_v2.as_ref())
        .map(|p| &p.extraction);

    let provider = extraction.map(|e| e.provider.as_str()).unwrap_or("ollama");
    let model = extraction.map(|e| e.model.as_str()).unwrap_or("qwen3:4b");

    let mut result = serde_json::Map::new();
    result.insert(
        provider.to_string(),
        serde_json::json!([{ "name": model, "active": true }]),
    );

    Json(serde_json::Value::Object(result))
}

/// POST /api/pipeline/models/refresh — refresh model registry.
pub async fn models_refresh(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    // TODO: Query Ollama /api/tags and Anthropic for available models
    models(State(state)).await
}
