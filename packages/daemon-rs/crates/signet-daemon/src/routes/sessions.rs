//! Session and checkpoint route handlers.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::Deserialize;

use crate::state::AppState;

// ---------------------------------------------------------------------------
// GET /api/sessions
// ---------------------------------------------------------------------------

pub async fn list(State(state): State<Arc<AppState>>) -> axum::response::Response {
    let sessions = state.sessions.list_sessions();
    let count = sessions.len();

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "sessions": sessions,
            "count": count,
        })),
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
