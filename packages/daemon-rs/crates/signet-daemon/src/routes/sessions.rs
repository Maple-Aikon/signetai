//! Session and checkpoint route handlers.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::Deserialize;

use crate::state::AppState;

// ---------------------------------------------------------------------------
// GET /api/sessions
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SessionListParams {
    pub agent_id: Option<String>,
}

/// Merge tracker claims with cross-agent presence records, mirroring the TS
/// `listLiveSessions()` behavior. Presence-only sessions (not in the tracker)
/// appear with `expiresAt: null`.
pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SessionListParams>,
) -> axum::response::Response {
    let tracker_sessions = state.sessions.list_sessions();
    let tracker_keys: std::collections::HashSet<String> =
        tracker_sessions.iter().map(|s| s.key.clone()).collect();

    // Fetch presence-only sessions from DB (those not already in the tracker).
    let agent_id = params.agent_id.clone();
    let presence_result = state
        .pool
        .read(move |conn| {
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_presence'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);

            if !exists {
                return Ok(serde_json::json!([]));
            }

            let mut sql =
                "SELECT session_key, runtime_path, started_at FROM agent_presence \
                 WHERE session_key IS NOT NULL"
                    .to_string();
            if let Some(ref aid) = agent_id {
                sql.push_str(&format!(" AND agent_id = '{aid}'"));
            }
            sql.push_str(" ORDER BY last_seen_at DESC");

            let mut stmt = conn.prepare(&sql)?;
            let rows: Vec<serde_json::Value> = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?
                .filter_map(|r| r.ok())
                .map(|(sk, path, started_at)| {
                    serde_json::json!({
                        "key": sk,
                        "runtimePath": path.unwrap_or_else(|| "unknown".into()),
                        "claimedAt": started_at,
                        "expiresAt": serde_json::Value::Null,
                        "bypassed": false,
                    })
                })
                .collect();
            Ok(serde_json::json!(rows))
        })
        .await;

    let presence_only: Vec<serde_json::Value> = presence_result
        .ok()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    // Tracker sessions serialized with expiresAt present.
    let mut all: Vec<serde_json::Value> = tracker_sessions
        .into_iter()
        .map(|s| serde_json::to_value(&s).unwrap_or_default())
        .collect();

    // Append presence-only sessions not already covered by the tracker.
    for p in presence_only {
        let sk = p.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if !tracker_keys.contains(&sk) {
            all.push(p);
        }
    }

    let count = all.len();
    (
        StatusCode::OK,
        Json(serde_json::json!({ "sessions": all, "count": count })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// GET /api/sessions/:key
// ---------------------------------------------------------------------------

pub async fn get(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> axum::response::Response {
    let sessions = state.sessions.list_sessions();
    let session = sessions.into_iter().find(|s| s.key == key);

    match session {
        Some(s) => (StatusCode::OK, Json(serde_json::to_value(s).unwrap())).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Session not found"})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// POST /api/sessions/:key/bypass
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct BypassBody {
    pub enabled: Option<bool>,
}

pub async fn bypass(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
    Json(body): Json<BypassBody>,
) -> axum::response::Response {
    let key = key.strip_prefix("session:").unwrap_or(&key).to_string();
    let enabled = body.enabled.unwrap_or(true);

    if enabled {
        state.sessions.bypass(&key);
    } else {
        state.sessions.unbypass(&key);
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "key": key,
            "bypassed": enabled,
        })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// GET /api/sessions/summaries
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SummaryParams {
    pub project: Option<String>,
    pub depth: Option<i64>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

pub async fn summaries(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<SummaryParams>,
) -> axum::response::Response {
    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0);

    let result = state
        .pool
        .read(move |conn| {
            let mut sql = String::from(
                "SELECT s.*, \
                 (SELECT COUNT(*) FROM session_summary_children c WHERE c.parent_id = s.id) AS child_count \
                 FROM session_summaries s WHERE 1=1",
            );
            let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

            if let Some(ref project) = params.project {
                sql.push_str(" AND s.project = ?");
                params_vec.push(Box::new(project.clone()));
            }

            if let Some(depth) = params.depth {
                sql.push_str(" AND s.depth = ?");
                params_vec.push(Box::new(depth));
            }

            sql.push_str(" ORDER BY s.latest_at DESC LIMIT ? OFFSET ?");
            params_vec.push(Box::new(limit as i64));
            params_vec.push(Box::new(offset as i64));

            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                params_vec.iter().map(|p| p.as_ref()).collect();

            // Query total count
            let mut count_sql = String::from("SELECT COUNT(*) FROM session_summaries WHERE 1=1");
            let mut count_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

            if let Some(ref project) = params.project {
                count_sql.push_str(" AND project = ?");
                count_params.push(Box::new(project.clone()));
            }
            if let Some(depth) = params.depth {
                count_sql.push_str(" AND depth = ?");
                count_params.push(Box::new(depth));
            }

            let count_refs: Vec<&dyn rusqlite::types::ToSql> =
                count_params.iter().map(|p| p.as_ref()).collect();

            let total: i64 = conn
                .query_row(&count_sql, count_refs.as_slice(), |r| r.get(0))
                .unwrap_or(0);

            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(param_refs.as_slice(), |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>("id")?,
                    "project": row.get::<_, Option<String>>("project")?,
                    "depth": row.get::<_, i64>("depth")?,
                    "kind": row.get::<_, String>("kind")?,
                    "content": row.get::<_, String>("content")?,
                    "tokenCount": row.get::<_, Option<i64>>("token_count")?,
                    "earliestAt": row.get::<_, String>("earliest_at")?,
                    "latestAt": row.get::<_, String>("latest_at")?,
                    "sessionKey": row.get::<_, Option<String>>("session_key")?,
                    "harness": row.get::<_, Option<String>>("harness")?,
                    "agentId": row.get::<_, String>("agent_id")?,
                    "createdAt": row.get::<_, String>("created_at")?,
                    "childCount": row.get::<_, i64>("child_count")?,
                }))
            })?;

            let summaries: Vec<serde_json::Value> = rows.filter_map(|r| r.ok()).collect();

            Ok(serde_json::json!({
                "summaries": summaries,
                "total": total,
            }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/sessions/checkpoints
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct CheckpointParams {
    pub session_key: Option<String>,
    pub project: Option<String>,
    pub limit: Option<usize>,
}

pub async fn checkpoints(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<CheckpointParams>,
) -> axum::response::Response {
    let result = state
        .pool
        .read(move |conn| {
            let items = if let Some(ref key) = params.session_key {
                signet_services::session::get_checkpoints_for_session(conn, key)?
            } else if let Some(ref project) = params.project {
                let limit = params.limit.unwrap_or(20);
                signet_services::session::get_checkpoints_for_project(conn, project, limit)?
            } else {
                vec![]
            };

            Ok(serde_json::json!({
                "items": items,
                "count": items.len(),
            }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/sessions/checkpoints/latest
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct LatestCheckpointParams {
    pub project: Option<String>,
}

pub async fn checkpoint_latest(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<LatestCheckpointParams>,
) -> axum::response::Response {
    let Some(project) = params.project else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "project is required"})),
        )
            .into_response();
    };

    let result = state
        .pool
        .read(move |conn| {
            let checkpoint = signet_services::session::get_latest_checkpoint(conn, &project)?;
            Ok(serde_json::json!({ "checkpoint": checkpoint }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}
