//! Pipeline status and model management routes.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json},
};
use signet_core::config::PipelineV2Config;
use serde_yml::{Mapping, Value};

use crate::state::AppState;

const PIPELINE_CONFIG_FILES: [&str; 3] = ["agent.yaml", "AGENT.yaml", "config.yaml"];

#[derive(Clone, Copy)]
struct PipelineMode {
    enabled: bool,
    frozen: bool,
    paused: bool,
    shadow: bool,
}

fn find_config_file(base: &Path) -> Option<PathBuf> {
    PIPELINE_CONFIG_FILES
        .iter()
        .map(|name| base.join(name))
        .find(|path| path.exists())
}

fn key(name: &str) -> Value {
    Value::String(name.to_string())
}

fn read_mapping<'a>(map: &'a Mapping, name: &str) -> Option<&'a Mapping> {
    map.get(&key(name)).and_then(Value::as_mapping)
}

fn read_bool(map: &Mapping, name: &str) -> Option<bool> {
    map.get(&key(name)).and_then(Value::as_bool)
}

fn read_pipeline_mode_from_value(
    value: &Value,
    fallback: Option<&PipelineV2Config>,
) -> PipelineMode {
    let mut mode = PipelineMode {
        enabled: fallback.map(|cfg| cfg.enabled).unwrap_or(false),
        paused: fallback.map(|cfg| cfg.paused).unwrap_or(false),
        frozen: fallback.map(|cfg| cfg.mutations_frozen).unwrap_or(false),
        shadow: fallback.map(|cfg| cfg.shadow_mode).unwrap_or(false),
    };

    let Some(root) = value.as_mapping() else {
        return mode;
    };
    let Some(mem) = read_mapping(root, "memory") else {
        return mode;
    };
    let Some(p2) = read_mapping(mem, "pipelineV2") else {
        return mode;
    };

    if let Some(enabled) = read_bool(p2, "enabled") {
        mode.enabled = enabled;
    }
    if let Some(paused) = read_bool(p2, "paused") {
        mode.paused = paused;
    }
    if let Some(frozen) = read_bool(p2, "mutationsFrozen") {
        mode.frozen = frozen;
    }
    if let Some(shadow) = read_bool(p2, "shadowMode") {
        mode.shadow = shadow;
    }

    mode
}

fn read_pipeline_mode(base: &Path, fallback: Option<&PipelineV2Config>) -> PipelineMode {
    let Some(path) = find_config_file(base) else {
        return read_pipeline_mode_from_value(&Value::Null, fallback);
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return read_pipeline_mode_from_value(&Value::Null, fallback);
    };
    let Ok(value) = serde_yml::from_str::<Value>(&raw) else {
        return read_pipeline_mode_from_value(&Value::Null, fallback);
    };
    read_pipeline_mode_from_value(&value, fallback)
}

fn format_pipeline_mode(mode: PipelineMode) -> &'static str {
    if !mode.enabled {
        return "disabled";
    }
    if mode.paused {
        return "paused";
    }
    if mode.frozen {
        return "frozen";
    }
    if mode.shadow {
        return "shadow";
    }
    "controlled-write"
}

fn set_pipeline_paused(
    base: &Path,
    paused: bool,
    fallback: Option<&PipelineV2Config>,
) -> Result<(String, bool, PipelineMode), String> {
    let path = find_config_file(base)
        .ok_or_else(|| "No Signet config file found. Run `signet setup` first.".to_string())?;
    let raw = std::fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let value = serde_yml::from_str::<Value>(&raw).map_err(|err| err.to_string())?;

    let mut root = match value {
        Value::Mapping(map) => map,
        _ => Mapping::new(),
    };
    let mut mem = match root.remove(&key("memory")) {
        Some(Value::Mapping(map)) => map,
        _ => Mapping::new(),
    };
    let mut p2 = match mem.remove(&key("pipelineV2")) {
        Some(Value::Mapping(map)) => map,
        _ => Mapping::new(),
    };

    let prev = read_bool(&p2, "paused").unwrap_or(false);
    p2.insert(key("paused"), Value::Bool(paused));
    mem.insert(key("pipelineV2"), Value::Mapping(p2));
    root.insert(key("memory"), Value::Mapping(mem));

    let next = Value::Mapping(root);
    let body = serde_yml::to_string(&next).map_err(|err| err.to_string())?;
    std::fs::write(&path, body).map_err(|err| err.to_string())?;

    Ok((
        path.to_string_lossy().to_string(),
        prev != paused,
        read_pipeline_mode_from_value(&next, fallback),
    ))
}

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
    let mode = format_pipeline_mode(read_pipeline_mode(state.config.base_path.as_path(), pipeline));

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

pub async fn pause(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    toggle_pause(state, true).await
}

pub async fn resume(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    toggle_pause(state, false).await
}

async fn toggle_pause(state: Arc<AppState>, paused: bool) -> impl IntoResponse {
    let base = state.config.base_path.clone();
    let fallback = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|m| m.pipeline_v2.clone());

    let res = tokio::task::spawn_blocking(move || {
        set_pipeline_paused(base.as_path(), paused, fallback.as_ref())
    })
    .await;

    match res {
        Ok(Ok((file, changed, mode))) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "success": true,
                "changed": changed,
                "paused": paused,
                "file": file,
                "mode": format_pipeline_mode(mode),
            })),
        )
            .into_response(),
        Ok(Err(err)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "success": false,
                "error": err,
            })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "success": false,
                "error": err.to_string(),
            })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{find_config_file, format_pipeline_mode, read_pipeline_mode, set_pipeline_paused};

    #[test]
    fn finds_fallback_config_files() {
        let dir = tempdir().expect("tempdir");
        std::fs::write(dir.path().join("AGENT.yaml"), "memory:\n  pipelineV2:\n    paused: true\n")
            .expect("write config");

        let file = find_config_file(dir.path()).expect("config file");

        assert!(file.ends_with("AGENT.yaml"));
    }

    #[test]
    fn writes_paused_state_and_reports_mode() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("agent.yaml");
        std::fs::write(&path, "memory:\n  pipelineV2:\n    enabled: true\n").expect("write config");

        let (file, changed, mode) =
            set_pipeline_paused(dir.path(), true, None).expect("toggle paused");
        let raw = std::fs::read_to_string(path).expect("read config");

        assert_eq!(file, dir.path().join("agent.yaml").to_string_lossy());
        assert!(changed);
        assert_eq!(format_pipeline_mode(mode), "paused");
        assert!(raw.contains("paused: true"));
    }

    #[test]
    fn reads_paused_mode_from_config_file() {
        let dir = tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("agent.yaml"),
            "memory:\n  pipelineV2:\n    enabled: true\n    paused: true\n",
        )
        .expect("write config");

        let mode = read_pipeline_mode(dir.path(), None);

        assert_eq!(format_pipeline_mode(mode), "paused");
    }
}
