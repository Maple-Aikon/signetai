//! Config, identity, and features route handlers.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::Deserialize;

use crate::state::AppState;

// ---------------------------------------------------------------------------
// GET /api/config
// ---------------------------------------------------------------------------

/// Priority order for config files in response.
const FILE_PRIORITY: &[&str] = &[
    "agent.yaml",
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
];

pub async fn get_config(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let dir = state.config.base_path.clone();

    let result = tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();

        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => return serde_json::json!({"files": [], "error": "cannot read directory"}),
        };

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".md") && !name.ends_with(".yaml") && !name.ends_with(".yml") {
                continue;
            }

            let content = match std::fs::read_to_string(entry.path()) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let size = content.len();
            files.push(serde_json::json!({
                "name": name,
                "content": content,
                "size": size,
            }));
        }

        // Sort by priority
        files.sort_by(|a, b| {
            let an = a["name"].as_str().unwrap_or("");
            let bn = b["name"].as_str().unwrap_or("");
            let ai = FILE_PRIORITY
                .iter()
                .position(|&p| p == an)
                .unwrap_or(usize::MAX);
            let bi = FILE_PRIORITY
                .iter()
                .position(|&p| p == bn)
                .unwrap_or(usize::MAX);
            ai.cmp(&bi).then_with(|| an.cmp(bn))
        });

        serde_json::json!({"files": files})
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({"files": [], "error": "read failed"}));

    Json(result)
}

// ---------------------------------------------------------------------------
// POST /api/config
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SaveConfigBody {
    pub file: String,
    pub content: String,
}

pub async fn save_config(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SaveConfigBody>,
) -> impl IntoResponse {
    // Path traversal protection
    if body.file.contains('/') || body.file.contains("..") {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid file name"})),
        )
            .into_response();
    }

    if !body.file.ends_with(".md") && !body.file.ends_with(".yaml") && !body.file.ends_with(".yml")
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "only .md and .yaml files are allowed"})),
        )
            .into_response();
    }

    let path = state.config.base_path.join(&body.file);
    let content = body.content;

    match tokio::fs::write(&path, &content).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"success": true}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/identity
// ---------------------------------------------------------------------------

pub async fn identity(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    // Primary source: agent.yaml (already parsed into manifest)
    let manifest_name = &state.config.manifest.agent.name;
    let mut name = if manifest_name.is_empty() {
        String::new()
    } else {
        manifest_name.clone()
    };
    let mut creature = String::new();
    let mut vibe = String::new();

    // Secondary source: IDENTITY.md — fill any field not already set by agent.yaml
    // (supports both `- key:` and `**key:**`)
    if name.is_empty() || creature.is_empty() || vibe.is_empty() {
        let need_name = name.is_empty();
        let need_creature = creature.is_empty();
        let need_vibe = vibe.is_empty();
        let path = state.config.base_path.join("IDENTITY.md");
        let result = tokio::task::spawn_blocking(move || {
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => return (String::new(), String::new(), String::new()),
            };

            let mut n = String::new();
            let mut c = String::new();
            let mut v = String::new();

            for line in content.lines() {
                let trimmed = line.trim();
                // Legacy: `- name: Boogy`
                let stripped = trimmed.trim_start_matches('-').trim();
                if need_name {
                    if let Some(val) = stripped.strip_prefix("name:") {
                        if n.is_empty() { n = val.trim().to_string(); }
                    }
                }
                if need_creature {
                    if let Some(val) = stripped.strip_prefix("creature:") {
                        if c.is_empty() { c = val.trim().to_string(); }
                    }
                }
                if need_vibe {
                    if let Some(val) = stripped.strip_prefix("vibe:") {
                        if v.is_empty() { v = val.trim().to_string(); }
                    }
                }
                // Markdown bold: `**name:** Boogy`
                if need_name {
                    if let Some(val) = trimmed.strip_prefix("**name:**") {
                        if n.is_empty() { n = val.trim().to_string(); }
                    }
                }
                if need_creature {
                    if let Some(val) = trimmed.strip_prefix("**creature:**") {
                        if c.is_empty() { c = val.trim().to_string(); }
                    }
                }
                if need_vibe {
                    if let Some(val) = trimmed.strip_prefix("**vibe:**") {
                        if v.is_empty() { v = val.trim().to_string(); }
                    }
                }
            }

            (n, c, v)
        })
        .await
        .unwrap_or_default();

        if name.is_empty() { name = result.0; }
        if creature.is_empty() { creature = result.1; }
        if vibe.is_empty() { vibe = result.2; }
    }

    Json(serde_json::json!({
        "name": name,
        "creature": creature,
        "vibe": vibe,
    }))
}

// ---------------------------------------------------------------------------
// GET /api/features
// ---------------------------------------------------------------------------

pub async fn features(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let pipeline = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|m| m.pipeline_v2.as_ref());

    let enabled = pipeline.map(|p| p.enabled).unwrap_or(false);
    let shadow = pipeline.map(|p| p.shadow_mode).unwrap_or(false);
    let frozen = pipeline.map(|p| p.mutations_frozen).unwrap_or(false);
    let graph = pipeline.map(|p| p.graph.enabled).unwrap_or(false);
    let autonomous = pipeline.map(|p| p.autonomous.enabled).unwrap_or(false);

    let embedding = state
        .config
        .manifest
        .embedding
        .as_ref()
        .map(|e| e.provider.as_str())
        .unwrap_or("none");

    Json(serde_json::json!({
        "pipelineV2": enabled,
        "shadowMode": shadow,
        "mutationsFrozen": frozen,
        "graphEnabled": graph,
        "autonomousEnabled": autonomous,
        "embeddingProvider": embedding,
    }))
}
