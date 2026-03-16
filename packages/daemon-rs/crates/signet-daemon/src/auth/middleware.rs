//! Axum middleware for auth: token validation, permission checks,
//! scope enforcement, and rate limiting.

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Json, Response};

use super::policy::{check_permission, check_scope};
use super::rate_limiter::AuthRateLimiter;
use super::tokens::verify_token;
use super::types::{AuthMode, AuthResult, Permission, TokenScope};

// ---------------------------------------------------------------------------
// Auth state stored in request extensions
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct AuthState {
    pub result: AuthResult,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    let val = headers.get("authorization")?.to_str().ok()?;
    let token = val.strip_prefix("Bearer ")?;
    if token.is_empty() { None } else { Some(token) }
}

fn is_localhost(headers: &HeaderMap) -> bool {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let host_no_port = host.split(':').next().unwrap_or("");
    matches!(host_no_port, "localhost" | "127.0.0.1" | "::1")
}

// ---------------------------------------------------------------------------
// Auth config for middleware
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct AuthConfig {
    pub mode: AuthMode,
    pub secret: Option<Vec<u8>>,
}

// ---------------------------------------------------------------------------
// Auth middleware (validates token, sets AuthState in extensions)
// ---------------------------------------------------------------------------

pub async fn auth_middleware(auth_cfg: AuthConfig, mut req: Request<Body>, next: Next) -> Response {
    let headers = req.headers();

    // Local mode: no auth required
    if auth_cfg.mode == AuthMode::Local {
        req.extensions_mut().insert(AuthState {
            result: AuthResult::unauthenticated(),
        });
        return next.run(req).await;
    }

    // Hybrid mode: localhost skips token requirement
    if auth_cfg.mode == AuthMode::Hybrid && is_localhost(headers) {
        let result = if let Some(token) = extract_bearer(headers)
            && let Some(secret) = &auth_cfg.secret
        {
            verify_token(secret, token)
        } else {
            AuthResult::unauthenticated()
        };
        req.extensions_mut().insert(AuthState { result });
        return next.run(req).await;
    }

    // Team mode (or hybrid+remote): token required
    let Some(token) = extract_bearer(headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            [("www-authenticate", "Bearer")],
            Json(serde_json::json!({"error": "authentication required"})),
        )
            .into_response();
    };

    let Some(secret) = &auth_cfg.secret else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "auth secret not configured"})),
        )
            .into_response();
    };

    let result = verify_token(secret, token);
    if !result.authenticated {
        let err = result.error.as_deref().unwrap_or("invalid token");
        return (
            StatusCode::UNAUTHORIZED,
            [("www-authenticate", "Bearer")],
            Json(serde_json::json!({"error": err})),
        )
            .into_response();
    }

    req.extensions_mut().insert(AuthState { result });
    next.run(req).await
}

// ---------------------------------------------------------------------------
// Permission guard (use as axum extractor or middleware)
// ---------------------------------------------------------------------------

pub fn require_permission_guard(
    auth_state: &AuthState,
    perm: Permission,
    mode: AuthMode,
    is_local: bool,
) -> Result<(), Box<Response>> {
    // Hybrid + localhost without token = full access
    if mode == AuthMode::Hybrid && is_local && !auth_state.result.authenticated {
        return Ok(());
    }

    let decision = check_permission(auth_state.result.claims.as_ref(), perm, mode);
    if !decision.allowed {
        return Err(Box::new(
            (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": decision.reason.unwrap_or("forbidden".into())})),
            )
                .into_response(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Scope guard
// ---------------------------------------------------------------------------

pub fn require_scope_guard(
    auth_state: &AuthState,
    target: &TokenScope,
    mode: AuthMode,
    is_local: bool,
) -> Result<(), Box<Response>> {
    if mode == AuthMode::Hybrid && is_local && !auth_state.result.authenticated {
        return Ok(());
    }

    let decision = check_scope(auth_state.result.claims.as_ref(), target, mode);
    if !decision.allowed {
        return Err(Box::new(
            (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": decision.reason.unwrap_or("scope violation".into())})),
            )
                .into_response(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Rate limit guard
// ---------------------------------------------------------------------------

pub fn require_rate_limit_guard(
    auth_state: &AuthState,
    operation: &str,
    limiter: &AuthRateLimiter,
    mode: AuthMode,
    actor_header: Option<&str>,
) -> Result<(), Box<Response>> {
    if mode == AuthMode::Local {
        return Ok(());
    }

    let actor = auth_state
        .result
        .claims
        .as_ref()
        .map(|c| c.sub.as_str())
        .or(actor_header)
        .unwrap_or("anonymous");

    let check = limiter.check_and_record(operation, actor);
    if !check.allowed {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let retry_after = check.reset_at.saturating_sub(now_ms) / 1000 + 1;

        let retry_str = retry_after.to_string();
        return Err(Box::new(
            (
                StatusCode::TOO_MANY_REQUESTS,
                [("retry-after", retry_str.as_str())],
                Json(serde_json::json!({
                    "error": "rate limit exceeded",
                    "retryAfter": check.reset_at,
                })),
            )
                .into_response(),
        ));
    }
    Ok(())
}
