#!/usr/bin/env node
/**
 * Signet Daemon
 * Background service for memory, API, and dashboard hosting
 */

import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync } from "node:fs";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
	type AgentDefinition,
	buildArchitectureDoc,
	networkModeFromBindHost,
	normalizeAgentRosterEntry,
	parseSimpleYaml,
	stripSignetBlock,
} from "@signet/core";
import { watch } from "chokidar";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { resolveAgentId } from "./agent-id";
import {
	type TokenRole,
	type TokenScope,
	checkScope,
	createAuthMiddleware,
	createToken,
	requirePermission,
	requireRateLimit,
} from "./auth";
import { bindWithRetry } from "./bind-with-retry";
import { migrateConfig } from "./config-migration";
import { listConnectors } from "./connectors/registry";
import { normalizeAndHashContent } from "./content-normalization";
import { clearAllPresence } from "./cross-agent";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { syncVecDeleteBySourceId, syncVecInsert } from "./db-helpers";
import { fetchEmbedding, setNativeFallbackToOllama } from "./embedding-fetch";
import { type EmbeddingTrackerHandle, startEmbeddingTracker } from "./embedding-tracker";
import { getAllFeatureFlags, initFeatureFlags } from "./feature-flags";
import { writeFileIfChangedAsync } from "./file-sync";
import { syncAgentWorkspaces } from "./identity-sync";
import { closeLlmProvider, getLlmProvider, initLlmProvider } from "./llm";
import { type LogEntry, logger } from "./logger";
import { type EmbeddingConfig, type ResolvedMemoryConfig, loadMemoryConfig } from "./memory-config";
import {
	DEFAULT_RETENTION,
	enqueueDocumentIngestJob,
	ensureRetentionWorker,
	getDreamingPasses,
	getDreamingState,
	getDreamingWorker,
	getPipelineWorkerStatus,
	getSynthesisWorker,
	nudgeExtractionWorker,
	readLastSynthesisTime,
	setDreamingWorker,
	startPipeline,
	stopPipeline,
} from "./pipeline";
import { AlreadyRunningError, type DreamingWorkerHandle, startDreamingWorker } from "./pipeline/dreaming-worker";
import { deadLetterExtractionJob, deadLetterPendingExtractionJobs } from "./pipeline/extraction-fallback";
import { getGraphBoostIds } from "./pipeline/graph-search";
import {
	getTraversalStatus,
	invalidateTraversalCache,
	resolveFocalEntities,
	traverseKnowledgeGraph,
} from "./pipeline/graph-traversal";
import {
	getAvailableModels,
	getModelsByProvider,
	getRegistryStatus,
	initModelRegistry,
	refreshRegistry,
	stopModelRegistry,
} from "./pipeline/model-registry";
import {
	DEFAULT_OLLAMA_FALLBACK_MODEL,
	createAnthropicProvider,
	createClaudeCodeProvider,
	createCodexProvider,
	createOllamaProvider,
	createOpenCodeProvider,
	createOpenRouterProvider,
	ensureOpenCodeServer,
	resolveDefaultOllamaFallbackMaxContextTokens,
	stopOpenCodeServer,
	withRateLimit,
} from "./pipeline/provider";
import { resolveRuntimeModel } from "./pipeline/provider-resolution";
import { startReconciler } from "./pipeline/skill-reconciler";
import { type PredictorClient, createPredictorClient } from "./predictor-client";
import { detectDrift } from "./predictor-comparison";
import { getPredictorState } from "./predictor-state";
import { type RepairContext, structuralBackfill } from "./repair-actions";
import {
	AGENTS_DIR,
	ALLOWED_ORIGINS,
	BIND_HOST,
	CURRENT_VERSION,
	DAEMON_DIR,
	HOST,
	INTERNAL_SELF_HOST,
	LOG_DIR,
	MEMORY_DB,
	NETWORK_MODE,
	PID_FILE,
	PORT,
	analyticsCollector,
	authAdminLimiter,
	authBatchForgetLimiter,
	authConfig,
	authCrossAgentMessageLimiter,
	authForgetLimiter,
	authModifyLimiter,
	authSecret,
	bindAbort,
	invalidateDiagnosticsCache,
	isAllowedOrigin,
	isManagedOpenCodeLocalEndpoint,
	normalizeRuntimeBaseUrl,
	providerRuntimeResolution,
	providerTracker,
	queueExtractionJob,
	readEnvTrimmed,
	redactUrlForLogs,
	reloadAuthState,
	repairLimiter,
	setCheckpointPruneTimer,
	setEmbeddingTrackerHandle,
	setHeartbeatTimer,
	setPredictorClientRef,
	setRestartPipelineRuntime,
	setShuttingDown,
	setTelemetryRef,
	shuttingDown,
} from "./routes/state.js";
import { isHarnessAvailable, startSchedulerWorker } from "./scheduler/index.js";
import { getSecret, hasSecret } from "./secrets.js";
import { flushPendingCheckpoints, initCheckpointFlush, pruneCheckpoints } from "./session-checkpoints";
import { releaseAllSessions, startSessionCleanup, stopSessionCleanup } from "./session-tracker";
import { createSingleFlightRunner } from "./single-flight-runner";
import { closeSynthesisProvider, initSynthesisProvider } from "./synthesis-llm";
import { type TelemetryCollector, type TelemetryEventType, createTelemetryCollector } from "./telemetry";
import { closeWidgetProvider, initWidgetProvider } from "./widget-llm";

import { mountMcpRoute } from "./mcp/route.js";
import { mountAppTrayRoutes } from "./routes/app-tray.js";
import { mountChangelogRoutes } from "./routes/changelog.js";
import { registerConnectorRoutes } from "./routes/connectors-routes.js";
import { mountEventBusRoutes } from "./routes/event-bus.js";
import { getGitStatus, gitSync, scheduleAutoCommit, startGitSyncTimer, stopGitSyncTimer } from "./routes/git-sync.js";
import { registerHooksRoutes } from "./routes/hooks-routes.js";
import { registerKnowledgeRoutes } from "./routes/knowledge-routes.js";
import { mountMarketplaceReviewsRoutes } from "./routes/marketplace-reviews.js";
import { mountMarketplaceRoutes } from "./routes/marketplace.js";
import { mountMcpAnalyticsRoutes } from "./routes/mcp-analytics.js";
import { registerMemoryRoutes } from "./routes/memory-routes.js";
import { registerMiscRoutes } from "./routes/misc-routes.js";
import { mountOsAgentRoutes } from "./routes/os-agent.js";
import { mountOsChatRoutes } from "./routes/os-chat.js";
import { registerPipelineRoutes } from "./routes/pipeline-routes.js";
import { registerRepairRoutes } from "./routes/repair-routes.js";
import { registerSecretRoutes } from "./routes/secrets-routes.js";
import { registerSessionRoutes } from "./routes/session-routes.js";
import { mountSkillAnalyticsRoutes } from "./routes/skill-analytics.js";
import { mountSkillsRoutes, setFetchEmbedding } from "./routes/skills.js";
import { registerTelemetryRoutes } from "./routes/telemetry-routes.js";
import { checkEmbeddingProvider, getConfiguredProviderHints } from "./routes/utils.js";
import { mountWidgetRoutes } from "./routes/widget.js";
import {
	MAX_UPDATE_INTERVAL_SECONDS,
	MIN_UPDATE_INTERVAL_SECONDS,
	type UpdateConfig,
	checkForUpdates as checkForUpdatesImpl,
	getUpdateState,
	initUpdateSystem,
	parseBooleanFlag,
	parseUpdateInterval,
	runUpdate as runUpdateImpl,
	setUpdateConfig,
	startUpdateTimer,
	stopUpdateTimer,
} from "./update-system";
import { createAgentsWatcherIgnoreMatcher } from "./watcher-ignore";

let httpServer: ReturnType<typeof createAdaptorServer> | null = null;
let dreamingWorkerHandle: DreamingWorkerHandle | null = null;
let shadowProcess: ChildProcess | null = null;
let predictorClientRef: PredictorClient | null = null;
let embeddingTrackerHandle: EmbeddingTrackerHandle | null = null;
let skillReconcilerHandle: ReturnType<typeof startReconciler> | null = null;
let schedulerHandle: { stop(): Promise<void> } | null = null;
let structuralBackfillTimer: ReturnType<typeof setTimeout> | null = null;
// These are mirrored into state.ts via setters for read access by
// route modules. Only daemon.ts should assign or clear them.
// predictorClientRef follows the same pattern (see getPredictorClient).
let telemetryRef: TelemetryCollector | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let checkpointPruneTimer: ReturnType<typeof setInterval> | undefined;

export function getPredictorClient(): PredictorClient | null {
	return predictorClientRef;
}

export function recordPredictorLatency(operation: "predictor_score" | "predictor_train", durationMs: number): void {
	analyticsCollector.recordLatency(operation, durationMs);
}

// ============================================================================
// Hono App
// ============================================================================

export const app = new Hono();

// ============================================================================
// Middleware
// ============================================================================

app.use(
	"*",
	cors({
		origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
		credentials: true,
	}),
);

app.use("*", async (c, next) => {
	if (shuttingDown && c.req.path !== "/health") {
		c.status(503);
		return c.json({ error: "shutting down" });
	}
	return next();
});

app.use("*", async (c, next) => {
	if (authConfig.mode !== "local" && !authSecret) {
		c.status(503);
		return c.json({ error: "server initializing" });
	}
	const mw = createAuthMiddleware(authConfig, authSecret);
	return mw(c, next);
});

app.use("*", async (c, next) => {
	const start = Date.now();
	await next();
	const duration = Date.now() - start;
	logger.api.request(c.req.method, c.req.path, c.res.status, duration);
	const actor = c.req.header("x-signet-actor");
	analyticsCollector.recordRequest(c.req.method, c.req.path, c.res.status, duration, actor ?? undefined);
	const p = c.req.path;
	if (p.includes("/remember") || p.includes("/save")) {
		analyticsCollector.recordLatency("remember", duration);
	} else if (p.includes("/recall") || p.includes("/search") || p.includes("/similar")) {
		analyticsCollector.recordLatency("recall", duration);
	} else if (p.includes("/modify") || p.includes("/forget") || p.includes("/recover")) {
		analyticsCollector.recordLatency("mutate", duration);
	}
});

app.use("*", async (c, next) => {
	const method = c.req.method;
	const bodyP = ["POST", "PUT", "PATCH"].includes(method)
		? c.req.text().catch(() => undefined)
		: Promise.resolve(undefined);
	await next();
	if (!shadowProcess) return;
	const reqPath = c.req.path;
	const search = new URL(c.req.url).search;
	const primaryStatus = c.res.status;
	bodyP
		.then((rawBody) =>
			fetch(`http://localhost:3851${reqPath}${search}`, {
				method,
				headers: Object.fromEntries(c.req.raw.headers),
				body: rawBody,
				signal: AbortSignal.timeout(5000),
			}),
		)
		.then((shadow) => {
			if (primaryStatus !== shadow.status) {
				appendDivergence(AGENTS_DIR, {
					path: reqPath,
					method,
					primaryStatus,
					shadowStatus: shadow.status,
				});
			}
			return shadow.body?.cancel();
		})
		.catch(() => {});
});

// ============================================================================
// Health + Features
// ============================================================================

app.get("/health", (c) => {
	const us = getUpdateState();
	let dbOk = false;
	try {
		getDbAccessor().withReadDb((db) => {
			db.prepare("SELECT 1").get();
			dbOk = true;
		});
	} catch {}
	const workers = getPipelineWorkerStatus();
	const extraction = workers.extraction;
	const stalled =
		extraction.running &&
		extraction.stats !== undefined &&
		extraction.stats.pending > 0 &&
		Date.now() - extraction.stats.lastProgressAt > 60_000;

	return c.json({
		status: shuttingDown ? "shutting_down" : "healthy",
		uptime: process.uptime(),
		pid: process.pid,
		version: CURRENT_VERSION,
		port: PORT,
		agentsDir: AGENTS_DIR,
		db: dbOk,
		shuttingDown,
		updateAvailable: us.lastCheck?.updateAvailable ?? false,
		pendingRestart: us.pendingRestartVersion !== null,
		pipeline: {
			extractionRunning: extraction.running,
			extractionStalled: stalled,
			extractionPending: extraction.stats?.pending ?? 0,
			extractionBackoffMs: extraction.stats?.backoffMs ?? 0,
		},
	});
});

app.get("/api/features", (c) => {
	return c.json(getAllFeatureFlags());
});

// ============================================================================
// MCP Server
// ============================================================================

mountMcpRoute(app);

app.get("/api/auth/whoami", (c) => {
	const auth = c.get("auth");
	return c.json({
		authenticated: auth?.authenticated ?? false,
		claims: auth?.claims ?? null,
		mode: authConfig.mode,
	});
});

app.use("/api/auth/token", async (c, next) => {
	const perm = requirePermission("admin", authConfig);
	const rate = requireRateLimit("admin", authAdminLimiter, authConfig);
	await perm(c, async () => {
		await rate(c, next);
	});
});

app.post("/api/auth/token", async (c) => {
	if (!authSecret) {
		return c.json({ error: "auth secret not available (local mode?)" }, 400);
	}

	const payload = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!payload) {
		return c.json({ error: "invalid request body" }, 400);
	}

	const role = payload.role as string | undefined;
	const validRoles: TokenRole[] = ["admin", "operator", "agent", "readonly"];
	if (!role || !validRoles.includes(role as TokenRole)) {
		return c.json({ error: `role must be one of: ${validRoles.join(", ")}` }, 400);
	}

	const scope = (payload.scope ?? {}) as TokenScope;
	const ttl =
		typeof payload.ttlSeconds === "number" && payload.ttlSeconds > 0
			? payload.ttlSeconds
			: authConfig.defaultTokenTtlSeconds;

	const token = createToken(authSecret, { sub: `token:${role}`, scope, role: role as TokenRole }, ttl);
	const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
	return c.json({ token, expiresAt });
});

// ============================================================================
// Route-level permission guards
// ============================================================================

app.use("/api/memory/remember", async (c, next) => {
	return requirePermission("remember", authConfig)(c, next);
});
app.use("/api/memory/save", async (c, next) => {
	return requirePermission("remember", authConfig)(c, next);
});
app.use("/api/hook/remember", async (c, next) => {
	return requirePermission("remember", authConfig)(c, next);
});
app.use("/api/memory/recall", async (c, next) => {
	return requirePermission("recall", authConfig)(c, next);
});
app.use("/api/memory/search", async (c, next) => {
	return requirePermission("recall", authConfig)(c, next);
});
app.use("/memory/search", async (c, next) => {
	return requirePermission("recall", authConfig)(c, next);
});
app.use("/memory/similar", async (c, next) => {
	return requirePermission("recall", authConfig)(c, next);
});
app.use("/api/memory/timeline", async (c, next) => {
	return requirePermission("recall", authConfig)(c, next);
});
app.use("/api/sessions/summaries", async (c, next) => {
	return requirePermission("recall", authConfig)(c, next);
});
app.use("/api/knowledge/expand", async (c, next) => {
	return requirePermission("recall", authConfig)(c, next);
});
app.use("/api/knowledge/expand/session", async (c, next) => {
	return requirePermission("recall", authConfig)(c, next);
});
app.use("/api/graph/impact", async (c, next) => {
	return requirePermission("recall", authConfig)(c, next);
});

app.use("/api/memory/modify", async (c, next) => {
	const perm = requirePermission("modify", authConfig);
	const rate = requireRateLimit("modify", authModifyLimiter, authConfig);
	await perm(c, async () => {
		await rate(c, next);
	});
});

app.use("/api/memory/forget", async (c, next) => {
	const perm = requirePermission("forget", authConfig);
	const rate = requireRateLimit("batchForget", authBatchForgetLimiter, authConfig);
	await perm(c, async () => {
		await rate(c, next);
	});
});

app.use("/api/memory/:id/recover", async (c, next) => {
	return requirePermission("recover", authConfig)(c, next);
});

app.use("/api/documents", async (c, next) => {
	return requirePermission("documents", authConfig)(c, next);
});
app.use("/api/documents/*", async (c, next) => {
	return requirePermission("documents", authConfig)(c, next);
});

app.use("/api/connectors", async (c, next) => {
	if (c.req.method === "GET") return next();
	return requirePermission("admin", authConfig)(c, next);
});
app.use("/api/connectors/*", async (c, next) => {
	if (c.req.method === "GET") return next();
	return requirePermission("admin", authConfig)(c, next);
});

app.use("/api/diagnostics", async (c, next) => {
	return requirePermission("diagnostics", authConfig)(c, next);
});
app.use("/api/diagnostics/*", async (c, next) => {
	return requirePermission("diagnostics", authConfig)(c, next);
});

app.use("/api/analytics", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});
app.use("/api/analytics/*", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});
app.use("/api/mcp/analytics", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});
app.use("/api/mcp/analytics/*", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});
app.use("/api/skills/analytics", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});
app.use("/api/skills/analytics/*", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});

app.use("/api/cross-agent", async (c, next) => {
	if (c.req.method === "GET") {
		return requirePermission("recall", authConfig)(c, next);
	}
	return requirePermission("remember", authConfig)(c, next);
});
app.use("/api/cross-agent/*", async (c, next) => {
	if (c.req.method === "GET") {
		return requirePermission("recall", authConfig)(c, next);
	}
	return requirePermission("remember", authConfig)(c, next);
});
app.use("/api/cross-agent/messages", async (c, next) => {
	if (c.req.method !== "POST") {
		await next();
		return;
	}
	return requireRateLimit("cross-agent-message", authCrossAgentMessageLimiter, authConfig)(c, next);
});

app.use("/api/predictor/*", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});
app.use("/api/timeline/*", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});

app.use("/api/repair/*", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});

app.use("/api/secrets", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});
app.use("/api/secrets/*", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});

app.use("/api/git/*", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});

app.use("/api/troubleshoot/*", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});

const MAX_CONFIG_BYTES = 1_048_576;
app.use("/api/config", async (c, next) => {
	if (c.req.method === "POST") {
		const cl = c.req.header("content-length");
		if (cl && Number(cl) > MAX_CONFIG_BYTES) {
			return c.json({ error: `payload exceeds ${MAX_CONFIG_BYTES} byte limit` }, 413);
		}
		return requirePermission("admin", authConfig)(c, next);
	}
	return next();
});

app.use("/api/memory/:id", async (c, next) => {
	if (authConfig.mode !== "local" && (c.req.method === "PATCH" || c.req.method === "DELETE")) {
		const auth = c.get("auth");
		if (auth?.claims?.scope?.project) {
			const memoryId = c.req.param("id");
			const row = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT project FROM memories WHERE id = ?").get(memoryId) as
						| { project: string | null }
						| undefined,
			);
			if (row) {
				const decision = checkScope(auth.claims, { project: row.project ?? undefined }, authConfig.mode);
				if (!decision.allowed) {
					return c.json({ error: decision.reason ?? "scope violation" }, 403);
				}
			}
		}
	}

	if (c.req.method === "PATCH") {
		const perm = requirePermission("modify", authConfig);
		const rate = requireRateLimit("modify", authModifyLimiter, authConfig);
		return perm(c, async () => {
			await rate(c, next);
		});
	}
	if (c.req.method === "DELETE") {
		const perm = requirePermission("forget", authConfig);
		const rate = requireRateLimit("forget", authForgetLimiter, authConfig);
		return perm(c, async () => {
			await rate(c, next);
		});
	}
	if (c.req.method === "GET") {
		return requirePermission("recall", authConfig)(c, next);
	}
	return next();
});

// ============================================================================
// Register all route modules
// ============================================================================

registerMemoryRoutes(app);
registerHooksRoutes(app);
registerKnowledgeRoutes(app);
registerRepairRoutes(app);
registerConnectorRoutes(app);
registerSecretRoutes(app);
registerSessionRoutes(app, { getGitStatus, gitSync });
registerPipelineRoutes(app);
registerTelemetryRoutes(app);
registerMiscRoutes(app);

// ============================================================================
// Additional route modules (from main)
// ============================================================================

setFetchEmbedding(fetchEmbedding);
mountSkillsRoutes(app);
mountMarketplaceRoutes(app);
mountMcpAnalyticsRoutes(app);
mountSkillAnalyticsRoutes(app);
mountAppTrayRoutes(app);
mountWidgetRoutes(app);
mountEventBusRoutes(app);
mountMarketplaceReviewsRoutes(app);
mountChangelogRoutes(app);
mountOsChatRoutes(app);
mountOsAgentRoutes(app);

// ============================================================================
// Dashboard static serving
// ============================================================================

function getDashboardCandidates(): string[] {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);

	return [
		join(__dirname, "..", "..", "cli", "dashboard", "build"),
		join(__dirname, "..", "..", "..", "cli", "dashboard", "build"),
		join(__dirname, "..", "dashboard"),
		join(__dirname, "dashboard"),
	];
}

function getDashboardPath(): string | null {
	const candidates = getDashboardCandidates();

	for (const candidate of candidates) {
		if (existsSync(join(candidate, "index.html"))) {
			return candidate;
		}
	}

	return null;
}

// Harness last-seen registry — in-memory, resets on daemon restart
const harnessLastSeen = new Map<string, string>();

function stampHarness(harness: string | undefined): void {
	if (harness) {
		harnessLastSeen.set(harness, new Date().toISOString());
	}
}

// Guard against recursive hook calls from spawned agent contexts
function isInternalCall(c: Context): boolean {
	return c.req.header("x-signet-no-hooks") === "1";
}

// Check whether the session is bypassed (hooks return no-op responses)
function checkBypass(body?: { sessionKey?: string; sessionId?: string }): boolean {
	const key = body?.sessionKey ?? body?.sessionId;
	if (!key) return false;
	// isSessionBypassed normalizes the key via normalizeSessionKey() internally,
	// so raw "session:<uuid>" forms from hook bodies are handled correctly.
	return isSessionBypassed(key);
}

function emptyHookRecallResponse(
	query: string,
	extras?: { readonly bypassed?: boolean; readonly internal?: boolean },
): {
	results: [];
	query: string;
	method: "hybrid";
	meta: {
		totalReturned: 0;
		hasSupplementary: false;
		noHits: true;
	};
	bypassed?: boolean;
	internal?: boolean;
} {
	return {
		results: [],
		query,
		method: "hybrid",
		meta: {
			totalReturned: 0,
			hasSupplementary: false,
			noHits: true,
		},
		...(extras?.bypassed ? { bypassed: true } : {}),
		...(extras?.internal ? { internal: true } : {}),
	};
}

function listLiveSessions(agentId: string): Array<{
	key: string;
	runtimePath: string;
	claimedAt: string;
	expiresAt: string | null;
	bypassed: boolean;
}> {
	// Seed from tracker claims for this agent. Claims now carry agentId so
	// sessions from another agent workspace that happens to share the daemon
	// port cannot appear in this agent's session list.
	const byKey = new Map(
		getActiveSessions()
			.filter((s) => s.agentId === agentId)
			.map((session) => [session.key, session] as const),
	);

	// Merge in presence-only sessions for this agent (no tracker claim yet,
	// e.g. plugin path or session whose claim arrived after presence).
	// Filter by agentId here since presence can contain cross-agent records.
	for (const presence of listAgentPresence({ limit: Number.MAX_SAFE_INTEGER })) {
		if (presence.agentId !== agentId) continue;
		if (!presence.sessionKey) continue;
		const key = normalizeSessionKey(presence.sessionKey);
		if (byKey.has(key)) continue;
		byKey.set(key, {
			key,
			runtimePath: presence.runtimePath ?? "unknown",
			claimedAt: presence.startedAt,
			expiresAt: null,
			bypassed: isSessionBypassed(key),
		});
	}
	return [...byKey.values()].sort((a, b) => b.claimedAt.localeCompare(a.claimedAt));
}

// Session start hook - provides context/memories for injection
app.post("/api/hooks/session-start", async (c) => {
	if (isInternalCall(c)) {
		return c.json({ inject: "", memories: [] });
	}
	try {
		const body = (await c.req.json()) as SessionStartRequest;

		if (!body.harness) {
			return c.json({ error: "harness is required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		// Enforce single runtime path per session.
		// Use resolveAgentId to match the same agent-resolution path used
		// throughout the hook (handles body.agentId and session-key-encoded ids).
		if (body.sessionKey && runtimePath) {
			const claim = claimSession(
				body.sessionKey,
				runtimePath,
				resolveAgentId({ agentId: body.agentId, sessionKey: body.sessionKey }),
			);
			if (!claim.ok) {
				return c.json(
					{
						error: `session claimed by ${claim.claimedBy} path`,
					},
					409,
				);
			}
		}

		upsertAgentPresence({
			sessionKey: parseOptionalString(body.sessionKey),
			agentId: parseOptionalString(body.agentId) ?? "default",
			harness: body.harness,
			project: parseOptionalString(body.project),
			runtimePath,
			provider: body.harness,
		});

		stampHarness(body.harness);

		if (checkBypass(body)) {
			return c.json({ inject: "", memories: [], bypassed: true });
		}

		const result = await handleSessionStart(body);
		return c.json(result);
	} catch (e) {
		logger.error("hooks", "Session start hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// User prompt submit hook - inject relevant memories per prompt
app.post("/api/hooks/user-prompt-submit", async (c) => {
	if (isInternalCall(c)) {
		return c.json({ inject: "", memoryCount: 0 });
	}
	try {
		const body = (await c.req.json()) as UserPromptSubmitRequest;

		const hasUserMessage = typeof body.userMessage === "string" && body.userMessage.trim().length > 0;
		const hasUserPrompt = typeof body.userPrompt === "string" && body.userPrompt.trim().length > 0;

		if (!body.harness || (!hasUserMessage && !hasUserPrompt)) {
			return c.json({ error: "harness and userMessage or userPrompt are required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		// Capture before any claim refresh — false means the daemon restarted
		// mid-session (claimedSessions lost in memory) so the adapter can re-init.
		// Note: hasSession evicts expired entries as a side effect; calling it
		// before checkSessionClaim is intentional — an expired claim == no claim.
		const sessionKey = parseOptionalString(body.sessionKey);
		const known = sessionKey ? hasSession(sessionKey) : false;

		const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
		if (conflict) return conflict;
		const agentId = parseOptionalString(body.agentId) ?? "default";
		if (sessionKey) {
			const touched = touchAgentPresence(sessionKey);
			if (!touched) {
				upsertAgentPresence({
					sessionKey,
					agentId,
					harness: body.harness,
					project: parseOptionalString(body.project),
					runtimePath,
					provider: body.harness,
				});
			}
		} else {
			upsertAgentPresence({
				agentId,
				harness: body.harness,
				project: parseOptionalString(body.project),
				runtimePath,
				provider: body.harness,
			});
		}

		stampHarness(body.harness);

		if (checkBypass(body)) {
			return c.json({ inject: "", memoryCount: 0, bypassed: true });
		}

		const result = await handleUserPromptSubmit(body);
		return c.json({ ...result, sessionKnown: known });
	} catch (e) {
		logger.error("hooks", "User prompt submit hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// Session end hook - extract memories from transcript
app.post("/api/hooks/session-end", async (c) => {
	if (isInternalCall(c)) {
		return c.json({ memoriesSaved: 0 });
	}
	try {
		const body = (await c.req.json()) as SessionEndRequest;

		if (!body.harness) {
			return c.json({ error: "harness is required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		stampHarness(body.harness);

		const sessionKey = body.sessionKey || body.sessionId;

		if (sessionKey && isSessionBypassed(sessionKey)) {
			// Still release session claim and agent presence on end
			releaseSession(sessionKey);
			removeAgentPresence(sessionKey);
			return c.json({ memoriesSaved: 0, bypassed: true });
		}

		try {
			const result = await handleSessionEnd(body);
			return c.json(result);
		} finally {
			// Always release session claim and agent presence, even if extraction throws
			if (sessionKey) {
				releaseSession(sessionKey);
				removeAgentPresence(sessionKey);
			}
		}
	} catch (e) {
		logger.error("hooks", "Session end hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// Mid-session checkpoint extraction (long-lived sessions)
app.post("/api/hooks/session-checkpoint-extract", async (c) => {
	if (isInternalCall(c)) {
		return c.json({ skipped: true });
	}
	try {
		const body = (await c.req.json()) as CheckpointExtractRequest;

		if (!body.harness || !body.sessionKey) {
			return c.json({ error: "harness and sessionKey are required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		// Reject if the session was claimed by a different runtime path so a
		// plugin running in parallel cannot enqueue jobs for another session.
		const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
		if (conflict) return conflict;

		stampHarness(body.harness);

		if (isSessionBypassed(body.sessionKey)) {
			return c.json({ skipped: true });
		}

		// Refresh session TTL — keeps the session alive without ending it
		renewSession(body.sessionKey);

		const result = handleCheckpointExtract(body);
		return c.json(result);
	} catch (e) {
		logger.error("hooks", "Checkpoint extract hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// Remember hook - explicit memory save
app.post("/api/hooks/remember", async (c) => {
	if (isInternalCall(c)) {
		return c.json({ success: true, memories: [] });
	}
	try {
		const body = (await c.req.json()) as RememberRequest;

		if (!body.harness || !body.content) {
			return c.json({ error: "harness and content are required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
		if (conflict) return conflict;

		if (checkBypass(body)) {
			return c.json({ success: true, memories: [], bypassed: true });
		}

		// Forward to the full remember endpoint for transcript, structured,
		// and pipeline support instead of the bare handleRemember path.
		const auth = c.req.header("authorization");
		const headers = auth
			? { "Content-Type": "application/json", Authorization: auth }
			: { "Content-Type": "application/json" };
		return fetch(`http://${INTERNAL_SELF_HOST}:${PORT}/api/memory/remember`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
	} catch (e) {
		logger.error("hooks", "Remember hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// Recall hook - explicit memory query
app.post("/api/hooks/recall", async (c) => {
	if (isInternalCall(c)) {
		return c.json(emptyHookRecallResponse("", { internal: true }));
	}
	try {
		const body = (await c.req.json()) as RecallRequest;

		if (!body.harness || !body.query) {
			return c.json({ error: "harness and query are required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
		if (conflict) return conflict;

		if (checkBypass(body)) {
			return c.json(emptyHookRecallResponse(body.query, { bypassed: true }));
		}

		const agentId = resolveAgentId({
			agentId: c.req.header("x-signet-agent-id"),
			sessionKey: body.sessionKey,
		});
		const agentScope = getAgentScope(agentId);
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const result = await hybridRecall(
			{
				query: body.query,
				keywordQuery: body.keywordQuery,
				limit: body.limit,
				project: body.project,
				type: body.type,
				tags: body.tags,
				who: body.who,
				since: body.since,
				until: body.until,
				expand: body.expand,
				agentId,
				readPolicy: agentScope.readPolicy,
				policyGroup: agentScope.policyGroup,
			},
			cfg,
			fetchEmbedding,
		);
		return c.json(result);
	} catch (e) {
		logger.error("hooks", "Recall hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// Pre-compaction hook - provides summary instructions
app.post("/api/hooks/pre-compaction", async (c) => {
	try {
		const body = (await c.req.json()) as PreCompactionRequest;

		if (!body.harness) {
			return c.json({ error: "harness is required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
		if (conflict) return conflict;

		if (checkBypass(body)) {
			return c.json({ instructions: "", bypassed: true });
		}

		const result = handlePreCompaction(body);
		return c.json(result);
	} catch (e) {
		logger.error("hooks", "Pre-compaction hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// Save compaction summary (convenience endpoint)
app.post("/api/hooks/compaction-complete", async (c) => {
	try {
		const body = (await c.req.json()) as {
			harness: string;
			summary: string;
			sessionKey?: string;
			project?: string;
			agentId?: string;
			runtimePath?: string;
		};

		if (!body.harness || !body.summary) {
			return c.json({ error: "harness and summary are required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
		if (conflict) return conflict;

		if (checkBypass(body)) {
			return c.json({ success: true, bypassed: true });
		}

		// Save the summary as a memory
		if (!existsSync(MEMORY_DB)) {
			return c.json({ error: "Memory database not found" }, 500);
		}

		const now = new Date().toISOString();
		const scopedAgent = resolveScopedAgentId(c, resolveAgentId({ agentId: body.agentId, sessionKey: body.sessionKey }));
		if (scopedAgent.error) {
			return c.json({ error: scopedAgent.error }, 403);
		}
		const agentId = scopedAgent.agentId;
		const transcriptRow = body.sessionKey
			? getDbAccessor().withReadDb(
					(db) =>
						db
							.prepare(
								`SELECT project
							 FROM session_transcripts
							 WHERE session_key = ? AND agent_id = ?`,
							)
							.get(body.sessionKey, agentId) as { project: string | null } | undefined,
				)
			: undefined;
		const requestedProject = transcriptRow?.project ?? parseOptionalString(body.project);
		const scopedProject = resolveScopedProject(c, requestedProject);
		if (scopedProject.error) {
			return c.json({ error: scopedProject.error }, 403);
		}
		const project = scopedProject.project ?? null;
		const sessionId = body.sessionKey ?? `compaction:${now}`;
		const noise = isNoiseSession({
			project,
			sessionKey: body.sessionKey ?? null,
			sessionId,
			harness: body.harness,
		});
		const summaryId = noise ? null : crypto.randomUUID();
		if (!noise) {
			getDbAccessor().withWriteTx((db) => {
				db.prepare(
					`INSERT INTO memories (
						id, content, type, importance, source_id, source_type,
						who, tags, project, agent_id, created_at, updated_at, updated_by
					)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					summaryId,
					body.summary,
					"session_summary",
					0.8,
					body.sessionKey ?? null,
					body.harness,
					"system",
					`session,summary,${body.harness}`,
					project,
					agentId,
					now,
					now,
					"system",
				);

				const table = db
					.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'`)
					.get();
				if (!table) {
					return;
				}
				const nodeId = body.sessionKey ? `${body.sessionKey}:compaction:${Date.parse(now)}` : crypto.randomUUID();
				db.prepare(
					`INSERT OR REPLACE INTO session_summaries (
						id, project, depth, kind, content, token_count,
						earliest_at, latest_at, session_key, harness,
						agent_id, source_type, source_ref, meta_json, created_at
					) VALUES (?, ?, 0, 'session', ?, ?, ?, ?, ?, ?, ?, 'compaction', ?, ?, ?)`,
				).run(
					nodeId,
					project,
					body.summary,
					Math.ceil(body.summary.length / 4),
					now,
					now,
					body.sessionKey ?? null,
					body.harness,
					agentId,
					body.sessionKey ?? null,
					JSON.stringify({ source: "compaction-complete" }),
					now,
				);
				upsertThreadHead(db as unknown as Database, {
					agentId,
					nodeId,
					content: body.summary,
					latestAt: now,
					project,
					sessionKey: body.sessionKey ?? null,
					sourceType: "compaction",
					sourceRef: body.sessionKey ?? null,
					harness: body.harness,
				});
			});

			try {
				await writeCompactionArtifact({
					agentId,
					sessionId,
					sessionKey: body.sessionKey ?? null,
					project,
					harness: body.harness,
					capturedAt: now,
					startedAt: null,
					endedAt: null,
					summary: body.summary,
				});
			} catch (err) {
				logger.warn("hooks", "Compaction artifact write failed (non-fatal)", {
					error: err instanceof Error ? err.message : String(err),
					sessionKey: body.sessionKey,
				});
			}
		}

		logger.info("hooks", noise ? "Compaction summary skipped (noise session)" : "Compaction summary saved", {
			harness: body.harness,
			memoryId: summaryId ?? "skipped-temp-session",
		});

		// Compaction wipes conversation context — reset prompt-submit dedup
		// so previously-injected memories are eligible for re-injection.
		if (body.sessionKey) {
			resetPromptDedup(body.sessionKey);
		}

		// Compaction resets the message array to a short summary. Clear the
		// stored transcript and extract cursor so post-compaction inline
		// transcripts from event.messages can accumulate from byte 0.
		// Without this, the pre-compaction cursor would exceed the new
		// transcript length and every checkpoint would be skipped.
		if (body.sessionKey) {
			try {
				getDbAccessor().withWriteTx((db) => {
					const hasTx = db
						.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_transcripts'")
						.get();
					if (hasTx) {
						db.prepare("DELETE FROM session_transcripts WHERE session_key = ? AND agent_id = ?").run(
							body.sessionKey,
							agentId,
						);
					}
					const hasCur = db
						.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_extract_cursors'")
						.get();
					if (hasCur) {
						db.prepare("DELETE FROM session_extract_cursors WHERE session_key = ? AND agent_id = ?").run(
							body.sessionKey,
							agentId,
						);
					}
				});
			} catch (err) {
				logger.warn("hooks", "Failed to reset checkpoint state after compaction (non-fatal)", {
					error: err instanceof Error ? err.message : String(err),
					sessionKey: body.sessionKey,
				});
			}
		}

		void getSynthesisWorker()
			?.triggerNow({
				force: true,
				source: "compaction-complete",
				agentId,
			})
			.then((result) => {
				if (!result.skipped) return;
				logger.info("synthesis", "Skipped MEMORY.md synthesis after compaction", {
					reason: result.reason,
					sessionKey: body.sessionKey,
				});
			})
			.catch((error) => {
				logger.warn("synthesis", "Failed to trigger MEMORY.md synthesis after compaction", {
					error: error instanceof Error ? error.message : String(error),
				});
			});

		return c.json({
			success: true,
			memoryId: summaryId,
		});
	} catch (e) {
		logger.error("hooks", "Compaction complete failed", e as Error);
		return c.json({ error: "Failed to save summary" }, 500);
	}
});

const AGENT_MESSAGE_TYPES: readonly AgentMessageType[] = ["assist_request", "decision_update", "info", "question"];
const MAX_CROSS_AGENT_MESSAGE_CHARS = 65_536;

function parseAgentMessageType(value: string | undefined): AgentMessageType | undefined {
	if (!value) return undefined;
	for (const type of AGENT_MESSAGE_TYPES) {
		if (type === value) return type;
	}
	return undefined;
}

// ============================================================================
// Cross-Agent Collaboration API
// ============================================================================

app.get("/api/cross-agent/presence", (c) => {
	const includeSelf = parseOptionalBoolean(c.req.query("include_self")) ?? false;
	const limit = parseOptionalInt(c.req.query("limit")) ?? 50;
	const requestedAgentId = parseOptionalString(c.req.query("agent_id"));
	const sessionKey = parseOptionalString(c.req.query("session_key"));
	const project = parseOptionalString(c.req.query("project"));
	const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
	if (scopedAgent.error) {
		return c.json({ error: scopedAgent.error }, 403);
	}
	const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
		requireExisting: true,
		context: "session_key",
	});
	if (sessionError) {
		return c.json({ error: sessionError }, 403);
	}

	const sessions = listAgentPresence({
		agentId: scopedAgent.agentId,
		sessionKey,
		project,
		includeSelf,
		limit,
	});

	return c.json({
		sessions,
		count: sessions.length,
	});
});

app.post("/api/cross-agent/presence", async (c) => {
	const payload = await readOptionalJsonObject(c);
	if (payload === null) {
		return c.json({ error: "invalid request body" }, 400);
	}

	const harness = parseOptionalString(payload.harness);
	if (!harness) {
		return c.json({ error: "harness is required" }, 400);
	}

	const runtimePathRaw = parseOptionalString(payload.runtimePath);
	const runtimePath = runtimePathRaw === "plugin" || runtimePathRaw === "legacy" ? runtimePathRaw : undefined;
	const sessionKey = parseOptionalString(payload.sessionKey);
	// Resolve agent using the same fallback chain as hook paths: explicit
	// agentId takes precedence, then the scope encoded in the session key
	// (agent:<id>:<uuid>), then "default".
	const requestedAgentId = resolveAgentId({ agentId: parseOptionalString(payload.agentId), sessionKey });
	const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
	if (scopedAgent.error) {
		return c.json({ error: scopedAgent.error }, 403);
	}
	const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
		requireExisting: false,
		context: "sessionKey",
	});
	if (sessionError) {
		return c.json({ error: sessionError }, 403);
	}

	const presence = upsertAgentPresence({
		sessionKey,
		agentId: scopedAgent.agentId,
		harness,
		project: parseOptionalString(payload.project),
		runtimePath,
		provider: parseOptionalString(payload.provider) ?? harness,
	});

	return c.json({ presence });
});

app.delete("/api/cross-agent/presence/:sessionKey", (c) => {
	const sessionKey = c.req.param("sessionKey");
	const scopedAgent = resolveScopedAgentId(c, undefined, "default");
	if (scopedAgent.error) {
		return c.json({ error: scopedAgent.error }, 403);
	}
	const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
		requireExisting: false,
		context: "sessionKey",
	});
	if (sessionError) {
		return c.json({ error: sessionError }, 403);
	}
	const removed = removeAgentPresence(sessionKey);
	return c.json({ removed });
});

app.get("/api/cross-agent/messages", (c) => {
	const requestedAgentId = parseOptionalString(c.req.query("agent_id"));
	const sessionKey = parseOptionalString(c.req.query("session_key"));
	const since = parseOptionalString(c.req.query("since"));
	const includeSent = parseOptionalBoolean(c.req.query("include_sent")) ?? false;
	const includeBroadcast = parseOptionalBoolean(c.req.query("include_broadcast")) ?? true;
	const limit = parseOptionalInt(c.req.query("limit")) ?? 100;
	const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
	if (scopedAgent.error) {
		return c.json({ error: scopedAgent.error }, 403);
	}
	const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
		requireExisting: true,
		context: "session_key",
	});
	if (sessionError) {
		return c.json({ error: sessionError }, 403);
	}

	const items = listAgentMessages({
		agentId: scopedAgent.agentId,
		sessionKey,
		since,
		includeSent,
		includeBroadcast,
		limit,
	});

	return c.json({
		items,
		count: items.length,
	});
});

app.post("/api/cross-agent/messages", async (c) => {
	const payload = await readOptionalJsonObject(c);
	if (payload === null) {
		return c.json({ error: "invalid request body" }, 400);
	}

	const content = parseOptionalString(payload.content);
	if (!content) {
		return c.json({ error: "content is required" }, 400);
	}
	if (content.length > MAX_CROSS_AGENT_MESSAGE_CHARS) {
		return c.json({ error: `content too large (max ${MAX_CROSS_AGENT_MESSAGE_CHARS} chars)` }, 400);
	}

	const deliveryPathRaw = parseOptionalString(payload.via);
	const deliveryPath = deliveryPathRaw === "acp" ? "acp" : "local";

	const rawType = parseOptionalString(payload.type);
	const parsedType = parseAgentMessageType(rawType);
	if (rawType && !parsedType) {
		return c.json({ error: `unsupported message type '${rawType}'` }, 400);
	}
	const type = parsedType ?? "info";
	const broadcast = parseOptionalBoolean(payload.broadcast) ?? false;
	const fromAgentId = parseOptionalString(payload.fromAgentId);
	const scopedSender = resolveScopedAgentId(c, fromAgentId, "default");
	if (scopedSender.error) {
		return c.json({ error: scopedSender.error }, 403);
	}
	const fromSessionKey = parseOptionalString(payload.fromSessionKey);
	const fromSessionError = validateSessionAgentBinding(c, fromSessionKey, scopedSender.agentId, {
		requireExisting: true,
		context: "fromSessionKey",
	});
	if (fromSessionError) {
		return c.json({ error: fromSessionError }, 403);
	}
	const toAgentId = parseOptionalString(payload.toAgentId);
	const toSessionKey = parseOptionalString(payload.toSessionKey);
	const hasLocalTarget = broadcast || !!toAgentId || !!toSessionKey;
	if (deliveryPath === "local" && !hasLocalTarget) {
		return c.json({ error: "local target required (toAgentId, toSessionKey, or broadcast=true)" }, 400);
	}

	let deliveryStatus: "queued" | "delivered" | "failed" = "delivered";
	let deliveryError: string | undefined;
	let deliveryReceipt: Record<string, unknown> | undefined;

	if (deliveryPath === "acp") {
		const acpPayload = toRecord(payload.acp);
		const baseUrl = parseOptionalString(acpPayload?.baseUrl) ?? parseOptionalString(acpPayload?.url);
		const targetAgentName =
			parseOptionalString(acpPayload?.targetAgentName) ?? parseOptionalString(acpPayload?.agentName);

		if (!baseUrl || !targetAgentName) {
			return c.json(
				{
					error: "acp.baseUrl and acp.targetAgentName are required when via='acp'",
				},
				400,
			);
		}

		const timeoutMs = parseOptionalInt(acpPayload?.timeoutMs);
		const metadata = toRecord(acpPayload?.metadata) ?? undefined;

		const relay = await relayMessageViaAcp({
			baseUrl,
			targetAgentName,
			content,
			fromAgentId: scopedSender.agentId,
			fromSessionKey,
			timeoutMs,
			metadata,
		});

		deliveryStatus = relay.ok ? "delivered" : "failed";
		deliveryError = relay.error;
		const receipt: Record<string, unknown> = {
			status: relay.status,
		};
		if (relay.runId) {
			receipt.runId = relay.runId;
		}
		deliveryReceipt = receipt;
	}

	let message: AgentMessage;
	try {
		message = createAgentMessage({
			fromAgentId: scopedSender.agentId,
			fromSessionKey,
			toAgentId,
			toSessionKey,
			content,
			type,
			broadcast,
			deliveryPath,
			deliveryStatus,
			deliveryError,
			deliveryReceipt,
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return c.json({ error: msg }, 400);
	}

	return c.json({ message });
});

app.get("/api/cross-agent/stream", (c) => {
	const requestedAgentId = parseOptionalString(c.req.query("agent_id"));
	const sessionKey = parseOptionalString(c.req.query("session_key"));
	const project = parseOptionalString(c.req.query("project"));
	const includeSelf = parseOptionalBoolean(c.req.query("include_self")) ?? false;
	const includeSent = parseOptionalBoolean(c.req.query("include_sent")) ?? false;
	const encoder = new TextEncoder();
	const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
	if (scopedAgent.error) {
		return c.json({ error: scopedAgent.error }, 403);
	}
	const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
		requireExisting: true,
		context: "session_key",
	});
	if (sessionError) {
		return c.json({ error: sessionError }, 403);
	}
	const agentId = scopedAgent.agentId;

	const stream = new ReadableStream({
		start(controller) {
			let dead = false;
			const cleanup = () => {
				if (dead) return;
				dead = true;
				clearInterval(keepAlive);
				unsubscribe();
				try {
					controller.close();
				} catch {}
			};

			const writeEvent = (event: unknown) => {
				if (dead) return;
				try {
					const data = `data: ${JSON.stringify(event)}\n\n`;
					controller.enqueue(encoder.encode(data));
				} catch {
					cleanup();
				}
			};

			writeEvent({
				type: "connected",
				agentId,
				sessionKey,
				project,
				timestamp: new Date().toISOString(),
			});

			writeEvent({
				type: "snapshot",
				presence: listAgentPresence({
					agentId,
					sessionKey,
					project,
					includeSelf,
					limit: 50,
				}),
				messages: listAgentMessages({
					agentId,
					sessionKey,
					includeSent,
					includeBroadcast: true,
					limit: 20,
				}),
				timestamp: new Date().toISOString(),
			});

			const unsubscribe = subscribeCrossAgentEvents((event) => {
				if (event.type === "message") {
					if (
						!isMessageVisibleToAgent(event.message, {
							agentId,
							sessionKey,
							includeBroadcast: true,
						})
					) {
						if (!(includeSent && event.message.fromAgentId === agentId)) {
							return;
						}
					}
				}

				if (event.type === "presence" && !includeSelf && event.presence.agentId === agentId) {
					if (!sessionKey) {
						return;
					}
					if (!event.presence.sessionKey || event.presence.sessionKey === sessionKey) {
						return;
					}
				}
				if (event.type === "presence" && project && event.presence.project !== project) {
					return;
				}

				writeEvent(event);
			});

			const keepAlive = setInterval(() => {
				if (dead) return;
				try {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
				} catch {
					cleanup();
				}
			}, 15_000);

			c.req.raw.signal.addEventListener("abort", cleanup);
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
});

// Get synthesis config
app.get("/api/hooks/synthesis/config", (c) => {
	const config = loadMemoryConfig(AGENTS_DIR).pipelineV2.synthesis;
	return c.json(config);
});

// Request MEMORY.md synthesis
app.post("/api/hooks/synthesis", async (c) => {
	try {
		const body = (await c.req.json()) as SynthesisRequest & { agentId?: string; sessionKey?: string };
		const scopedAgent = resolveScopedAgentId(
			c,
			resolveAgentId({
				agentId: body.agentId ?? c.req.header("x-signet-agent-id"),
				sessionKey: body.sessionKey ?? c.req.header("x-signet-session-key"),
			}),
		);
		if (scopedAgent.error) {
			return c.json({ error: scopedAgent.error }, 403);
		}
		const result = handleSynthesisRequest(body, { agentId: scopedAgent.agentId });
		return c.json(result);
	} catch (e) {
		logger.error("hooks", "Synthesis request failed", e as Error);
		return c.json({ error: "Synthesis request failed" }, 500);
	}
});

// Save synthesized MEMORY.md
app.post("/api/hooks/synthesis/complete", async (c) => {
	try {
		const body = (await c.req.json()) as { content: string; agentId?: string; sessionKey?: string };

		if (!body.content) {
			return c.json({ error: "content is required" }, 400);
		}

		const worker = getSynthesisWorker();
		if (!worker) {
			return c.json({ error: "Synthesis worker not running" }, 503);
		}

		let lockToken: number | null = null;
		if (!worker.running) {
			return c.json({ error: "Synthesis worker is shutting down" }, 503);
		}

		lockToken = worker.acquireWriteLock();
		if (lockToken === null) {
			return worker.running
				? c.json({ error: "Synthesis already in progress" }, 409)
				: c.json({ error: "Synthesis worker is shutting down" }, 503);
		}

		try {
			const scopedAgent = resolveScopedAgentId(
				c,
				resolveAgentId({
					agentId: body.agentId ?? c.req.header("x-signet-agent-id"),
					sessionKey: body.sessionKey ?? c.req.header("x-signet-session-key"),
				}),
			);
			if (scopedAgent.error) {
				return c.json({ error: scopedAgent.error }, 403);
			}
			const result = writeMemoryMd(body.content, {
				agentId: scopedAgent.agentId,
				owner: "api-hooks-synthesis-complete",
			});
			if (!result.ok) {
				const status = result.code === "busy" ? 409 : 400;
				return c.json({ error: result.error }, status);
			}
			logger.info("hooks", "MEMORY.md synthesized");
		} finally {
			if (worker && lockToken !== null) {
				worker.releaseWriteLock(lockToken);
			}
		}

		return c.json({ success: true });
	} catch (e) {
		logger.error("hooks", "Synthesis complete failed", e instanceof Error ? e : new Error(String(e)));
		return c.json({ error: "Failed to save MEMORY.md" }, 500);
	}
});

// Trigger immediate MEMORY.md synthesis
app.post("/api/synthesis/trigger", async (c) => {
	try {
		const worker = getSynthesisWorker();
		if (!worker) {
			return c.json({ error: "Synthesis worker not running" }, 503);
		}
		const result = await worker.triggerNow();
		return c.json(result);
	} catch (e) {
		logger.error("synthesis", "Synthesis trigger failed", e as Error);
		return c.json({ error: "Synthesis trigger failed" }, 500);
	}
});

// Synthesis worker status
app.get("/api/synthesis/status", (c) => {
	const worker = getSynthesisWorker();
	const config = loadMemoryConfig(AGENTS_DIR).pipelineV2.synthesis;
	const lastRunAt = readLastSynthesisTime();
	return c.json({
		running: worker?.running ?? false,
		lastRunAt: lastRunAt > 0 ? new Date(lastRunAt).toISOString() : null,
		config,
	});
});

// ============================================================================
// Session API
// ============================================================================

// List active sessions for the requesting agent with bypass status.
// Cross-agent session visibility is intentionally served by
// /api/cross-agent/presence — surfacing other agents' sessions here
// would violate per-agent data scoping (CLAUDE.md §agent-scoping).
// Optional ?agent_id= query param to target a specific agent's sessions.
app.get("/api/sessions", (c) => {
	const scopedAgent = resolveScopedAgentId(c, c.req.query("agent_id"), "default");
	if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
	const sessions = listLiveSessions(scopedAgent.agentId);
	return c.json({ sessions, count: sessions.length });
});

// Get single session status
// Optional ?agent_id= query param to target a specific agent's session.
app.get("/api/sessions/:key{(?!summaries$)[^/]+}", (c) => {
	const scopedAgent = resolveScopedAgentId(c, c.req.query("agent_id"), "default");
	if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
	const key = normalizeSessionKey(c.req.param("key"));
	const sessions = listLiveSessions(scopedAgent.agentId);
	const session = sessions.find((s) => s.key === key);
	if (!session) {
		return c.json({ error: "Session not found" }, 404);
	}
	return c.json(session);
});

// Toggle bypass for a session
// Optional ?agent_id= query param to target a specific agent's session.
app.post("/api/sessions/:key{(?!summaries$)[^/]+}/bypass", async (c) => {
	const scopedAgent = resolveScopedAgentId(c, c.req.query("agent_id"), "default");
	if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
	const key = normalizeSessionKey(c.req.param("key"));
	const sessions = listLiveSessions(scopedAgent.agentId);
	const session = sessions.find((s) => s.key === key);
	if (!session) {
		return c.json({ error: "Session not found" }, 404);
	}

	const body = await readOptionalJsonObject(c);
	if (!body || typeof body.enabled !== "boolean") {
		return c.json({ error: "enabled (boolean) is required" }, 400);
	}
	const enabled = body.enabled === true;

	if (enabled) {
		// allowUnknown for presence-only sessions (expiresAt === null means no
		// tracker claim) — bypassSession checks sessions.has(key) otherwise.
		const ok = bypassSession(key, { allowUnknown: session.expiresAt === null });
		if (!ok) {
			return c.json({ error: "Session not found or already released" }, 404);
		}
	} else {
		// unbypassSession is unconditional — bypassedSessions.delete() is a
		// safe no-op for unknown keys, so no allowUnknown guard is needed.
		unbypassSession(key);
	}
	return c.json({ key, bypassed: enabled });
});

// Renew a session — reset TTL to prevent silent eviction
// Optional ?agent_id= query param to target a specific agent's session.
app.post("/api/sessions/:key{(?!summaries$)[^/]+}/renew", (c) => {
	const scopedAgent = resolveScopedAgentId(c, c.req.query("agent_id"), "default");
	if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
	const key = normalizeSessionKey(c.req.param("key"));
	const session = listLiveSessions(scopedAgent.agentId).find((s) => s.key === key);
	if (!session) {
		return c.json({ error: "Session not found" }, 404);
	}
	// Presence-only sessions (expiresAt === null) have no tracker claim —
	// renewSession would return null, but the session is live via cross-agent
	// presence. Refresh last_seen_at so the 4-hour stale filter doesn't evict it.
	// Pass agentId so touchAgentPresence verifies record ownership before touching.
	if (session.expiresAt === null) {
		touchAgentPresence(key, scopedAgent.agentId);
		return c.json({ key, renewed: true });
	}
	const expiresAt = renewSession(key);
	if (!expiresAt) {
		return c.json({ error: "Session not found or expired" }, 404);
	}
	return c.json({ key, renewed: true, expiresAt });
});

// Session summaries DAG
app.get("/api/sessions/summaries", (c) => {
	const accessor = getDbAccessor();
	const scopedAgent = resolveScopedAgentId(
		c,
		resolveAgentId({
			agentId: c.req.query("agentId") ?? c.req.header("x-signet-agent-id"),
			sessionKey: c.req.query("sessionKey") ?? c.req.header("x-signet-session-key"),
		}),
	);
	if (scopedAgent.error) {
		return c.json({ error: scopedAgent.error }, 403);
	}
	const scopedProject = resolveScopedProject(c, c.req.query("project"));
	if (scopedProject.error) {
		return c.json({ error: scopedProject.error }, 403);
	}
	const agentId = scopedAgent.agentId;
	const project = scopedProject.project;
	const depthRaw = c.req.query("depth");
	const depthNum = depthRaw !== undefined ? Number(depthRaw) : undefined;
	if (
		depthNum !== undefined &&
		(Number.isNaN(depthNum) || !Number.isInteger(depthNum) || depthNum < 0 || depthRaw?.trim() === "")
	) {
		return c.json({ error: "depth must be a non-negative integer" }, 400);
	}
	const limitParsed = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const offsetParsed = Number.parseInt(c.req.query("offset") ?? "0", 10);
	const limit = Number.isFinite(limitParsed) ? Math.min(Math.max(limitParsed, 0), 200) : 50;
	const offset = Number.isFinite(offsetParsed) ? Math.max(offsetParsed, 0) : 0;

	// Check table exists
	const tableExists = accessor.withReadDb((db) =>
		db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'`).get(),
	);
	if (!tableExists) {
		return c.json({ summaries: [], total: 0 });
	}

	return accessor.withReadDb((db) => {
		let where = "WHERE agent_id = ?";
		const params: unknown[] = [agentId];

		if (project) {
			where += " AND project = ?";
			params.push(project);
		}
		if (depthNum !== undefined) {
			where += " AND depth = ?";
			params.push(depthNum);
		}

		const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM session_summaries ${where}`).get(...params) as
			| { cnt: number }
			| undefined;

		const summaries = db
			.prepare(
				`SELECT id, project, depth, kind, content, token_count,
				        earliest_at, latest_at, session_key, harness, agent_id,
				        source_type, source_ref, meta_json, created_at
				 FROM session_summaries
				 ${where}
				 ORDER BY latest_at DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(...params, limit, offset) as Array<Record<string, unknown>>;

		const childCountStmt = db.prepare("SELECT COUNT(*) as cnt FROM session_summary_children WHERE parent_id = ?");

		const enriched = summaries.map((s) => {
			const childRow = childCountStmt.get(s.id) as { cnt: number } | undefined;
			return { ...s, childCount: childRow?.cnt ?? 0 };
		});

		return c.json({
			summaries: enriched,
			total: countRow?.cnt ?? 0,
		});
	});
});

app.post("/api/sessions/summaries/expand", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const id = typeof body.id === "string" ? body.id.trim() : "";
	if (!id) {
		return c.json({ error: "id is required" }, 400);
	}

	const includeTranscript = typeof body.includeTranscript === "boolean" ? body.includeTranscript : true;
	const transcriptCharLimit =
		typeof body.transcriptCharLimit === "number" && Number.isFinite(body.transcriptCharLimit)
			? Math.max(200, Math.min(12000, Math.trunc(body.transcriptCharLimit)))
			: undefined;
	const scopedAgent = resolveScopedAgentId(
		c,
		resolveAgentId({
			agentId: typeof body.agentId === "string" ? body.agentId : c.req.header("x-signet-agent-id"),
			sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : c.req.header("x-signet-session-key"),
		}),
	);
	if (scopedAgent.error) {
		return c.json({ error: scopedAgent.error }, 403);
	}
	const scopedProject = resolveScopedProject(c, undefined);
	if (scopedProject.error) {
		return c.json({ error: scopedProject.error }, 403);
	}

	const result = expandTemporalNode(id, scopedAgent.agentId, {
		includeTranscript,
		project: scopedProject.project,
		transcriptCharLimit,
	});
	if (!result) {
		return c.json({ error: "summary node not found" }, 404);
	}
	return c.json(result);
});

// ============================================================================
// Git Sync API
// ============================================================================

// Get git status
app.get("/api/git/status", async (c) => {
	const status = await getGitStatus();
	return c.json(status);
});

// Pull changes from remote
app.post("/api/git/pull", async (c) => {
	const result = await gitPull();
	return c.json(result);
});

// Push changes to remote
app.post("/api/git/push", async (c) => {
	const result = await gitPush();
	return c.json(result);
});

// Full sync (pull + push)
app.post("/api/git/sync", async (c) => {
	const result = await gitSync();
	return c.json(result);
});

// Get/set git config
app.get("/api/git/config", (c) => {
	return c.json(gitConfig);
});

app.post("/api/git/config", async (c) => {
	const body = (await c.req.json()) as Partial<GitConfig>;

	// Update in-memory config
	if (body.autoSync !== undefined) gitConfig.autoSync = body.autoSync;
	if (body.syncInterval !== undefined) gitConfig.syncInterval = body.syncInterval;
	if (body.remote) gitConfig.remote = body.remote;
	if (body.branch) gitConfig.branch = body.branch;

	// Restart sync timer if needed
	if (body.autoSync !== undefined || body.syncInterval !== undefined) {
		stopGitSyncTimer();
		if (gitConfig.autoSync) {
			startGitSyncTimer();
		}
	}

	return c.json({ success: true, config: gitConfig });
});

// ============================================================================
// Update System (extracted to ./update-system.ts)
// ============================================================================

// API: Check for updates
app.get("/api/update/check", async (c) => {
	const force = c.req.query("force") === "true";
	const us = getUpdateState();

	if (!force && us.lastCheck && us.lastCheckTime) {
		const age = Date.now() - us.lastCheckTime.getTime();
		if (age < 3600000) {
			return c.json({
				...us.lastCheck,
				cached: true,
				checkedAt: us.lastCheckTime.toISOString(),
			});
		}
	}

	const result = await checkForUpdatesImpl();
	const after = getUpdateState();
	return c.json({
		...result,
		cached: false,
		checkedAt: after.lastCheckTime?.toISOString(),
	});
});

// API: Get/set update config
app.get("/api/update/config", (c) => {
	const us = getUpdateState();
	return c.json({
		...us.config,
		minInterval: MIN_UPDATE_INTERVAL_SECONDS,
		maxInterval: MAX_UPDATE_INTERVAL_SECONDS,
		pendingRestartVersion: us.pendingRestartVersion,
		lastAutoUpdateAt: us.lastAutoUpdateAt?.toISOString(),
		lastAutoUpdateError: us.lastAutoUpdateError,
		updateInProgress: us.installInProgress,
	});
});

app.post("/api/update/config", async (c) => {
	type UpdateConfigBody = Partial<{
		autoInstall: boolean | string;
		auto_install: boolean | string;
		checkInterval: number | string;
		check_interval: number | string;
	}>;

	const body = (await c.req.json()) as UpdateConfigBody;
	const autoInstallRaw = body.autoInstall ?? body.auto_install;
	const checkIntervalRaw = body.checkInterval ?? body.check_interval;

	let autoInstall: boolean | undefined;
	let checkInterval: number | undefined;

	if (autoInstallRaw !== undefined) {
		const parsed = parseBooleanFlag(autoInstallRaw);
		if (parsed === null) {
			return c.json({ success: false, error: "autoInstall must be true or false" }, 400);
		}
		autoInstall = parsed;
	}

	if (checkIntervalRaw !== undefined) {
		const parsed = parseUpdateInterval(checkIntervalRaw);
		if (parsed === null) {
			return c.json(
				{
					success: false,
					error: `checkInterval must be between ${MIN_UPDATE_INTERVAL_SECONDS} and ${MAX_UPDATE_INTERVAL_SECONDS} seconds`,
				},
				400,
			);
		}
		checkInterval = parsed;
	}

	const changed = autoInstall !== undefined || checkInterval !== undefined;
	let persisted = true;

	if (changed) {
		const result = setUpdateConfig({ autoInstall, checkInterval });
		persisted = result.persisted;
	}

	const us = getUpdateState();
	return c.json({
		success: true,
		config: us.config,
		persisted,
		pendingRestartVersion: us.pendingRestartVersion,
		lastAutoUpdateAt: us.lastAutoUpdateAt?.toISOString(),
		lastAutoUpdateError: us.lastAutoUpdateError,
	});
});

// API: Run update
// Accepts optional { targetVersion } in body to skip redundant version check
app.post("/api/update/run", async (c) => {
	let targetVersion: string | undefined;

	try {
		const body = await c.req.json<{ targetVersion?: string }>();
		if (body.targetVersion && typeof body.targetVersion === "string") {
			targetVersion = body.targetVersion;
		}
	} catch {
		// No body or invalid JSON — fall through to check
	}

	// If caller already knows the target version, skip the redundant check
	if (!targetVersion) {
		const check = await checkForUpdatesImpl();

		if (check.restartRequired && !check.updateAvailable) {
			return c.json({
				success: true,
				message: `Update ${check.pendingVersion || check.latestVersion || "already"} installed. Restart daemon to apply.`,
				installedVersion: check.pendingVersion || check.latestVersion,
				restartRequired: true,
			});
		}

		if (!check.updateAvailable && check.latestVersion) {
			return c.json({
				success: true,
				message: "Already running the latest version.",
				installedVersion: check.latestVersion,
				restartRequired: false,
			});
		}

		targetVersion = check.latestVersion ?? undefined;
	}

	const result = await runUpdateImpl(targetVersion);
	return c.json(result);
});

// ============================================================================
// Scheduled Tasks API
// ============================================================================

app.get("/api/tasks/:id/stream", (c) => {
	const taskId = c.req.param("id");

	const taskExists = getDbAccessor().withReadDb((db) =>
		db.prepare("SELECT 1 FROM scheduled_tasks WHERE id = ?").get(taskId),
	);

	if (!taskExists) {
		return c.json({ error: "Task not found" }, 404);
	}

	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		start(controller) {
			let dead = false;
			const cleanup = () => {
				if (dead) return;
				dead = true;
				clearInterval(keepAlive);
				unsubscribe();
			};

			const writeEvent = (event: unknown) => {
				if (dead) return;
				try {
					const data = `data: ${JSON.stringify(event)}\n\n`;
					controller.enqueue(encoder.encode(data));
				} catch {
					cleanup();
				}
			};

			writeEvent({
				type: "connected",
				taskId,
				timestamp: new Date().toISOString(),
			});

			const snapshot = getTaskStreamSnapshot(taskId);
			if (snapshot) {
				writeEvent({
					type: "run-started",
					taskId,
					runId: snapshot.runId,
					startedAt: snapshot.startedAt,
					timestamp: new Date().toISOString(),
				});

				for (const chunk of snapshot.stdoutChunks) {
					writeEvent({
						type: "run-output",
						taskId,
						runId: snapshot.runId,
						stream: "stdout",
						chunk,
						timestamp: new Date().toISOString(),
					});
				}

				for (const chunk of snapshot.stderrChunks) {
					writeEvent({
						type: "run-output",
						taskId,
						runId: snapshot.runId,
						stream: "stderr",
						chunk,
						timestamp: new Date().toISOString(),
					});
				}
			}

			const unsubscribe = subscribeTaskStream(taskId, (event) => {
				writeEvent(event);
			});

			const keepAlive = setInterval(() => {
				if (dead) return;
				try {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
				} catch {
					cleanup();
				}
			}, 15_000);

			c.req.raw.signal.addEventListener("abort", cleanup);
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
});

// List all tasks (joined with last run status)
app.get("/api/tasks", (c) => {
	const tasks = getDbAccessor().withReadDb((db) =>
		db
			.prepare(
				`SELECT t.*,
				        r.status AS last_run_status,
				        r.exit_code AS last_run_exit_code
				 FROM scheduled_tasks t
				 LEFT JOIN task_runs r ON r.id = (
				     SELECT id FROM task_runs
				     WHERE task_id = t.id
				     ORDER BY started_at DESC LIMIT 1
				 )
				 ORDER BY t.created_at DESC`,
			)
			.all(),
	);

	return c.json({ tasks, presets: CRON_PRESETS });
});

// Create a new task
app.post("/api/tasks", async (c) => {
	const scoped = resolveScopedAgentId(c, c.req.query("agent_id"));
	if (scoped.error) return c.json({ error: scoped.error }, 403);

	const body = await c.req.json();
	const { name, prompt, cronExpression, harness, workingDirectory, skillName, skillMode } = body;

	if (!name || !prompt || !cronExpression || !harness) {
		return c.json({ error: "name, prompt, cronExpression, and harness are required" }, 400);
	}

	if (!validateCron(cronExpression)) {
		return c.json({ error: "Invalid cron expression" }, 400);
	}

	if (harness !== "claude-code" && harness !== "opencode" && harness !== "codex") {
		return c.json({ error: "harness must be 'claude-code', 'codex', or 'opencode'" }, 400);
	}

	if (skillName && (skillName.includes("/") || skillName.includes(".."))) {
		return c.json({ error: "Invalid skill name" }, 400);
	}

	if (skillName && skillMode !== "inject" && skillMode !== "slash") {
		return c.json({ error: "skillMode must be 'inject' or 'slash' when skillName is set" }, 400);
	}

	if (!isHarnessAvailable(harness)) {
		return c.json(
			{
				error: `CLI for ${harness} not found on PATH`,
				warning: true,
			},
			400,
		);
	}

	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const nextRunAt = computeNextRun(cronExpression);

	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO scheduled_tasks
			 (id, name, prompt, cron_expression, harness, working_directory,
			  enabled, next_run_at, skill_name, skill_mode, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
		).run(
			id,
			name,
			prompt,
			cronExpression,
			harness,
			workingDirectory || null,
			nextRunAt,
			skillName || null,
			skillMode || null,
			now,
			now,
		);
		db.prepare(
			`INSERT INTO task_scope_hints (task_id, agent_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(task_id) DO UPDATE SET agent_id = excluded.agent_id, updated_at = excluded.updated_at`,
		).run(id, scoped.agentId, now, now);
	});

	logger.info("scheduler", `Task created: ${name}`, { taskId: id });
	return c.json({ id, nextRunAt }, 201);
});

// Get a single task + recent runs
app.get("/api/tasks/:id", (c) => {
	const taskId = c.req.param("id");

	const task = getDbAccessor().withReadDb((db) => db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(taskId));

	if (!task) {
		return c.json({ error: "Task not found" }, 404);
	}

	const runs = getDbAccessor().withReadDb((db) =>
		db
			.prepare(
				`SELECT * FROM task_runs
				 WHERE task_id = ?
				 ORDER BY started_at DESC
				 LIMIT 20`,
			)
			.all(taskId),
	);

	return c.json({ task, runs });
});

// Update a task
app.patch("/api/tasks/:id", async (c) => {
	const taskId = c.req.param("id");
	const body = await c.req.json();

	const existing = getDbAccessor().withReadDb((db) =>
		db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(taskId),
	) as Record<string, unknown> | undefined;

	if (!existing) {
		return c.json({ error: "Task not found" }, 404);
	}

	if (body.cronExpression !== undefined && !validateCron(body.cronExpression)) {
		return c.json({ error: "Invalid cron expression" }, 400);
	}

	const now = new Date().toISOString();
	const cronExpr = body.cronExpression ?? existing.cron_expression;
	const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled;
	const nextRunAt =
		body.cronExpression !== undefined || body.enabled !== undefined
			? enabled
				? computeNextRun(cronExpr as string)
				: existing.next_run_at
			: existing.next_run_at;

	const skillName = body.skillName !== undefined ? body.skillName || null : existing.skill_name;
	const skillMode = body.skillMode !== undefined ? body.skillMode || null : existing.skill_mode;

	if (skillName && (skillName.includes("/") || skillName.includes(".."))) {
		return c.json({ error: "Invalid skill name" }, 400);
	}

	if (skillName && skillMode !== null && skillMode !== "inject" && skillMode !== "slash") {
		return c.json({ error: "skillMode must be 'inject' or 'slash' when skillName is set" }, 400);
	}

	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`UPDATE scheduled_tasks SET
			 name = ?, prompt = ?, cron_expression = ?, harness = ?,
			 working_directory = ?, enabled = ?, next_run_at = ?,
			 skill_name = ?, skill_mode = ?, updated_at = ?
			 WHERE id = ?`,
		).run(
			body.name ?? existing.name,
			body.prompt ?? existing.prompt,
			cronExpr,
			body.harness ?? existing.harness,
			body.workingDirectory !== undefined ? body.workingDirectory : existing.working_directory,
			enabled,
			nextRunAt,
			skillName,
			skillMode,
			now,
			taskId,
		);
	});

	return c.json({ success: true });
});

// Delete a task (cascade deletes runs)
app.delete("/api/tasks/:id", (c) => {
	const taskId = c.req.param("id");

	const result = getDbAccessor().withWriteTx((db) => {
		const info = db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(taskId);
		return info;
	});

	return c.json({ success: true });
});

// Trigger an immediate manual run
app.post("/api/tasks/:id/run", async (c) => {
	const taskId = c.req.param("id");
	const scoped = resolveScopedAgentId(c, c.req.query("agent_id"));
	if (scoped.error) return c.json({ error: scoped.error }, 403);

	const task = getDbAccessor().withReadDb((db) =>
		readScopedTask(db, taskId, scoped.agentId, shouldEnforceAuthScope(c)),
	);

	if (!task) {
		return c.json({ error: "Task not found" }, 404);
	}

	// Check if already running
	const running = getDbAccessor().withReadDb((db) =>
		db.prepare("SELECT 1 FROM task_runs WHERE task_id = ? AND status = 'running' LIMIT 1").get(taskId),
	);

	if (running) {
		return c.json({ error: "Task is already running" }, 409);
	}

	const runId = crypto.randomUUID();
	const now = new Date().toISOString();

	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO task_runs (id, task_id, status, started_at)
			 VALUES (?, ?, 'running', ?)`,
		).run(runId, taskId, now);

		db.prepare("UPDATE scheduled_tasks SET last_run_at = ?, updated_at = ? WHERE id = ?").run(now, now, taskId);
	});

	emitTaskStream({
		type: "run-started",
		taskId,
		runId,
		startedAt: now,
		timestamp: new Date().toISOString(),
	});

	// Narrow task fields from raw SQL result
	const taskPrompt = typeof task.prompt === "string" ? task.prompt : null;
	const taskHarness =
		task.harness === "claude-code" || task.harness === "opencode" || task.harness === "codex" ? task.harness : null;
	if (!taskPrompt || !taskHarness) {
		return c.json({ error: "Task has invalid prompt or harness" }, 500);
	}
	const taskSkillName = typeof task.skill_name === "string" ? task.skill_name : null;
	const taskSkillMode = typeof task.skill_mode === "string" ? task.skill_mode : null;
	const taskWorkingDir = typeof task.working_directory === "string" ? task.working_directory : null;
	const taskAgentId = readTaskAgentId(task, scoped.agentId);

	// Resolve skill content into prompt
	const effectivePrompt = resolveSkillPrompt(taskPrompt, taskSkillName, taskSkillMode);
	const startedMs = Date.now();

	// Spawn in background (don't await)
	import("./scheduler/spawn").then((mod) => {
		mod
			.spawnTask(taskHarness, effectivePrompt, taskWorkingDir, undefined, {
				onStdoutChunk: (chunk) => {
					emitTaskStream({
						type: "run-output",
						taskId,
						runId,
						stream: "stdout",
						chunk,
						timestamp: new Date().toISOString(),
					});
				},
				onStderrChunk: (chunk) => {
					emitTaskStream({
						type: "run-output",
						taskId,
						runId,
						stream: "stderr",
						chunk,
						timestamp: new Date().toISOString(),
					});
				},
			})
			.then((result) => {
				const completedAt = new Date().toISOString();
				const status =
					result.error !== null || (result.exitCode !== null && result.exitCode !== 0) ? "failed" : "completed";

				getDbAccessor().withWriteTx((db) => {
					db.prepare(
						`UPDATE task_runs
					 SET status = ?, completed_at = ?, exit_code = ?,
					     stdout = ?, stderr = ?, error = ?
					 WHERE id = ?`,
					).run(status, completedAt, result.exitCode, result.stdout, result.stderr, result.error, runId);
				});

				emitTaskStream({
					type: "run-completed",
					taskId,
					runId,
					status,
					completedAt,
					exitCode: result.exitCode,
					error: result.error,
					timestamp: new Date().toISOString(),
				});

				if (taskSkillName) {
					void import("./skill-invocations.js").then((skills) => {
						skills.recordSkillInvocation({
							skillName: taskSkillName,
							agentId: taskAgentId,
							source: "api",
							latencyMs: Date.now() - startedMs,
							success: status === "completed",
							errorText: result.error ?? undefined,
						});
					});
				}
			});
	});

	return c.json({ runId, status: "running" }, 202);
});

// Get paginated run history for a task
app.get("/api/tasks/:id/runs", (c) => {
	const taskId = c.req.param("id");
	const limit = Number(c.req.query("limit") ?? 20);
	const offset = Number(c.req.query("offset") ?? 0);

	const runs = getDbAccessor().withReadDb((db) =>
		db
			.prepare(
				`SELECT * FROM task_runs
				 WHERE task_id = ?
				 ORDER BY started_at DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(taskId, limit, offset),
	);

	const total = getDbAccessor().withReadDb((db) => {
		const row = db.prepare("SELECT COUNT(*) as count FROM task_runs WHERE task_id = ?").get(taskId) as {
			count: number;
		};
		return row.count;
	});

	return c.json({ runs, total, hasMore: offset + limit < total });
});

// ============================================================================
// Daemon Info
// ============================================================================

app.get("/api/status", (c) => {
	const config = loadMemoryConfig(AGENTS_DIR);
	const workerStatus = getPipelineWorkerStatus();
	const extractionWorker = workerStatus.extraction;
	const configuredLogFile = readEnvTrimmed("SIGNET_LOG_FILE");
	const configuredLogDir = readEnvTrimmed("SIGNET_LOG_DIR") ?? LOG_DIR;
	const datedLogFile = join(configuredLogDir, `signet-${new Date().toISOString().slice(0, 10)}.log`);

	let health: { score: number; status: string } | undefined;
	try {
		const report = getCachedDiagnosticsReport();
		health = report.composite;
	} catch {
		// DB not ready yet — omit health
	}

	const us = getUpdateState();

	// Read agent.created from agent.yaml for agentCreatedAt
	let agentCreatedAt: string | null = null;
	try {
		for (const p of [join(AGENTS_DIR, "agent.yaml"), join(AGENTS_DIR, "AGENT.yaml")]) {
			if (existsSync(p)) {
				const yaml = parseSimpleYaml(readFileSync(p, "utf-8"));
				const agent = yaml.agent as Record<string, unknown> | undefined;
				if (agent?.created) {
					agentCreatedAt = String(agent.created);
				}
				break;
			}
		}
	} catch {
		/* ignore parse errors */
	}

	return c.json({
		status: "running",
		version: CURRENT_VERSION,
		pid: process.pid,
		uptime: process.uptime(),
		startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
		port: PORT,
		host: HOST,
		bindHost: BIND_HOST,
		networkMode: NETWORK_MODE,
		agentsDir: AGENTS_DIR,
		memoryDb: existsSync(MEMORY_DB),
		pipelineV2: config.pipelineV2,
		pipeline: {
			extraction: {
				running: extractionWorker.running,
				overloaded: extractionWorker.stats?.overloaded ?? false,
				loadPerCpu: extractionWorker.stats?.loadPerCpu ?? null,
				maxLoadPerCpu: extractionWorker.stats?.maxLoadPerCpu ?? null,
				overloadBackoffMs: extractionWorker.stats?.overloadBackoffMs ?? null,
				overloadSince: extractionWorker.stats?.overloadSince ?? null,
				nextTickInMs: extractionWorker.stats?.nextTickInMs ?? null,
			},
		},
		providerResolution: providerRuntimeResolution,
		logging: {
			logDir: configuredLogFile ? dirname(configuredLogFile) : configuredLogDir,
			logFile: configuredLogFile ?? datedLogFile,
		},
		activeSessions: activeSessionCount(),
		bypassedSessions: getBypassedSessionKeys().size,
		agentCreatedAt,
		...(health ? { health } : {}),
		update: {
			currentVersion: us.currentVersion,
			latestVersion: us.lastCheck?.latestVersion ?? null,
			updateAvailable: us.lastCheck?.updateAvailable ?? false,
			pendingRestart: us.pendingRestartVersion,
			autoInstall: us.config.autoInstall,
			checkInterval: us.config.checkInterval,
			lastCheckAt: us.lastCheckTime?.toISOString() ?? null,
			lastError: us.lastAutoUpdateError,
			timerActive: us.timerActive,
		},
		embedding: {
			provider: config.embedding.provider,
			model: config.embedding.model,
			// Don't block on status check for /api/status - use cached if available
			...(cachedEmbeddingStatus && Date.now() - statusCacheTime < STATUS_CACHE_TTL
				? { available: cachedEmbeddingStatus.available }
				: {}),
		},
	});
});

// ============================================================================
// Home greeting
// ============================================================================

let greetingCache: { greeting: string; cachedAt: string; expires: number } | null = null;

app.get("/api/home/greeting", async (c) => {
	const now = Date.now();
	if (greetingCache && now < greetingCache.expires) {
		return c.json({ greeting: greetingCache.greeting, cachedAt: greetingCache.cachedAt });
	}

	// Read SOUL.md for voice context
	const soulPath = join(AGENTS_DIR, "SOUL.md");
	let soulContent = "";
	try {
		soulContent = readFileSync(soulPath, "utf-8").slice(0, 500);
	} catch {
		/* no soul file */
	}

	const hour = new Date().getHours();
	const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

	// Try LLM greeting
	try {
		const provider = getLlmProvider();
		if (provider) {
			const prompt = `Given this agent personality description:\n\n${soulContent}\n\nGenerate a brief ${timeOfDay} greeting in this character's voice. Max 15 words. No emojis. No quotes around the greeting.`;
			const text = await provider.generate(prompt, { timeoutMs: 10000, maxTokens: 50 });
			const greeting = text.trim().replace(/^["']|["']$/g, "");
			greetingCache = { greeting, cachedAt: new Date().toISOString(), expires: now + 3600000 };
			return c.json({ greeting: greetingCache.greeting, cachedAt: greetingCache.cachedAt });
		}
	} catch {
		/* LLM unavailable */
	}

	// Fallback
	const fallback = `good ${timeOfDay}`;
	greetingCache = { greeting: fallback, cachedAt: new Date().toISOString(), expires: now + 3600000 };
	return c.json({ greeting: greetingCache.greeting, cachedAt: greetingCache.cachedAt });
});

// ============================================================================
// Diagnostics & Repair (Phase F)
// ============================================================================

app.get("/api/diagnostics", (c) => {
	const report = getCachedDiagnosticsReport();
	return c.json(report);
});

app.get("/api/diagnostics/:domain", (c) => {
	const domain = c.req.param("domain");
	const report = getCachedDiagnosticsReport();

	const domainData = report[domain as keyof typeof report];
	if (!domainData || typeof domainData === "string") {
		return c.json({ error: `Unknown domain: ${domain}` }, 400);
	}
	return c.json(domainData);
});

// ---------------------------------------------------------------------------
// OpenClaw plugin health diagnostics
// ---------------------------------------------------------------------------

// Unauthenticated — daemon is local-only, plugin may not carry auth token
app.post("/api/diagnostics/openclaw/heartbeat", async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON" }, 400);
	}
	if (!body || typeof body !== "object") {
		return c.json({ error: "Body must be an object" }, 400);
	}
	const b = body as Record<string, unknown>;
	if (typeof b.pluginVersion !== "string") {
		return c.json({ error: "pluginVersion (string) is required" }, 400);
	}
	const prev = openClawHeartbeat?.data;
	openClawHeartbeat = {
		timestamp: new Date().toISOString(),
		data: {
			pluginVersion: b.pluginVersion.slice(0, 128),
			hooksRegistered: Array.isArray(b.hooksRegistered)
				? (b.hooksRegistered as unknown[])
						.filter((x): x is string => typeof x === "string")
						.map((s) => s.slice(0, 128))
						.slice(0, 50)
				: [],
			lastHookCall: typeof b.lastHookCall === "string" ? b.lastHookCall.slice(0, 512) : null,
			lastError: typeof b.lastError === "string" ? b.lastError.slice(0, 512) : null,
			latencyMs: typeof b.latencyMs === "number" && Number.isFinite(b.latencyMs) ? b.latencyMs : 0,
			// Plugin sends per-heartbeat deltas, not cumulative totals. Clamp to
			// non-negative to guard against malformed or negative inputs corrupting counters.
			lastFailedDelta: Math.max(
				0,
				typeof b.hooksFailed === "number" ? b.hooksFailed : typeof b.errorCount === "number" ? b.errorCount : 0,
			),
			totalSucceeded:
				(prev?.totalSucceeded ?? 0) + Math.max(0, typeof b.hooksSucceeded === "number" ? b.hooksSucceeded : 0),
			totalFailed:
				(prev?.totalFailed ?? 0) +
				Math.max(
					0,
					typeof b.hooksFailed === "number" ? b.hooksFailed : typeof b.errorCount === "number" ? b.errorCount : 0,
				),
		},
	};
	invalidateDiagnosticsCache();
	return c.json({ ok: true });
});

app.get("/api/diagnostics/openclaw", (c) => {
	return c.json(buildOpenClawHealth());
});

// ---------------------------------------------------------------------------
// Pipeline status (composite snapshot for dashboard visualization)
// ---------------------------------------------------------------------------

app.get("/api/pipeline/status", (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const accessor = getDbAccessor();

	const dbData = accessor.withReadDb((db) => {
		const memoryRows = db.prepare("SELECT status, COUNT(*) as count FROM memory_jobs GROUP BY status").all() as Array<{
			status: string;
			count: number;
		}>;
		const summaryRows = db
			.prepare("SELECT status, COUNT(*) as count FROM summary_jobs GROUP BY status")
			.all() as Array<{ status: string; count: number }>;

		const toCountMap = (rows: Array<{ status: string; count: number }>): Record<string, number> => {
			const out: Record<string, number> = {
				pending: 0,
				leased: 0,
				completed: 0,
				failed: 0,
				dead: 0,
			};
			for (const r of rows) out[r.status] = r.count;
			return out;
		};

		return {
			queues: {
				memory: toCountMap(memoryRows),
				summary: toCountMap(summaryRows),
			},
		};
	});
	const diagnostics = getCachedDiagnosticsReport();

	const pipelineV2 = cfg.pipelineV2;
	const mode = readPipelineMode(pipelineV2);

	// Predictor sidecar snapshot for pipeline overview
	const predictorHealth = diagnostics.predictor;
	const predictorSnapshot = {
		running: predictorHealth.status !== "disabled" && predictorHealth.sidecarAlive,
		modelReady: predictorHealth.coldStartExited,
		coldStartExited: predictorHealth.coldStartExited,
		successRate: predictorHealth.successRate,
		alpha: predictorHealth.alpha,
	};

	return c.json({
		workers: getPipelineWorkerStatus(),
		queues: dbData.queues,
		diagnostics,
		latency: analyticsCollector.getLatency(),
		errorSummary: analyticsCollector.getErrorSummary(),
		mode,
		feedback: getFeedbackTelemetry(),
		traversal: {
			enabled: pipelineV2.graph.enabled && (pipelineV2.traversal?.enabled ?? true),
			lastRun: getTraversalStatus(),
		},
		predictor: predictorSnapshot,
	});
});

const pipelineAdminGuard = async (c: Context, next: () => Promise<void>): Promise<Response | undefined> => {
	const perm = requirePermission("admin", authConfig);
	const rate = requireRateLimit("admin", authAdminLimiter, authConfig);
	return perm(c, async () => rate(c, next));
};

async function togglePipelinePause(c: Context, paused: boolean): Promise<Response> {
	if (shuttingDown) {
		return c.json({ error: "Daemon is shutting down" }, 503);
	}
	if (pipelineTransition) {
		return c.json({ error: "Pipeline transition already in progress" }, 409);
	}

	const prev = readPipelinePauseState(AGENTS_DIR);
	if (!prev.exists) {
		return c.json({ error: "No Signet config file found" }, 404);
	}

	pipelineTransition = true;
	try {
		const changed = prev.paused !== paused;
		const next = changed ? setPipelinePaused(AGENTS_DIR, paused) : prev;
		if (changed) {
			await restartPipelineRuntime(loadMemoryConfig(AGENTS_DIR), telemetryRef);
		}
		const liveCfg = loadMemoryConfig(AGENTS_DIR);
		return c.json({
			success: true,
			changed,
			paused: next.paused,
			file: next.file,
			mode: readPipelineMode(liveCfg.pipelineV2),
		});
	} catch (err) {
		logger.error("pipeline", paused ? "Failed to pause pipeline" : "Failed to resume pipeline", err);
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	} finally {
		pipelineTransition = false;
	}
}

app.use("/api/pipeline/pause", pipelineAdminGuard);
app.use("/api/pipeline/resume", pipelineAdminGuard);
app.use("/api/pipeline/nudge", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});

app.post("/api/pipeline/pause", (c) => {
	return togglePipelinePause(c, true);
});

app.post("/api/pipeline/resume", (c) => {
	return togglePipelinePause(c, false);
});

app.post("/api/pipeline/nudge", (c) => {
	if (!nudgeExtractionWorker()) {
		return c.json({ error: "Extraction worker not running" }, 503);
	}
	return c.json({ nudged: true });
});

// ---------------------------------------------------------------------------
// Model Registry endpoints
// ---------------------------------------------------------------------------

app.get("/api/pipeline/models", (c) => {
	const provider = c.req.query("provider");
	const includeDeprecated = c.req.query("deprecated") === "true";
	return c.json({
		models: getAvailableModels(provider ?? undefined, includeDeprecated),
		registry: getRegistryStatus(),
	});
});

app.get("/api/pipeline/models/by-provider", (c) => {
	return c.json(getModelsByProvider());
});

let lastRefreshRequestAt = 0;
const REFRESH_COOLDOWN_MS = 60_000;

app.post("/api/pipeline/models/refresh", async (c) => {
	const now = Date.now();
	if (now - lastRefreshRequestAt < REFRESH_COOLDOWN_MS) {
		return c.json(
			{
				models: getModelsByProvider(),
				registry: getRegistryStatus(),
				throttled: true,
			},
			429,
		);
	}
	lastRefreshRequestAt = now;
	const cfg = loadMemoryConfig(AGENTS_DIR);
	let anthropicKey: string | undefined = process.env.ANTHROPIC_API_KEY;
	if (!anthropicKey) {
		try {
			anthropicKey = (await getSecret("ANTHROPIC_API_KEY")) ?? undefined;
		} catch {
			/* ignore */
		}
	}
	let openRouterKey: string | undefined = process.env.OPENROUTER_API_KEY;
	if (!openRouterKey) {
		try {
			openRouterKey = (await getSecret("OPENROUTER_API_KEY")) ?? undefined;
		} catch {
			/* ignore */
		}
	}
	await refreshRegistry(
		resolveRegistryOllamaBaseUrl(cfg.pipelineV2.extraction.provider, cfg.pipelineV2.extraction.endpoint),
		anthropicKey,
		openRouterKey,
		resolveRegistryOpenRouterBaseUrl(cfg.pipelineV2.extraction.provider, cfg.pipelineV2.extraction.endpoint),
	);
	return c.json({
		models: getModelsByProvider(),
		registry: getRegistryStatus(),
	});
});

// ---------------------------------------------------------------------------
// Dreaming API
// ---------------------------------------------------------------------------

app.use("/api/dream/*", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});

app.get("/api/dream/status", (c) => {
	// loadMemoryConfig on each request intentionally: this is a polled
	// admin endpoint and callers expect fresh config values after an
	// agent.yaml edit without restarting the daemon. Consistent with
	// other polled status endpoints in this file.
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const accessor = getDbAccessor();
	const agentId = resolveAgentId({
		agentId: c.req.query("agentId") ?? c.req.header("x-signet-agent-id"),
	});

	const state = getDreamingState(accessor, agentId);
	const passes = getDreamingPasses(accessor, agentId, 10);
	// The dreaming worker currently runs only for the default agent.
	// For non-default agent queries, report no worker (not a lie —
	// no worker is processing their graph yet).
	const defaultAgent = resolveAgentId({});
	const worker = agentId === defaultAgent ? getDreamingWorker() : null;

	return c.json({
		enabled: cfg.dreaming.enabled,
		worker: { running: worker !== null, active: worker?.running ?? false },
		state,
		config: {
			tokenThreshold: cfg.dreaming.tokenThreshold,
			backfillOnFirstRun: cfg.dreaming.backfillOnFirstRun,
			maxInputTokens: cfg.dreaming.maxInputTokens,
			maxOutputTokens: cfg.dreaming.maxOutputTokens,
			timeout: cfg.dreaming.timeout,
		},
		passes,
	});
});

app.post("/api/dream/trigger", async (c) => {
	const worker = getDreamingWorker();
	if (!worker) {
		return c.json({ error: "Dreaming worker not running" }, 503);
	}

	const contentType = c.req.header("content-type") ?? "";
	let mode: "compact" | "incremental" = "incremental";
	if (contentType.includes("application/json")) {
		const raw: unknown = await c.req.json().catch(() => null);
		if (raw === null) {
			return c.json({ error: "Malformed JSON body" }, 400);
		}
		if (typeof raw === "object" && raw !== null && "mode" in raw && raw.mode === "compact") {
			mode = "compact";
		}
	}

	// Async fire-and-forget: return 202 immediately so the caller is not
	// blocked for the full pass duration (up to several minutes on large
	// graphs). The pass runs in the background; poll GET /api/dream/status
	// for completion. If a pass is already running, return 409.
	let passId: string;
	try {
		passId = worker.triggerAsync(mode);
	} catch (e) {
		if (e instanceof AlreadyRunningError) return c.json({ error: e.message }, 409);
		const msg = e instanceof Error ? e.message : String(e);
		return c.json({ error: msg }, 500);
	}
	return c.json({ accepted: true, passId, status: "running", mode }, 202);
});

app.get("/api/predictor/status", async (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const predictorCfg = cfg.pipelineV2.predictor;

	if (!predictorCfg?.enabled) {
		return c.json({ enabled: false, status: null });
	}

	const client = getPredictorClient();
	if (client === null) {
		return c.json({
			enabled: true,
			alive: false,
			crashCount: 0,
			crashDisabled: false,
			status: null,
		});
	}

	const status = await client.status();
	return c.json({
		enabled: true,
		alive: client.isAlive(),
		crashCount: client.crashCount,
		crashDisabled: client.crashDisabled,
		status,
	});
});

function resolveRepairContext(c: Context): RepairContext {
	const reason = c.req.header("x-signet-reason") ?? "manual repair";
	const actor = c.req.header("x-signet-actor") ?? "operator";
	const actorType = (c.req.header("x-signet-actor-type") ?? "operator") as "operator" | "agent" | "daemon";
	const requestId = c.req.header("x-signet-request-id") ?? crypto.randomUUID();
	return { reason, actor, actorType, requestId };
}

app.post("/api/repair/requeue-dead", (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	const result = requeueDeadJobs(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter);
	return c.json(result, result.success ? 200 : 429);
});

app.post("/api/repair/release-leases", (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	const result = releaseStaleLeases(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter);
	return c.json(result, result.success ? 200 : 429);
});

app.post("/api/repair/check-fts", async (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	let repair = false;
	try {
		const body = await c.req.json();
		repair = body?.repair === true;
	} catch {
		// no body or invalid JSON — default repair=false
	}
	const result = checkFtsConsistency(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter, repair);
	return c.json(result, result.success ? 200 : 429);
});

app.post("/api/repair/retention-sweep", (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	// The retention handle is internal to pipeline — import not needed,
	// we can call the repair action with a minimal sweep handle via
	// the retention worker's public API. For now, return 501 if the
	// retention worker isn't running (pipeline not started).
	return c.json(
		{
			action: "triggerRetentionSweep",
			success: false,
			affected: 0,
			message: "Use the maintenance worker for automated sweeps; manual sweep via this endpoint is not yet wired",
		},
		501,
	);
});

app.get("/api/repair/embedding-gaps", (c) => {
	const stats = getEmbeddingGapStats(getDbAccessor());
	return c.json(stats);
});

function repairHttpStatus(result: RepairResult): number {
	if (result.success) return 200;
	if (
		/cooldown active|hourly budget exhausted|denied by policy gate|autonomous\.|agents cannot trigger repairs|already in progress/i.test(
			result.message,
		)
	) {
		return 429;
	}
	return 500;
}

app.post("/api/repair/re-embed", async (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	let batchSize = 50;
	let dryRun = false;
	let fullSweep = false;

	try {
		const body = await c.req.json();
		if (typeof body.batchSize === "number") batchSize = body.batchSize;
		if (typeof body.dryRun === "boolean") dryRun = body.dryRun;
		if (typeof body.fullSweep === "boolean") fullSweep = body.fullSweep;
	} catch {
		// no body or invalid JSON — use defaults
	}

	const result = await reembedMissingMemories(
		getDbAccessor(),
		cfg.pipelineV2,
		ctx,
		repairLimiter,
		fetchEmbedding,
		cfg.embedding,
		batchSize,
		dryRun,
		fullSweep,
		fullSweep && ctx.actorType === "operator" ? 0 : undefined,
	);

	return c.json(result, repairHttpStatus(result));
});

app.post("/api/repair/resync-vec", (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	const result = resyncVectorIndex(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter);
	return c.json(result, repairHttpStatus(result));
});

app.post("/api/repair/clean-orphans", (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	const result = cleanOrphanedEmbeddings(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter);
	return c.json(result, repairHttpStatus(result));
});

app.get("/api/repair/dedup-stats", (c) => {
	const stats = getDedupStats(getDbAccessor());
	return c.json(stats);
});

app.post("/api/repair/deduplicate", async (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	const options: {
		batchSize?: number;
		dryRun?: boolean;
		semanticThreshold?: number;
		semanticEnabled?: boolean;
	} = {};
	try {
		const body = await c.req.json();
		if (typeof body?.batchSize === "number") options.batchSize = body.batchSize;
		if (typeof body?.dryRun === "boolean") options.dryRun = body.dryRun;
		if (typeof body?.semanticThreshold === "number") options.semanticThreshold = body.semanticThreshold;
		if (typeof body?.semanticEnabled === "boolean") options.semanticEnabled = body.semanticEnabled;
	} catch {
		// no body or invalid JSON — use defaults
	}
	const result = await deduplicateMemories(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter, options);
	return c.json(result, repairHttpStatus(result));
});

app.post("/api/repair/backfill-skipped", async (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	let limit = 50;
	let dryRun = false;
	try {
		const body = await c.req.json();
		if (typeof body?.limit === "number") limit = body.limit;
		if (typeof body?.dryRun === "boolean") dryRun = body.dryRun;
	} catch {
		// no body or invalid JSON — use defaults
	}
	const result = backfillSkippedSessions(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter, {
		limit,
		dryRun,
	});
	return c.json(result, repairHttpStatus(result));
});

app.post("/api/repair/reclassify-entities", async (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	let batchSize = 50;
	let dryRun = false;
	try {
		const body = await c.req.json();
		if (typeof body?.batchSize === "number") batchSize = body.batchSize;
		if (typeof body?.dryRun === "boolean") dryRun = body.dryRun;
	} catch {
		// no body or invalid JSON — use defaults
	}
	let provider: import("@signet/core").LlmProvider | null = null;
	try {
		provider = getLlmProvider();
	} catch {
		// provider not initialized
	}
	const result = await reclassifyEntities(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter, provider, {
		batchSize,
		dryRun,
	});
	return c.json(result, repairHttpStatus(result));
});

app.post("/api/repair/prune-chunk-groups", async (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	let batchSize = 500;
	let dryRun = false;
	try {
		const body = await c.req.json();
		if (typeof body?.batchSize === "number") batchSize = body.batchSize;
		if (typeof body?.dryRun === "boolean") dryRun = body.dryRun;
	} catch {
		// no body or invalid JSON — use defaults
	}
	const result = pruneChunkGroupEntities(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter, {
		batchSize,
		dryRun,
	});
	return c.json(result, repairHttpStatus(result));
});

app.post("/api/repair/prune-singleton-entities", async (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	let batchSize = 200;
	let dryRun = false;
	let maxMentions = 1;
	try {
		const body = await c.req.json();
		if (typeof body?.batchSize === "number") batchSize = body.batchSize;
		if (typeof body?.dryRun === "boolean") dryRun = body.dryRun;
		if (typeof body?.maxMentions === "number") maxMentions = body.maxMentions;
	} catch {
		// no body or invalid JSON — use defaults
	}
	const result = pruneSingletonExtractedEntities(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter, {
		batchSize,
		dryRun,
		maxMentions,
	});
	return c.json(result, repairHttpStatus(result));
});

app.post("/api/repair/structural-backfill", async (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	let batchSize = 100;
	let dryRun = false;
	try {
		const body = await c.req.json();
		if (typeof body?.batchSize === "number") batchSize = body.batchSize;
		if (typeof body?.dryRun === "boolean") dryRun = body.dryRun;
	} catch {
		// no body or invalid JSON — use defaults
	}
	const result = structuralBackfill(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter, {
		batchSize,
		dryRun,
	});
	return c.json(result, repairHttpStatus(result));
});

app.get("/api/repair/cold-stats", (c) => {
	const accessor = getDbAccessor();
	return c.json(
		accessor.withReadDb((db) => {
			// Check if table exists
			const tableExists = db
				.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories_cold'`)
				.get();

			if (!tableExists) {
				return { count: 0, message: "Cold tier not yet initialized (migration pending)" };
			}

			const stats = db
				.prepare(`
			SELECT
				COUNT(*) as total,
				MIN(archived_at) as oldest,
				MAX(archived_at) as newest,
				SUM(LENGTH(CAST(content AS BLOB)) + LENGTH(CAST(COALESCE(original_row_json, '') AS BLOB))) as total_bytes
			FROM memories_cold
		`)
				.get() as
				| { total: number; oldest: string | null; newest: string | null; total_bytes: number | null }
				| undefined;

			const byReason = db
				.prepare(`
			SELECT archived_reason, COUNT(*) as count
			FROM memories_cold
			GROUP BY archived_reason
		`)
				.all() as Array<{ archived_reason: string | null; count: number }>;

			return {
				count: stats?.total ?? 0,
				oldest: stats?.oldest ?? null,
				newest: stats?.newest ?? null,
				totalBytes: stats?.total_bytes ?? 0,
				byReason: Object.fromEntries(byReason.map((r) => [r.archived_reason ?? "unknown", r.count])),
			};
		}),
	);
});

app.post("/api/repair/cluster-entities", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const result = getDbAccessor().withWriteTx((db) => clusterEntities(db, agentId));
	return c.json(result);
});

app.post("/api/repair/relink-entities", async (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	let batchSize = 500;
	try {
		const body = await c.req.json();
		if (typeof body?.batchSize === "number") batchSize = body.batchSize;
	} catch {
		// defaults
	}
	const accessor = getDbAccessor();

	// Find memories with no entity mentions
	const unlinked = accessor.withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT id, content FROM memories
			 WHERE is_deleted = 0
			   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_entity_mentions)
			 LIMIT ?`,
				)
				.all(batchSize) as Array<{ id: string; content: string }>,
	);

	if (unlinked.length === 0) {
		return c.json({ action: "relink-entities", linked: 0, remaining: 0, message: "all memories linked" });
	}

	let linked = 0;
	let entities = 0;
	let aspects = 0;
	let attributes = 0;

	for (const mem of unlinked) {
		const result = accessor.withWriteTx((db) => linkMemoryToEntities(db, mem.id, mem.content, agentId));
		linked += result.linked;
		entities += result.entityIds.length;
		aspects += result.aspects;
		attributes += result.attributes;
	}

	// Check how many remain
	const remaining = accessor.withReadDb(
		(db) =>
			(
				db
					.prepare(
						`SELECT COUNT(*) as cnt FROM memories
			 WHERE is_deleted = 0
			   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_entity_mentions)`,
					)
					.get() as { cnt: number }
			).cnt,
	);

	return c.json({
		action: "relink-entities",
		processed: unlinked.length,
		linked,
		entities,
		aspects,
		attributes,
		remaining,
		message: remaining > 0 ? `${remaining} memories still need linking — call again` : "all memories linked",
	});
});

app.post("/api/repair/backfill-hints", async (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	if (!cfg.pipelineV2.hints?.enabled) {
		return c.json({ error: "Hints disabled in pipeline config" }, 400);
	}

	let batchSize = 50;
	try {
		const body = await c.req.json();
		if (typeof body?.batchSize === "number") batchSize = Math.min(body.batchSize, 200);
	} catch {
		// defaults
	}

	const accessor = getDbAccessor();
	// Find unscoped memories that have no hints yet
	const unhinted = accessor.withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT m.id, m.content FROM memories m
			 WHERE m.is_deleted = 0 AND m.scope IS NULL
			   AND m.id NOT IN (SELECT DISTINCT memory_id FROM memory_hints)
			 ORDER BY m.created_at DESC
			 LIMIT ?`,
				)
				.all(batchSize) as Array<{ id: string; content: string }>,
	);

	if (unhinted.length === 0) {
		return c.json({ action: "backfill-hints", enqueued: 0, remaining: 0, message: "all unscoped memories have hints" });
	}

	const { enqueueHintsJob: enqueue } = await import("./pipeline/prospective-index.js");
	let enqueued = 0;
	accessor.withWriteTx((db) => {
		for (const mem of unhinted) {
			enqueue(db, mem.id, mem.content);
			enqueued++;
		}
	});

	const remaining = accessor.withReadDb(
		(db) =>
			(
				db
					.prepare(
						`SELECT COUNT(*) as cnt FROM memories
			 WHERE is_deleted = 0 AND scope IS NULL
			   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_hints)`,
					)
					.get() as { cnt: number }
			).cnt,
	);

	return c.json({
		action: "backfill-hints",
		enqueued,
		remaining,
		message:
			remaining > 0
				? `${remaining} unscoped memories still need hints — call again`
				: "all unscoped memories have hints",
	});
});

// ---------------------------------------------------------------------------
// Dead memory hygiene
// ---------------------------------------------------------------------------

app.get("/api/repair/dead-memories", (c) => {
	const maxConfidence = Number(c.req.query("maxConfidence") ?? "0.1");
	const maxAccessDays = Number(c.req.query("maxAccessDays") ?? "90");
	const limit = Math.min(Number(c.req.query("limit") ?? "200"), 500);
	if (
		!Number.isFinite(maxConfidence) ||
		!Number.isFinite(maxAccessDays) ||
		!Number.isFinite(limit) ||
		maxConfidence < 0 ||
		maxConfidence > 1 ||
		maxAccessDays < 0 ||
		limit < 0
	) {
		return c.json({ error: "maxConfidence must be 0–1, maxAccessDays and limit must be non-negative" }, 400);
	}
	const dead = getDbAccessor().withReadDb((db) => findDeadMemories(db, { maxConfidence, maxAccessDays, limit }));
	return c.json({ count: dead.length, memories: dead });
});

app.post("/api/repair/dead-memories/forget", async (c) => {
	let ids: unknown;
	try {
		const body = await c.req.json();
		ids = body?.ids;
	} catch {
		return c.json({ error: "Request body must be JSON with an ids array" }, 400);
	}
	if (!Array.isArray(ids) || ids.length === 0) {
		return c.json({ error: "ids must be a non-empty array" }, 400);
	}
	if (ids.length > 500) {
		return c.json({ error: "Maximum 500 ids per batch" }, 400);
	}
	const validIds = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
	if (validIds.length !== ids.length) {
		return c.json({ error: "All ids must be non-empty strings" }, 400);
	}
	const forgotten = forgetDeadMemories(getDbAccessor(), validIds);
	return c.json({ forgotten });
});

// ============================================================================
// Troubleshooter — live terminal command execution
// ============================================================================

const TROUBLESHOOT_COMMANDS: Record<string, readonly [string, ReadonlyArray<string>]> = {
	status: ["signet", ["status"]],
	"daemon-status": ["signet", ["daemon", "status"]],
	"daemon-logs": ["signet", ["daemon", "logs", "--lines", "50"]],
	"embed-audit": ["signet", ["embed", "audit"]],
	"embed-backfill": ["signet", ["embed", "backfill"]],
	sync: ["signet", ["sync"]],
	"recall-test": ["signet", ["recall", "test query"]],
	"skill-list": ["signet", ["skill", "list"]],
	"secret-list": ["signet", ["secret", "list"]],
	"daemon-stop": ["signet", ["daemon", "stop"]],
	"daemon-restart": ["signet", ["daemon", "restart"]],
	update: ["signet", ["update", "install"]],
};

app.get("/api/troubleshoot/commands", (c) => {
	return c.json({
		commands: Object.entries(TROUBLESHOOT_COMMANDS).map(([key, [bin, args]]) => ({
			key,
			display: `${bin} ${args.join(" ")}`,
		})),
	});
});

app.post("/api/troubleshoot/exec", async (c) => {
	const body = await c.req.json().catch(() => null);
	const key = typeof body === "object" && body !== null && "key" in body ? String(body.key) : "";

	const cmd = TROUBLESHOOT_COMMANDS[key];
	if (!cmd) {
		return c.json({ error: `Unknown command: ${key}` }, 400);
	}

	const [bin, args] = cmd;
	const resolved = Bun.which(bin);
	if (!resolved) {
		return c.json({ error: `Binary not found: ${bin}` }, 500);
	}

	const { CLAUDECODE: _cc, SIGNET_NO_HOOKS: _, ...baseEnv } = process.env;
	const encoder = new TextEncoder();

	// Lifecycle commands (stop/restart) can't stream through the general
	// exec pipeline — the child process would kill its parent mid-stream.
	// Handle directly: flush SSE output, then schedule graceful shutdown.
	if (key === "daemon-stop" || key === "daemon-restart") {
		const action = key === "daemon-stop" ? "stop" : "restart";
		const lifecycle = new ReadableStream({
			start(controller) {
				const write = (event: unknown): void => {
					try {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
					} catch {}
				};

				write({ type: "started", key, command: `signet daemon ${action}` });
				write({ type: "stdout", data: `Daemon ${action} initiated (PID ${process.pid})\n` });
				if (key === "daemon-stop") {
					write({ type: "stdout", data: "Dashboard will lose connection.\n" });
				}
				write({ type: "exit", code: 0 });
				try {
					controller.close();
				} catch {}

				// Give the response time to flush, then trigger graceful shutdown.
				// SIGTERM triggers cleanup() which handles PID file, DB, watchers.
				setTimeout(async () => {
					if (key === "daemon-restart") {
						const { spawn: nodeSpawn } = await import("node:child_process");
						// Use array form — no shell, so paths with spaces are safe.
						// Inner delay lets cleanup() finish before the new daemon starts.
						setTimeout(() => {
							const child = nodeSpawn(resolved, ["daemon", "start"], {
								detached: true,
								stdio: "ignore",
								env: { ...baseEnv, SIGNET_NO_HOOKS: "1" } as NodeJS.ProcessEnv,
							});
							child.unref();
						}, 1000);
					}
					process.kill(process.pid, "SIGTERM");
				}, 1000);
			},
		});

		return new Response(lifecycle, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	}

	const stream = new ReadableStream({
		async start(controller) {
			const write = (event: unknown) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				} catch {}
			};

			write({ type: "started", key, command: `${bin} ${args.join(" ")}` });

			const { spawn: nodeSpawn } = await import("node:child_process");
			const child = nodeSpawn(resolved, args as string[], {
				stdio: "pipe",
				windowsHide: true,
				env: { ...baseEnv, SIGNET_NO_HOOKS: "1", FORCE_COLOR: "0" } as NodeJS.ProcessEnv,
			});

			child.stdout?.on("data", (chunk: Buffer) => {
				try {
					write({ type: "stdout", data: chunk.toString("utf-8") });
				} catch {
					clearTimeout(killTimer);
					try {
						child.kill("SIGTERM");
					} catch {}
				}
			});

			child.stderr?.on("data", (chunk: Buffer) => {
				try {
					write({ type: "stderr", data: chunk.toString("utf-8") });
				} catch {
					clearTimeout(killTimer);
					try {
						child.kill("SIGTERM");
					} catch {}
				}
			});

			// 60s timeout — SIGTERM first, force kill after 5s
			const killTimer = setTimeout(() => {
				try {
					child.kill("SIGTERM");
				} catch {}
				setTimeout(() => {
					try {
						child.kill();
					} catch {}
				}, 5_000);
			}, 60_000);

			child.on("close", (code) => {
				clearTimeout(killTimer);
				write({ type: "exit", code: code ?? 1 });
				try {
					controller.close();
				} catch {}
			});

			child.on("error", (err) => {
				clearTimeout(killTimer);
				write({ type: "error", message: err.message });
				try {
					controller.close();
				} catch {}
			});
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
});

// ============================================================================
// Session Checkpoints (Continuity Protocol)
// ============================================================================

app.get("/api/checkpoints", (c) => {
	const project = c.req.query("project");
	const limit = Number.parseInt(c.req.query("limit") ?? "10", 10);

	if (!project) {
		return c.json({ error: "project query parameter required" }, 400);
	}

	// Normalize project path for consistent matching
	let projectNormalized = project;
	try {
		projectNormalized = realpathSync(project);
	} catch {
		// Use raw path if realpath fails
	}

	const rows = getCheckpointsByProject(getDbAccessor(), projectNormalized, Math.min(limit, 100));
	const redacted = rows.map(redactCheckpointRow);
	return c.json({ checkpoints: redacted, count: redacted.length });
});

app.get("/api/checkpoints/:sessionKey", (c) => {
	const sessionKey = c.req.param("sessionKey");
	const rows = getCheckpointsBySession(getDbAccessor(), sessionKey);
	const redacted = rows.map(redactCheckpointRow);
	return c.json({ checkpoints: redacted, count: redacted.length });
});

// ============================================================================
// Knowledge Graph
// ============================================================================

app.get("/api/knowledge/entities", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const limitParam = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const offsetParam = Number.parseInt(c.req.query("offset") ?? "0", 10);
	const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
	const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;

	return c.json({
		items: listKnowledgeEntities(getDbAccessor(), {
			agentId,
			type: c.req.query("type") ?? undefined,
			query: c.req.query("q") ?? undefined,
			limit,
			offset,
		}),
		limit,
		offset,
	});
});

app.post("/api/knowledge/entities/:id/pin", async (c) => {
	return requirePermission("modify", authConfig)(c, async () => {
		const agentId = c.req.query("agent_id") ?? "default";
		pinEntity(getDbAccessor(), c.req.param("id"), agentId);
		const entity = getKnowledgeEntityDetail(getDbAccessor(), c.req.param("id"), agentId);
		if (!entity?.entity.pinnedAt) {
			return c.json({ error: "Entity not found" }, 404);
		}
		return c.json({ pinned: true, pinnedAt: entity.entity.pinnedAt });
	});
});

app.delete("/api/knowledge/entities/:id/pin", async (c) => {
	return requirePermission("modify", authConfig)(c, async () => {
		const agentId = c.req.query("agent_id") ?? "default";
		unpinEntity(getDbAccessor(), c.req.param("id"), agentId);
		return c.json({ pinned: false });
	});
});

app.get("/api/knowledge/entities/pinned", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	return c.json(getPinnedEntities(getDbAccessor(), agentId));
});

app.get("/api/knowledge/entities/health", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const minComparisonsParam = Number.parseInt(c.req.query("min_comparisons") ?? "3", 10);
	return c.json(
		getEntityHealth(
			getDbAccessor(),
			agentId,
			c.req.query("since") ?? undefined,
			Number.isFinite(minComparisonsParam) ? Math.max(minComparisonsParam, 1) : 3,
		),
	);
});

app.get("/api/knowledge/entities/:id", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const entity = getKnowledgeEntityDetail(getDbAccessor(), c.req.param("id"), agentId);
	if (!entity) {
		return c.json({ error: "Entity not found" }, 404);
	}
	return c.json(entity);
});

app.get("/api/knowledge/entities/:id/aspects", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	return c.json({
		items: getEntityAspectsWithCounts(getDbAccessor(), c.req.param("id"), agentId),
	});
});

app.get("/api/knowledge/entities/:id/aspects/:aspectId/attributes", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const limitParam = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const offsetParam = Number.parseInt(c.req.query("offset") ?? "0", 10);
	const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
	const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;
	const kind = c.req.query("kind");
	const status = c.req.query("status");

	return c.json({
		items: getAttributesForAspectFiltered(getDbAccessor(), {
			entityId: c.req.param("id"),
			aspectId: c.req.param("aspectId"),
			agentId,
			kind: kind === "attribute" || kind === "constraint" ? kind : undefined,
			status: status === "active" || status === "superseded" || status === "deleted" ? status : undefined,
			limit,
			offset,
		}),
		limit,
		offset,
	});
});

app.get("/api/knowledge/entities/:id/dependencies", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const directionQuery = c.req.query("direction");
	const direction =
		directionQuery === "incoming" || directionQuery === "outgoing" || directionQuery === "both"
			? directionQuery
			: "both";
	return c.json({
		items: getEntityDependenciesDetailed(getDbAccessor(), {
			entityId: c.req.param("id"),
			agentId,
			direction,
		}),
	});
});

app.get("/api/knowledge/stats", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	return c.json(getKnowledgeStats(getDbAccessor(), agentId));
});

app.get("/api/knowledge/communities", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const rows = getDbAccessor().withReadDb((db) => {
		return db
			.prepare(
				`SELECT id, name, cohesion, member_count, created_at, updated_at
				 FROM entity_communities
				 WHERE agent_id = ?
				 ORDER BY member_count DESC`,
			)
			.all(agentId) as ReadonlyArray<{
			id: string;
			name: string | null;
			cohesion: number;
			member_count: number;
			created_at: string;
			updated_at: string;
		}>;
	});
	return c.json({ items: rows, count: rows.length });
});

app.get("/api/knowledge/traversal/status", (c) => {
	return c.json({
		status: getTraversalStatus(),
	});
});

app.get("/api/knowledge/constellation", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	return c.json(getKnowledgeGraphForConstellation(getDbAccessor(), agentId));
});

app.post("/api/knowledge/expand", async (c) => {
	const scopedAgent = resolveScopedAgentId(c, undefined, "default");
	if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
	const body = await c.req.json().catch(() => ({}));
	const entityName = typeof body.entity === "string" ? body.entity.trim() : "";
	const aspectFilter = typeof body.aspect === "string" ? body.aspect.trim() : undefined;
	const maxTokens = typeof body.maxTokens === "number" ? Math.min(body.maxTokens, 10000) : 2000;

	if (!entityName) {
		return c.json({ error: "entity name is required" }, 400);
	}

	const agentId = scopedAgent.agentId;
	const resolved = resolveNamedEntity(getDbAccessor(), {
		agentId,
		name: entityName,
	});
	const focal =
		resolved !== null
			? {
					entityIds: [resolved.id],
				}
			: getDbAccessor().withReadDb((db) =>
					resolveFocalEntities(db, agentId, {
						queryTokens: entityName.split(/\s+/),
					}),
				);

	if (focal.entityIds.length === 0) {
		return c.json(
			{
				error: `Entity "${entityName}" not found`,
				entity: null,
				constraints: [],
				aspects: [],
				dependencies: [],
				memoryCount: 0,
				memories: [],
			},
			404,
		);
	}

	const cfg = loadMemoryConfig(AGENTS_DIR);
	const traversalCfg = cfg.pipelineV2.traversal ?? {
		maxAspectsPerEntity: 10,
		maxAttributesPerAspect: 20,
		maxDependencyHops: 10,
		minDependencyStrength: 0.3,
		maxBranching: 4,
		maxTraversalPaths: 50,
		minConfidence: 0.5,
		timeoutMs: 500,
	};

	const primaryEntityId = focal.entityIds[0];

	return getDbAccessor().withReadDb((db) => {
		const traversal = traverseKnowledgeGraph(focal.entityIds, db, agentId, {
			maxAspectsPerEntity: traversalCfg.maxAspectsPerEntity,
			maxAttributesPerAspect: traversalCfg.maxAttributesPerAspect,
			maxDependencyHops: traversalCfg.maxDependencyHops,
			minDependencyStrength: traversalCfg.minDependencyStrength,
			maxBranching: traversalCfg.maxBranching,
			maxTraversalPaths: traversalCfg.maxTraversalPaths,
			minConfidence: traversalCfg.minConfidence,
			timeoutMs: traversalCfg.timeoutMs,
			aspectFilter: aspectFilter || undefined,
		});

		// Hydrate entity details
		const entityRow = db
			.prepare(
				`SELECT id, name, entity_type, description
				 FROM entities WHERE id = ?`,
			)
			.get(primaryEntityId) as
			| {
					id: string;
					name: string;
					entity_type: string;
					description: string | null;
			  }
			| undefined;

		// Get aspects with their attributes
		const aspectFilterClause = aspectFilter ? "AND ea.canonical_name LIKE ?" : "";
		const aspectArgs = aspectFilter
			? [primaryEntityId, agentId, `%${aspectFilter}%`, traversalCfg.maxAspectsPerEntity]
			: [primaryEntityId, agentId, traversalCfg.maxAspectsPerEntity];

		const aspects = db
			.prepare(
				`SELECT ea.id, ea.canonical_name, ea.weight
				 FROM entity_aspects ea
				 WHERE ea.entity_id = ? AND ea.agent_id = ?
				 ${aspectFilterClause}
				 ORDER BY ea.weight DESC
				 LIMIT ?`,
			)
			.all(...aspectArgs) as Array<{
			id: string;
			canonical_name: string;
			weight: number;
		}>;

		const aspectsWithAttributes = aspects.map((aspect) => {
			const attrs = db
				.prepare(
					`SELECT content, kind, importance, confidence
					 FROM entity_attributes
					 WHERE aspect_id = ? AND agent_id = ?
					   AND status = 'active'
					 ORDER BY importance DESC
					 LIMIT ?`,
				)
				.all(aspect.id, agentId, traversalCfg.maxAttributesPerAspect) as Array<{
				content: string;
				kind: string;
				importance: number;
				confidence: number;
			}>;
			return {
				name: aspect.canonical_name,
				weight: aspect.weight,
				attributes: attrs,
			};
		});

		// Get dependencies
		const deps = db
			.prepare(
				`SELECT e.name as target, ed.dependency_type as type,
				        ed.strength
				 FROM entity_dependencies ed
				 JOIN entities e ON e.id = ed.target_entity_id
				 WHERE ed.source_entity_id = ?
				   AND ed.agent_id = ?
				   AND ed.strength >= ?
				 ORDER BY ed.strength DESC
				 LIMIT ?`,
			)
			.all(primaryEntityId, agentId, traversalCfg.minDependencyStrength, traversalCfg.maxDependencyHops) as Array<{
			target: string;
			type: string;
			strength: number;
		}>;

		// Hydrate memory content up to token budget
		let tokenBudget = maxTokens;
		const hydratedMemories: Array<{
			id: string;
			content: string;
		}> = [];
		for (const memId of traversal.memoryIds) {
			if (tokenBudget <= 0) break;
			const mem = db
				.prepare(
					`SELECT id, content FROM memories
					 WHERE id = ? AND is_deleted = 0`,
				)
				.get(memId) as { id: string; content: string } | undefined;
			if (mem) {
				const approxTokens = Math.ceil(mem.content.length / 4);
				if (approxTokens <= tokenBudget) {
					hydratedMemories.push(mem);
					tokenBudget -= approxTokens;
				}
			}
		}

		return c.json({
			entity: entityRow
				? {
						id: entityRow.id,
						name: entityRow.name,
						type: entityRow.entity_type,
						description: entityRow.description,
					}
				: null,
			constraints: traversal.constraints,
			aspects: aspectsWithAttributes,
			dependencies: deps,
			memoryCount: traversal.memoryIds.size,
			memories: hydratedMemories,
		});
	});
});

// ============================================================================
// Session Expansion (DP-4)
// ============================================================================

app.post("/api/knowledge/expand/session", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const entityName = typeof body.entityName === "string" ? body.entityName.trim() : "";
	const scopedAgent = resolveScopedAgentId(
		c,
		resolveAgentId({
			agentId: typeof body.agentId === "string" ? body.agentId : c.req.header("x-signet-agent-id"),
			sessionKey: typeof body.sessionId === "string" ? body.sessionId : c.req.header("x-signet-session-key"),
		}),
	);
	if (scopedAgent.error) {
		return c.json({ error: scopedAgent.error }, 403);
	}
	const scopedProject = resolveScopedProject(c, undefined);
	if (scopedProject.error) {
		return c.json({ error: scopedProject.error }, 403);
	}
	const agentId = scopedAgent.agentId;
	const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : undefined;
	const timeRange = typeof body.timeRange === "string" ? body.timeRange.trim() : undefined;
	const maxResults = typeof body.maxResults === "number" ? Math.max(1, Math.min(body.maxResults, 50)) : 10;

	if (!entityName) {
		return c.json({ error: "entityName is required" }, 400);
	}

	return getDbAccessor().withReadDb((db) => {
		// Check if session_summaries table exists
		const tbl = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'")
			.get() as { name: string } | undefined;
		if (!tbl) {
			return c.json({ entityName, summaries: [], total: 0 });
		}

		const entity = resolveNamedEntity(getDbAccessor(), {
			agentId,
			name: entityName,
		});

		if (!entity) {
			return c.json({ entityName, summaries: [], total: 0 });
		}

		const conditions = ["ss.agent_id = ?", "ss.kind = 'session'", "COALESCE(ss.source_type, 'summary') = 'summary'"];
		const args: Array<string | number> = [agentId];

		if (scopedProject.project) {
			conditions.push("ss.project = ?");
			args.push(scopedProject.project);
		}

		if (sessionId) {
			conditions.push("ss.session_key = ?");
			args.push(sessionId);
		}

		if (timeRange === "last_week") {
			conditions.push("ss.latest_at >= datetime('now', '-7 days')");
		} else if (timeRange === "last_month") {
			conditions.push("ss.latest_at >= datetime('now', '-30 days')");
		} else if (timeRange && timeRange.length > 0) {
			conditions.push("ss.latest_at >= ?");
			args.push(timeRange);
		}

		// Text fallback: only for names >= 4 chars to avoid ambiguous short
		// tokens ("go", "ai", etc.) matching unrelated content. Normalize
		// the content by replacing common punctuation with spaces and
		// space-padding both ends, then match the name as a space-delimited
		// word. This avoids prefix collisions ("signetai") while covering all
		// punctuation-adjacent forms: "Signet.", "Signet,", "(Signet)", '"Signet"'.
		// SQL wildcards in canonicalName are escaped; cn is lowercased.
		const cn = entity.canonicalName.toLowerCase().replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
		const useTextFallback = cn.length >= 4;
		// Replace common punctuation with spaces so any delimiter around the
		// name becomes a space, then space-pad both ends of the content.
		// A single '% cn %' pattern then handles all forms: "Signet.", "Signet,",
		// "(Signet)", '"Signet"', "Signet:" etc. without false prefix matches.
		// char(39)=', char(40)=(, char(41)=), char(10)=LF, char(9)=TAB
		const normalizedContent =
			`LOWER(' ' || REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(` +
			`REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(ss.content,` +
			`',', ' '), '.', ' '), '!', ' '), '?', ' '), ';', ' '), '"', ' '),` +
			`char(39), ' '), char(40), ' '), char(41), ' '),` +
			`char(10), ' '), char(9), ' '), ':', ' '), '-', ' ') || ' ')`;
		const fallbackClause = useTextFallback ? `OR ${normalizedContent} LIKE ? ESCAPE '\\'` : "";
		const fallbackArgs = useTextFallback ? [`% ${cn} %`] : [];
		const rows = db
			.prepare(
				`SELECT DISTINCT ss.id, ss.content, ss.session_key,
				        ss.harness, ss.earliest_at, ss.latest_at
				 FROM session_summaries ss
				 WHERE ${conditions.join(" AND ")}
				   AND (
						EXISTS (
							SELECT 1
							FROM session_summary_memories ssm
							JOIN memory_entity_mentions mem
							  ON mem.memory_id = ssm.memory_id
							WHERE ssm.summary_id = ss.id
							  AND mem.entity_id = ?
						)
						${fallbackClause}
				   )
				 ORDER BY ss.latest_at DESC
				 LIMIT ?`,
			)
			.all(...args, entity.id, ...fallbackArgs, maxResults) as Array<{
			id: string;
			content: string;
			session_key: string | null;
			harness: string | null;
			earliest_at: string;
			latest_at: string;
		}>;

		return c.json({
			entityName: entity.name,
			summaries: rows.map((row) => ({
				id: row.id,
				sessionKey: row.session_key,
				harness: row.harness,
				earliestAt: row.earliest_at,
				latestAt: row.latest_at,
				content: row.content,
			})),
			total: rows.length,
		});
	});
});

// ============================================================================
// Graph Impact Analysis (DP-4)
// ============================================================================

app.post("/api/graph/impact", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const entityId = typeof body.entityId === "string" ? body.entityId.trim() : "";
	const direction = body.direction === "upstream" ? "upstream" : "downstream";
	const maxDepth = typeof body.maxDepth === "number" ? Math.max(1, Math.min(body.maxDepth, 10)) : 3;

	if (!entityId) {
		return c.json({ error: "entityId is required" }, 400);
	}

	const result = getDbAccessor().withReadDb((db) => walkImpact(db, { entityId, direction, maxDepth, timeoutMs: 200 }));
	return c.json(result);
});

// ============================================================================
// Analytics & Timeline (Phase K)
// ============================================================================

app.get("/api/analytics/usage", (c) => {
	return c.json(analyticsCollector.getUsage());
});

app.get("/api/analytics/errors", (c) => {
	const stage = c.req.query("stage") as ErrorStage | undefined;
	const since = c.req.query("since") ?? undefined;
	const limitRaw = c.req.query("limit");
	const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
	return c.json({
		errors: analyticsCollector.getErrors({ stage, since, limit }),
		summary: analyticsCollector.getErrorSummary(),
	});
});

app.get("/api/analytics/latency", (c) => {
	return c.json(analyticsCollector.getLatency());
});

app.get("/api/analytics/logs", (c) => {
	const limit = Number.parseInt(c.req.query("limit") || "100", 10);
	const level = c.req.query("level") as "debug" | "info" | "warn" | "error" | undefined;
	const category = c.req.query("category") as LogCategory | undefined;
	const sinceRaw = c.req.query("since");
	const since = sinceRaw ? new Date(sinceRaw) : undefined;
	const logs = logger.getRecent({ limit, level, category, since });
	return c.json({ logs, count: logs.length });
});

app.get("/api/analytics/memory-safety", (c) => {
	const mutationHealth = getDbAccessor().withReadDb((db) =>
		getDiagnostics(db, providerTracker, getUpdateState(), buildPredictorHealthParams()),
	);
	const recentMutationErrors = analyticsCollector.getErrors({
		stage: "mutation",
		limit: 50,
	});
	return c.json({
		mutation: mutationHealth.mutation,
		recentErrors: recentMutationErrors,
		errorSummary: analyticsCollector.getErrorSummary(),
	});
});

app.get("/api/analytics/continuity", (c) => {
	const project = c.req.query("project");
	const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);

	const scores = getDbAccessor().withReadDb((db) => {
		if (project) {
			return db
				.prepare(
					`SELECT id, session_key, project, harness, score,
					        memories_recalled, memories_used, novel_context_count,
					        reasoning, created_at
					 FROM session_scores
					 WHERE project = ?
					 ORDER BY created_at DESC
					 LIMIT ?`,
				)
				.all(project, limit) as Array<Record<string, unknown>>;
		}
		return db
			.prepare(
				`SELECT id, session_key, project, harness, score,
				        memories_recalled, memories_used, novel_context_count,
				        reasoning, created_at
				 FROM session_scores
				 ORDER BY created_at DESC
				 LIMIT ?`,
			)
			.all(limit) as Array<Record<string, unknown>>;
	});

	// Compute trend
	const scoreValues = scores.map((s) => s.score as number).reverse();
	const trend = scoreValues.length >= 2 ? scoreValues[scoreValues.length - 1] - scoreValues[0] : 0;
	const avg = scoreValues.length > 0 ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length : 0;

	return c.json({
		scores,
		summary: {
			count: scores.length,
			average: Math.round(avg * 100) / 100,
			trend: Math.round(trend * 100) / 100,
			latest: scores[0]?.score ?? null,
		},
	});
});

app.get("/api/analytics/continuity/latest", (c) => {
	const scores = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT project, score, created_at
					 FROM session_scores
					 WHERE id IN (
					   SELECT id FROM session_scores s2
					   WHERE s2.project = session_scores.project
					   ORDER BY s2.created_at DESC
					   LIMIT 1
					 )
					 ORDER BY created_at DESC`,
				)
				.all() as Array<{
				project: string | null;
				score: number;
				created_at: string;
			}>,
	);

	return c.json({ scores });
});

app.get("/api/predictor/comparisons/by-project", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const since = c.req.query("since") ?? undefined;
	return c.json({
		items: getComparisonsByProject(getDbAccessor(), agentId, since),
	});
});

app.get("/api/predictor/comparisons/by-entity", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const since = c.req.query("since") ?? undefined;
	return c.json({
		items: getComparisonsByEntity(getDbAccessor(), agentId, since),
	});
});

app.get("/api/predictor/comparisons", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const limitParam = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const offsetParam = Number.parseInt(c.req.query("offset") ?? "0", 10);
	const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
	const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;

	const result = listComparisons(getDbAccessor(), {
		agentId,
		project: c.req.query("project") ?? undefined,
		entityId: c.req.query("entity_id") ?? undefined,
		since: c.req.query("since") ?? undefined,
		until: c.req.query("until") ?? undefined,
		limit,
		offset,
	});

	return c.json({
		total: result.total,
		limit,
		offset,
		items: result.rows,
	});
});

app.get("/api/predictor/training", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const limitParam = Number.parseInt(c.req.query("limit") ?? "20", 10);
	const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 20;

	return c.json({
		items: listTrainingRuns(getDbAccessor(), agentId, limit),
	});
});

app.get("/api/predictor/training-pairs-count", (c) => {
	const count = getDbAccessor().withReadDb(
		(db) => (db.prepare("SELECT COUNT(*) as c FROM predictor_training_pairs").get() as { c: number }).c,
	);
	return c.json({ count });
});

app.post("/api/predictor/train", async (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const predictorCfg = cfg.pipelineV2.predictor;
	if (!predictorCfg?.enabled) {
		return c.json({ error: "Predictor is not enabled" }, 400);
	}
	const client = getPredictorClient();
	if (!client || !client.isAlive()) {
		return c.json({ error: "Predictor sidecar is not running" }, 503);
	}

	let body: Record<string, unknown> = {};
	try {
		body = await c.req.json();
	} catch {
		/* no body */
	}
	const limit = typeof body.limit === "number" ? body.limit : 5000;
	const epochs = typeof body.epochs === "number" ? body.epochs : 3;

	const dbPath = join(AGENTS_DIR, "memory", "memories.db");
	const checkpointPath = resolvePredictorCheckpointPath(predictorCfg);
	const result = await client.trainFromDb({
		db_path: dbPath,
		checkpoint_path: checkpointPath,
		limit,
		epochs,
	});
	if (!result) {
		return c.json({ error: "Training did not return a result" }, 500);
	}

	const checkpointSaved = result.checkpoint_saved || (await client.saveCheckpoint(checkpointPath));

	// Record the run in the training log and update state
	const agentId = "default";
	const { recordTrainingRun } = await import("./predictor-comparisons");
	const { updatePredictorState } = await import("./predictor-state");
	recordTrainingRun(getDbAccessor(), {
		agentId,
		modelVersion: result.step,
		loss: result.loss,
		sampleCount: result.samples_used,
		durationMs: result.duration_ms,
		canaryScoreVariance: result.canary_score_variance,
		canaryTopkChurn: result.canary_topk_stability,
	});
	updatePredictorState(agentId, { lastTrainingAt: new Date().toISOString() });
	invalidateDiagnosticsCache();

	return c.json({
		...result,
		checkpoint_path: checkpointPath,
		checkpoint_saved: checkpointSaved,
	});
});

// ---------------------------------------------------------------------------
// Telemetry endpoints
// ---------------------------------------------------------------------------

app.get("/api/telemetry/events", (c) => {
	if (!telemetryRef) {
		return c.json({ events: [], enabled: false });
	}
	const event = c.req.query("event") as TelemetryEventType | undefined;
	const since = c.req.query("since");
	const until = c.req.query("until");
	const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
	const events = telemetryRef.query({ event, since, until, limit });
	return c.json({ events, enabled: true });
});

app.get("/api/telemetry/stats", (c) => {
	if (!telemetryRef) {
		return c.json({ enabled: false });
	}
	const since = c.req.query("since");
	const events = telemetryRef.query({ since, limit: 10000 });

	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCost = 0;
	let llmCalls = 0;
	let llmErrors = 0;
	let pipelineErrors = 0;
	const latencies: number[] = [];

	for (const e of events) {
		if (e.event === "llm.generate") {
			llmCalls++;
			if (typeof e.properties.inputTokens === "number") totalInputTokens += e.properties.inputTokens;
			if (typeof e.properties.outputTokens === "number") totalOutputTokens += e.properties.outputTokens;
			if (typeof e.properties.totalCost === "number") totalCost += e.properties.totalCost;
			if (e.properties.success === false) llmErrors++;
			if (typeof e.properties.durationMs === "number") latencies.push(e.properties.durationMs);
		}
		if (e.event === "pipeline.error") pipelineErrors++;
	}

	latencies.sort((a, b) => a - b);
	const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
	const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

	return c.json({
		enabled: true,
		totalEvents: events.length,
		llm: { calls: llmCalls, errors: llmErrors, totalInputTokens, totalOutputTokens, totalCost, p50, p95 },
		pipelineErrors,
	});
});

app.get("/api/telemetry/export", (c) => {
	if (!telemetryRef) {
		return c.text("telemetry not enabled", 404);
	}
	const since = c.req.query("since");
	const limit = Number.parseInt(c.req.query("limit") ?? "10000", 10);
	const events = telemetryRef.query({ since, limit });

	const lines = events.map((e) => JSON.stringify(e)).join("\n");
	return c.text(lines, 200, { "Content-Type": "application/x-ndjson" });
});

app.get("/api/telemetry/training-export", async (c) => {
	const { exportTrainingPairs } = await import("./predictor-training-pairs");
	const agentId = c.req.query("agent_id") ?? "default";
	const since = c.req.query("since");
	const rawLimit = Number.parseInt(c.req.query("limit") ?? "1000", 10);
	const limit = Math.min(Math.max(1, rawLimit), 10000);
	const format = c.req.query("format") ?? "ndjson";

	const pairs = exportTrainingPairs(getDbAccessor(), agentId, { since, limit });

	if (format === "csv") {
		const header = [
			"id",
			"agent_id",
			"session_key",
			"memory_id",
			"recency_days",
			"access_count",
			"importance",
			"decay_factor",
			"embedding_similarity",
			"entity_slot",
			"aspect_slot",
			"is_constraint",
			"structural_density",
			"fts_hit_count",
			"agent_relevance_score",
			"continuity_score",
			"fts_overlap_score",
			"combined_label",
			"was_injected",
			"predictor_rank",
			"baseline_rank",
			"created_at",
		].join(",");

		// RFC 4180: escape fields containing commas, quotes, or newlines
		function csvEscape(value: unknown): string {
			const str = value === null || value === undefined ? "" : String(value);
			if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
				return `"${str.replace(/"/g, '""')}"`;
			}
			return str;
		}

		const rows = pairs.map((p) =>
			[
				p.id,
				p.agentId,
				p.sessionKey,
				p.memoryId,
				p.features.recencyDays,
				p.features.accessCount,
				p.features.importance,
				p.features.decayFactor,
				p.features.embeddingSimilarity ?? "",
				p.features.entitySlot ?? "",
				p.features.aspectSlot ?? "",
				p.features.isConstraint ? 1 : 0,
				p.features.structuralDensity ?? "",
				p.features.ftsHitCount,
				p.label.agentRelevanceScore ?? "",
				p.label.continuityScore ?? "",
				p.label.ftsOverlapScore ?? "",
				p.label.combined,
				p.wasInjected ? 1 : 0,
				p.predictorRank ?? "",
				p.baselineRank ?? "",
				p.createdAt,
			]
				.map(csvEscape)
				.join(","),
		);

		return c.text([header, ...rows].join("\n"), 200, {
			"Content-Type": "text/csv",
		});
	}

	// Default: NDJSON
	const ndjsonLines = pairs.map((p) => JSON.stringify(p)).join("\n");
	return c.text(ndjsonLines, 200, { "Content-Type": "application/x-ndjson" });
});

app.get("/api/timeline/:id", (c) => {
	const entityId = c.req.param("id");
	const timeline = getDbAccessor().withReadDb((db) =>
		buildTimeline(
			{
				db,
				getRecentLogs: (opts) => logger.getRecent({ limit: opts.limit }),
				getRecentErrors: (opts) => analyticsCollector.getErrors({ limit: opts?.limit }),
			},
			entityId,
		),
	);
	return c.json(timeline);
});

app.get("/api/timeline/:id/export", (c) => {
	const entityId = c.req.param("id");
	const timeline = getDbAccessor().withReadDb((db) => {
		const sources: TimelineSources = {
			db,
			getRecentLogs: (opts) => logger.getRecent({ limit: opts.limit }),
			getRecentErrors: (opts) => analyticsCollector.getErrors({ limit: opts?.limit }),
		};
		return buildTimeline(sources, entityId);
	});
	return c.json({
		meta: {
			version: CURRENT_VERSION,
			exportedAt: new Date().toISOString(),
			entityId,
		},
		timeline,
	});
});

// ============================================================================
// Static Dashboard
// ============================================================================

function setupStaticServing() {
	const dashboardPath = getDashboardPath();

	if (dashboardPath) {
		app.use("/*", async (c, next) => {
			const path = c.req.path;
			if (path.startsWith("/api/") || path === "/health" || path === "/sse") {
				return next();
			}
			return serveStatic({
				root: dashboardPath,
				rewriteRequestPath: (p) => {
					if (!p.includes(".") || p === "/") {
						return "/index.html";
					}
					return p;
				},
			})(c, next);
		});
	} else {
		logger.warn("daemon", "Dashboard not found - API-only mode", {
			candidates: getDashboardCandidates(),
		});
		app.get("/", (c) => {
			return c.html(`
        <!DOCTYPE html>
        <html>
        <head><title>Signet Daemon</title></head>
        <body style="font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h1>◈ Signet Daemon</h1>
          <p>The daemon is running, but the dashboard is not installed.</p>
          <p>API endpoints:</p>
          <ul>
            <li><a href="/health">/health</a> - Health check</li>
            <li><a href="/api/status">/api/status</a> - Daemon status</li>
            <li><a href="/api/config">/api/config</a> - Config files</li>
            <li><a href="/api/memories">/api/memories</a> - Memories</li>
            <li><a href="/api/harnesses">/api/harnesses</a> - Harnesses</li>
            <li><a href="/api/skills">/api/skills</a> - Skills</li>
          </ul>
        </body>
        </html>
      `);
		});
	}
}

setupStaticServing();

// ============================================================================
// File Watcher
// ============================================================================

let watcher: ReturnType<typeof watch> | null = null;

// Track ingested files to avoid re-processing (path -> content hash)
const ingestedMemoryFiles = new Map<string, string>();

// Track synced memories to avoid duplicates
const syncedClaudeMemories = new Set<string>();

let syncTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_DEBOUNCE_MS = 2000;

async function syncHarnessConfigs() {
	const agentsMdPath = join(AGENTS_DIR, "AGENTS.md");
	if (!existsSync(agentsMdPath)) return;

	const rawContent = await Bun.file(agentsMdPath).text();
	const content = stripSignetBlock(rawContent);

	const buildHeader = (targetName: string) => {
		const files = [
			{ name: "SOUL.md", desc: "Personality & tone" },
			{ name: "IDENTITY.md", desc: "Agent identity" },
			{ name: "USER.md", desc: "User profile & preferences" },
			{ name: "MEMORY.md", desc: "Working memory context" },
			{ name: "agent.yaml", desc: "Configuration & settings" },
		];

		const safe = (p: string) => p.replace(/[\n\r]/g, "");

		const existingFiles = files.filter((f) => existsSync(join(AGENTS_DIR, f.name)));
		const fileList = existingFiles.map((f) => `#   - ${safe(join(AGENTS_DIR, f.name))} (${f.desc})`).join("\n");

		return `# ${targetName}
# ============================================================================
# AUTO-GENERATED from ${safe(agentsMdPath)} by Signet
# Generated: ${new Date().toISOString()}
#
# DO NOT EDIT THIS FILE - changes will be overwritten
# Edit the source file instead: ${safe(agentsMdPath)}
#
# Signet Agent Home: ${safe(AGENTS_DIR)}
# Dashboard: http://localhost:3850
# CLI: signet --help
#
# Related documents:
${fileList}
#
# Memory commands: /remember <content> | /recall <query>
# ============================================================================

`;
	};

	const identityExtras = (
		await Promise.all(
			["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"].map(async (name) => {
				const identityPath = join(AGENTS_DIR, name);
				if (!existsSync(identityPath)) return "";
				try {
					const fileContent = (await Bun.file(identityPath).text()).trim();
					if (!fileContent) return "";
					const header = name.replace(".md", "");
					return `\n## ${header}\n\n${fileContent}`;
				} catch {
					return "";
				}
			}),
		)
	)
		.filter(Boolean)
		.join("\n");

	const composed = content + identityExtras;

	const opencodeDir = join(homedir(), ".config", "opencode");
	if (existsSync(opencodeDir)) {
		try {
			const opencodeAgentsPath = join(opencodeDir, "AGENTS.md");
			if (await writeFileIfChangedAsync(opencodeAgentsPath, buildHeader("AGENTS.md") + composed)) {
				logger.sync.harness("opencode", "~/.config/opencode/AGENTS.md");
			}
		} catch (error) {
			logger.sync.failed("opencode", error instanceof Error ? error : new Error(String(error)));
		}
	}

	await syncAgentWorkspaces({
		agentsDir: AGENTS_DIR,
		onWorkspaceSynced: (name, workspaceAgentsPath) => {
			logger.sync.harness(`openclaw:${name}`, workspaceAgentsPath);
		},
		onError: (name, error) => {
			logger.error("sync", `Failed to sync agent workspace: ${name}`, error);
		},
	});
	await ensureArchitectureDoc();
}

async function ensureArchitectureDoc(): Promise<void> {
	const archPath = join(AGENTS_DIR, "SIGNET-ARCHITECTURE.md");
	try {
		const archContent = buildArchitectureDoc(AGENTS_DIR);
		if (await writeFileIfChangedAsync(archPath, archContent)) {
			logger.info("sync", "SIGNET-ARCHITECTURE.md updated");
		}
	} catch (error) {
		logger.error(
			"sync",
			"Failed to write SIGNET-ARCHITECTURE.md",
			error instanceof Error ? error : new Error(String(error)),
		);
	}
}

const syncRunner = createSingleFlightRunner(
	async () => {
		await syncHarnessConfigs();
	},
	(error) => {
		logger.error("sync", "Harness sync failed", error);
	},
);

function scheduleSyncHarnessConfigs() {
	if (syncTimer) {
		clearTimeout(syncTimer);
	}

	syncTimer = setTimeout(async () => {
		if (syncRunner.running) {
			syncRunner.requestRerun();
			return;
		}
		await syncRunner.execute();
	}, SYNC_DEBOUNCE_MS);
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function chunkMarkdownHierarchically(
	content: string,
	maxTokens = 512,
): {
	text: string;
	tokenCount: number;
	header: string;
	level: "section" | "paragraph";
}[] {
	const results: {
		text: string;
		tokenCount: number;
		header: string;
		level: "section" | "paragraph";
	}[] = [];
	const lines = content.split("\n");

	let currentHeader = "";
	let currentContent: string[] = [];
	const headerPattern = /^(#{1,3})\s+(.+)$/;

	const flushSection = () => {
		if (currentContent.length === 0) return;

		const sectionText = currentContent.join("\n").trim();
		if (!sectionText) return;

		const sectionTokens = estimateTokens(sectionText);

		if (sectionTokens <= maxTokens) {
			const textWithHeader = currentHeader ? `${currentHeader}\n\n${sectionText}` : sectionText;
			results.push({
				text: textWithHeader,
				tokenCount: estimateTokens(textWithHeader),
				header: currentHeader,
				level: "section",
			});
		} else {
			const paragraphs = sectionText.split(/\n\n+/);
			let chunkParas: string[] = [];
			let chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;

			for (const para of paragraphs) {
				const paraTokens = estimateTokens(para);

				if (paraTokens > maxTokens) {
					if (chunkParas.length > 0) {
						const text = currentHeader ? `${currentHeader}\n\n${chunkParas.join("\n\n")}` : chunkParas.join("\n\n");
						results.push({
							text,
							tokenCount: chunkTokens,
							header: currentHeader,
							level: "paragraph",
						});
						chunkParas = [];
						chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;
					}

					const text = currentHeader ? `${currentHeader}\n\n${para}` : para;
					results.push({
						text,
						tokenCount: estimateTokens(text),
						header: currentHeader,
						level: "paragraph",
					});
					continue;
				}

				if (chunkTokens + paraTokens + 2 > maxTokens && chunkParas.length > 0) {
					const text = currentHeader ? `${currentHeader}\n\n${chunkParas.join("\n\n")}` : chunkParas.join("\n\n");
					results.push({
						text,
						tokenCount: chunkTokens,
						header: currentHeader,
						level: "paragraph",
					});
					chunkParas = [];
					chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;
				}

				chunkParas.push(para);
				chunkTokens += paraTokens + 2;
			}

			if (chunkParas.length > 0) {
				const text = currentHeader ? `${currentHeader}\n\n${chunkParas.join("\n\n")}` : chunkParas.join("\n\n");
				results.push({
					text,
					tokenCount: chunkTokens,
					header: currentHeader,
					level: "paragraph",
				});
			}
		}

		currentContent = [];
	};

	for (const line of lines) {
		const match = line.match(headerPattern);
		if (match) {
			flushSection();
			currentHeader = line;
		} else {
			currentContent.push(line);
		}
	}

	flushSection();

	if (results.length === 0 && content.trim()) {
		const text = content.trim();
		results.push({
			text,
			tokenCount: estimateTokens(text),
			header: "",
			level: "section",
		});
	}

	return results;
}

export const ARTIFACT_FILENAME_RE = /--(?:summary|transcript|compaction|manifest)\.md$/;
export const MEMORY_BACKUP_FILENAME_RE = /^MEMORY\.(?:backup|bak|pre)-.+\.md$/;

async function ingestMemoryMarkdown(filePath: string): Promise<number> {
	if (filePath.endsWith("MEMORY.md")) return 0;

	const filenameWithExt = basename(filePath);
	if (MEMORY_BACKUP_FILENAME_RE.test(filenameWithExt) || ARTIFACT_FILENAME_RE.test(filenameWithExt)) return 0;

	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch (e) {
		logger.error("watcher", "Failed to read memory file", undefined, {
			path: filePath,
			error: String(e),
		});
		return 0;
	}

	if (!content.trim()) return 0;

	const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
	if (ingestedMemoryFiles.get(filePath) === hash) {
		logger.debug("watcher", "Memory file unchanged, skipping", {
			path: filePath,
		});
		return 0;
	}
	ingestedMemoryFiles.set(filePath, hash);

	const filename = basename(filePath, ".md");
	const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
	const date = dateMatch ? dateMatch[1] : null;

	const chunks = chunkMarkdownHierarchically(content, 512);
	let inserted = 0;

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];

		const body =
			chunk.header && chunk.text.startsWith(chunk.header)
				? chunk.text.slice(chunk.header.length).trim()
				: chunk.text.trim();
		if (body.length < 80) continue;

		const chunkKey = `openclaw:${filename}:${createHash("sha256").update(chunk.text).digest("hex").slice(0, 16)}`;
		try {
			const response = await fetch(`http://${INTERNAL_SELF_HOST}:${PORT}/api/memory/remember`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: chunk.text,
					who: "openclaw-memory",
					importance: chunk.level === "section" ? 0.65 : 0.55,
					sourceType: "openclaw-memory-log",
					sourceId: chunkKey,
					tags: [
						"openclaw",
						"memory-log",
						date || "named",
						filename,
						chunk.level === "section" ? "hierarchical-section" : "hierarchical-paragraph",
					]
						.filter(Boolean)
						.join(","),
				}),
			});

			if (response.ok) {
				inserted++;
			} else {
				logger.warn("watcher", "Failed to ingest memory chunk", {
					path: filePath,
					chunkIndex: i,
					status: response.status,
				});
			}
		} catch (e) {
			const errDetails = e instanceof Error ? { message: e.message } : { error: String(e) };
			logger.error("watcher", "Failed to ingest memory chunk", undefined, {
				path: filePath,
				chunkIndex: i,
				...errDetails,
			});
		}
	}

	if (inserted > 0) {
		logger.info("watcher", "Ingested memory file", {
			path: filePath,
			chunks: inserted,
			sections: chunks.filter((c) => c.level === "section").length,
			filename,
		});
	}
	return inserted;
}

async function importExistingMemoryFiles(): Promise<number> {
	const memoryDir = join(AGENTS_DIR, "memory");
	if (!existsSync(memoryDir)) {
		logger.debug("daemon", "Memory directory does not exist, skipping initial import");
		return 0;
	}

	let files: string[];
	try {
		files = readdirSync(memoryDir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
	} catch (e) {
		const errDetails = e instanceof Error ? { message: e.message } : { error: String(e) };
		logger.error("daemon", "Failed to read memory directory", undefined, errDetails);
		return 0;
	}

	let totalChunks = 0;
	for (const file of files) {
		const count = await ingestMemoryMarkdown(join(memoryDir, file));
		totalChunks += count;
	}

	if (totalChunks > 0) {
		logger.info("daemon", "Imported existing memory files", {
			files: files.length,
			chunks: totalChunks,
		});
	}
	return totalChunks;
}

function startClaudeMemoryWatcher() {
	const claudeProjectsDir = join(homedir(), ".claude", "projects");
	if (!existsSync(claudeProjectsDir)) return;

	const claudeWatcher = watch(join(claudeProjectsDir, "**", "memory", "MEMORY.md"), {
		persistent: true,
		ignoreInitial: true,
	});

	claudeWatcher.on("change", async (filePath) => {
		logger.info("watcher", "Claude memory changed", { path: filePath });
		await syncClaudeMemoryFile(filePath);
	});

	claudeWatcher.on("add", async (filePath) => {
		logger.info("watcher", "Claude memory added", { path: filePath });
		await syncClaudeMemoryFile(filePath);
	});
}

async function syncExistingClaudeMemories(claudeProjectsDir: string) {
	try {
		const projects = readdirSync(claudeProjectsDir);
		let totalSynced = 0;

		for (const project of projects) {
			const memoryFile = join(claudeProjectsDir, project, "memory", "MEMORY.md");
			if (existsSync(memoryFile)) {
				const count = await syncClaudeMemoryFile(memoryFile);
				totalSynced += count;
			}
		}

		if (totalSynced > 0) {
			logger.info("watcher", "Synced existing Claude memories", {
				count: totalSynced,
			});
		}
	} catch (e) {
		logger.error("watcher", "Failed to sync existing Claude memories", undefined, { error: String(e) });
	}
}

async function syncClaudeMemoryFile(filePath: string): Promise<number> {
	try {
		const content = readFileSync(filePath, "utf-8");
		if (!content.trim()) return 0;

		const match = filePath.match(/projects\/([^/]+)\/memory/);
		const projectId = match ? match[1] : "unknown";

		const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
		const existingHash = ingestedMemoryFiles.get(filePath);
		if (existingHash === contentHash) {
			logger.debug("watcher", "Claude memory file unchanged, skipping", {
				path: filePath,
			});
			return 0;
		}
		ingestedMemoryFiles.set(filePath, contentHash);

		const chunks = chunkMarkdownHierarchically(content, 512);
		let inserted = 0;

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];

			const sectionMatch = chunk.header.match(/^#+\s+(.+)$/);
			const sectionName = sectionMatch ? sectionMatch[1].toLowerCase() : "";

			const chunkKey = `claude:${projectId}:${createHash("sha256").update(chunk.text).digest("hex").slice(0, 16)}`;
			if (syncedClaudeMemories.has(chunkKey)) continue;
			syncedClaudeMemories.add(chunkKey);

			try {
				const response = await fetch(`http://${INTERNAL_SELF_HOST}:${PORT}/api/memory/remember`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						content: chunk.text,
						who: "claude-code",
						importance: chunk.level === "section" ? 0.65 : 0.55,
						sourceType: "claude-project-memory",
						sourceId: chunkKey,
						tags: [
							"claude-code",
							"claude-project-memory",
							sectionName,
							`project:${projectId}`,
							chunk.level === "section" ? "hierarchical-section" : "hierarchical-paragraph",
						]
							.filter(Boolean)
							.join(","),
					}),
				});

				if (response.ok) {
					inserted++;
					logger.info("watcher", "Synced Claude memory chunk", {
						content: chunk.text.slice(0, 50),
						section: sectionName || "(no section)",
						level: chunk.level,
					});
				}
			} catch (e) {
				const errDetails = e instanceof Error ? { message: e.message } : { error: String(e) };
				logger.error("watcher", "Failed to sync Claude memory chunk", undefined, {
					path: filePath,
					chunkIndex: i,
					...errDetails,
				});
			}
		}

		if (inserted > 0) {
			logger.info("watcher", "Synced Claude memory file", {
				path: filePath,
				projectId,
				chunks: inserted,
				sections: chunks.filter((c) => c.level === "section").length,
			});
		}
		return inserted;
	} catch (e) {
		const errDetails = e instanceof Error ? { message: e.message } : { error: String(e) };
		logger.error("watcher", "Failed to read Claude memory file", undefined, {
			path: filePath,
			...errDetails,
		});
		return 0;
	}
}

function startFileWatcher() {
	watcher = watch(
		[
			join(AGENTS_DIR, "agent.yaml"),
			join(AGENTS_DIR, "AGENTS.md"),
			join(AGENTS_DIR, "SOUL.md"),
			join(AGENTS_DIR, "MEMORY.md"),
			join(AGENTS_DIR, "IDENTITY.md"),
			join(AGENTS_DIR, "USER.md"),
			join(AGENTS_DIR, "SIGNET-ARCHITECTURE.md"),
			join(AGENTS_DIR, "memory"),
			join(AGENTS_DIR, "agents"),
		],
		{
			persistent: true,
			ignoreInitial: true,
			ignored: createAgentsWatcherIgnoreMatcher(AGENTS_DIR),
		},
	);

	watcher.on("change", (path) => {
		logger.info("watcher", "File changed", { path });
		scheduleAutoCommit(path);

		const base = basename(path);
		if (base === "agent.yaml" || base === "AGENT.yaml") {
			try {
				reloadAuthState(AGENTS_DIR);
				logger.info("config", "Auth config reloaded from disk");
			} catch (e) {
				logger.error("config", "Failed to reload auth config", e as Error);
			}
		}

		const SYNC_TRIGGER_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"];
		const normalizedForSync = path.replace(/\\/g, "/");
		const isAgentSubdir = normalizedForSync.includes(`${AGENTS_DIR.replace(/\\/g, "/")}/agents/`);
		if (SYNC_TRIGGER_FILES.some((f) => path.endsWith(f)) || isAgentSubdir) {
			scheduleSyncHarnessConfigs();
		}

		const normalizedPath = path.replace(/\\/g, "/");
		if (
			normalizedPath.includes("/memory/") &&
			normalizedPath.endsWith(".md") &&
			!normalizedPath.endsWith("MEMORY.md")
		) {
			ingestMemoryMarkdown(path).catch((e) =>
				logger.error("watcher", "Ingestion failed", undefined, {
					path,
					error: String(e),
				}),
			);
		}
	});

	watcher.on("unlink", (path) => {
		logger.info("watcher", "File removed", { path });
		if (path.endsWith("SIGNET-ARCHITECTURE.md")) {
			void ensureArchitectureDoc();
		}
		scheduleAutoCommit(path);
	});

	watcher.on("add", (path) => {
		logger.info("watcher", "File added", { path });
		scheduleAutoCommit(path);

		const normalizedAddPath = path.replace(/\\/g, "/");
		if (
			normalizedAddPath.includes("/memory/") &&
			normalizedAddPath.endsWith(".md") &&
			!normalizedAddPath.endsWith("MEMORY.md")
		) {
			ingestMemoryMarkdown(path).catch((e) =>
				logger.error("watcher", "Ingestion failed", undefined, {
					path,
					error: String(e),
				}),
			);
		}
	});

	startClaudeMemoryWatcher();
}

// ============================================================================
// Shadow daemon helpers
// ============================================================================

function resolveDaemonBinary(): string | null {
	const ext = process.platform === "win32" ? ".exe" : "";
	const arch = process.arch;
	const plat = process.platform;
	const monoRoot = join(import.meta.dir, "..", "..", "..");
	const devPaths = [
		join(monoRoot, "packages", "daemon-rs", "target", "release", `signet-daemon${ext}`),
		join(monoRoot, "packages", "daemon-rs", "target", "debug", `signet-daemon${ext}`),
		join(process.cwd(), "packages", "daemon-rs", "target", "release", `signet-daemon${ext}`),
	];
	for (const p of devPaths) {
		if (existsSync(p)) return p;
	}
	const name = `signet-daemon-${plat}-${arch}${ext}`;
	const npmPath = join(import.meta.dir, "..", "bin", name);
	if (existsSync(npmPath)) return npmPath;
	return null;
}

function setupShadowDb(agentsDir: string): string {
	const shadowRoot = join(agentsDir, ".shadow");
	const shadowMemDir = join(shadowRoot, "memory");
	mkdirSync(shadowMemDir, { recursive: true });

	const mainDb = join(agentsDir, "memory", "memories.db");
	const shadowDb = join(shadowMemDir, "memories.db");
	const stale = !existsSync(shadowDb) || Date.now() - statSync(shadowDb).mtimeMs > 24 * 60 * 60 * 1000;
	if (stale && existsSync(mainDb)) {
		copyFileSync(mainDb, shadowDb);
		for (const ext of ["-wal", "-shm"]) {
			const src = mainDb + ext;
			if (existsSync(src)) copyFileSync(src, shadowDb + ext);
		}
		logger.info("shadow", "Shadow DB refreshed");
	}

	const mainCfg = join(agentsDir, "agent.yaml");
	const shadowCfg = join(shadowRoot, "agent.yaml");
	if (existsSync(mainCfg)) copyFileSync(mainCfg, shadowCfg);

	return shadowRoot;
}

function appendDivergence(agentsDir: string, entry: Record<string, unknown>) {
	const logPath = join(agentsDir, ".daemon", "logs", "shadow-divergences.jsonl");
	appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

// ============================================================================
// Pipeline runtime
// ============================================================================

function readPipelineMode(cfg: ResolvedMemoryConfig["pipelineV2"]): string {
	if (!cfg.enabled) return "disabled";
	if (cfg.paused) return "paused";
	if (cfg.mutationsFrozen) return "frozen";
	if (cfg.nativeShadowEnabled) return "shadow";
	if (cfg.shadowMode) return "shadow";
	return "controlled-write";
}

function clearStructuralBackfillTimer(): void {
	if (!structuralBackfillTimer) return;
	clearTimeout(structuralBackfillTimer);
	structuralBackfillTimer = null;
}

async function stopPipelineRuntime(): Promise<void> {
	clearStructuralBackfillTimer();

	if (skillReconcilerHandle) {
		try {
			await skillReconcilerHandle.stop();
		} catch {}
		skillReconcilerHandle = null;
	}

	if (shadowProcess) {
		try {
			shadowProcess.kill();
		} catch {}
		shadowProcess = null;
	}

	if (predictorClientRef) {
		try {
			await predictorClientRef.stop();
		} catch {}
		predictorClientRef = null;
		setPredictorClientRef(null);
	}

	if (embeddingTrackerHandle) {
		try {
			await embeddingTrackerHandle.stop();
		} catch {}
		embeddingTrackerHandle = null;
		setEmbeddingTrackerHandle(null);
	}

	if (dreamingWorkerHandle) {
		dreamingWorkerHandle.stop();
		if (dreamingWorkerHandle.activePass) {
			const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30_000));
			await Promise.race([dreamingWorkerHandle.activePass.catch(() => undefined), timeout]);
		}
		dreamingWorkerHandle = null;
		setDreamingWorker(null);
	}

	if (schedulerHandle) {
		try {
			await schedulerHandle.stop();
		} catch {}
		schedulerHandle = null;
	}

	try {
		await stopPipeline();
	} catch {}

	closeLlmProvider();
	closeSynthesisProvider();
	closeWidgetProvider();
	stopOpenCodeServer();
	stopModelRegistry();
	invalidateDiagnosticsCache();
}

async function restartPipelineRuntime(memoryCfg: ResolvedMemoryConfig, telemetry?: TelemetryCollector): Promise<void> {
	await stopPipelineRuntime();
	await startPipelineRuntime(memoryCfg, telemetry);
}

function syncAgentRoster(agentsDir: string): void {
	const paths = [join(agentsDir, "agent.yaml"), join(agentsDir, "AGENT.yaml")];
	let roster: readonly AgentDefinition[] = [];
	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const yaml = parseSimpleYaml(readFileSync(p, "utf-8")) as Record<string, unknown>;
			const agents = yaml.agents as Record<string, unknown> | undefined;
			const raw = agents?.roster;
			if (Array.isArray(raw)) {
				roster = raw as AgentDefinition[];
			}
		} catch {}
		break;
	}
	if (roster.length === 0) return;

	const db = getDbAccessor();
	const now = new Date().toISOString();
	db.withWriteTx((w) => {
		const stmt = w.prepare(
			`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   name = excluded.name,
			   read_policy = excluded.read_policy,
			   policy_group = excluded.policy_group,
			   updated_at = excluded.updated_at`,
		);
		for (const entry of roster) {
			const normalized = normalizeAgentRosterEntry(entry);
			if (!normalized) continue;
			stmt.run(normalized.name, normalized.name, normalized.readPolicy, normalized.policyGroup, now, now);
		}
	});
	logger.info("daemon", "Agent roster synced", { count: roster.length });
}

async function startPipelineRuntime(memoryCfg: ResolvedMemoryConfig, telemetry?: TelemetryCollector): Promise<void> {
	const pipelinePaused = memoryCfg.pipelineV2.paused;
	clearStructuralBackfillTimer();
	logger.info("config", "Resolved embedding config", {
		provider: memoryCfg.embedding.provider,
		model: memoryCfg.embedding.model,
		dimensions: memoryCfg.embedding.dimensions,
	});

	reloadAuthState(AGENTS_DIR);

	const providerHints = getConfiguredProviderHints(AGENTS_DIR);
	const validExtractionProviders = new Set([
		"none",
		"ollama",
		"claude-code",
		"opencode",
		"codex",
		"anthropic",
		"openrouter",
		"command",
	]);
	const validSynthesisProviders = new Set([
		"none",
		"ollama",
		"claude-code",
		"codex",
		"opencode",
		"anthropic",
		"openrouter",
	]);

	providerRuntimeResolution.extraction = {
		configured: providerHints.extraction,
		resolved: memoryCfg.pipelineV2.extraction.provider,
		effective: memoryCfg.pipelineV2.extraction.provider,
		fallbackProvider: memoryCfg.pipelineV2.extraction.fallbackProvider,
		status: "active",
		degraded: false,
		fallbackApplied: false,
		reason: null,
		since: null,
	};
	providerRuntimeResolution.synthesis = {
		configured: providerHints.synthesis,
		resolved: memoryCfg.pipelineV2.synthesis.enabled ? memoryCfg.pipelineV2.synthesis.provider : null,
		effective: memoryCfg.pipelineV2.synthesis.enabled ? memoryCfg.pipelineV2.synthesis.provider : null,
	};
	if (providerHints.extraction && !validExtractionProviders.has(providerHints.extraction)) {
		logger.warn("config", "Unsupported extraction provider configured, using resolved fallback", {
			configured: providerHints.extraction,
			resolved: memoryCfg.pipelineV2.extraction.provider,
		});
	}
	if (
		providerHints.synthesis &&
		memoryCfg.pipelineV2.synthesis.enabled &&
		!validSynthesisProviders.has(providerHints.synthesis)
	) {
		logger.warn("config", "Unsupported synthesis provider configured, using resolved fallback", {
			configured: providerHints.synthesis,
			resolved: memoryCfg.pipelineV2.synthesis.provider,
		});
	}

	const extractionFallbackProvider = memoryCfg.pipelineV2.extraction.fallbackProvider;
	let effectiveExtractionProvider = memoryCfg.pipelineV2.extraction.provider;
	let extractionStatus: "active" | "degraded" | "blocked" | "disabled" | "paused" = "active";
	let extractionDegraded = false;
	let extractionFallbackApplied = false;
	let extractionReason: string | null = null;
	let extractionSince: string | null = null;
	const extractionOllamaBaseUrl = normalizeRuntimeBaseUrl(
		memoryCfg.pipelineV2.extraction.endpoint,
		"http://127.0.0.1:11434",
	);
	const extractionOllamaFallbackBaseUrl =
		memoryCfg.pipelineV2.extraction.provider === "opencode" ? "http://127.0.0.1:11434" : extractionOllamaBaseUrl;
	const extractionOpenCodeBaseUrl = normalizeRuntimeBaseUrl(
		memoryCfg.pipelineV2.extraction.endpoint,
		"http://127.0.0.1:4096",
	);
	const extractionOpenRouterBaseUrl = normalizeRuntimeBaseUrl(
		memoryCfg.pipelineV2.extraction.endpoint,
		"https://openrouter.ai/api/v1",
	);
	const ollamaFallbackMaxContextTokens = resolveDefaultOllamaFallbackMaxContextTokens();
	const extractionOpenCodeShouldManage = isManagedOpenCodeLocalEndpoint(extractionOpenCodeBaseUrl);

	const markExtractionUnavailable = (reason: string): void => {
		extractionReason = reason;
		extractionSince = new Date().toISOString();
		extractionDegraded = true;
		if (extractionFallbackProvider === "ollama" && effectiveExtractionProvider !== "ollama") {
			effectiveExtractionProvider = "ollama";
			extractionStatus = "degraded";
			extractionFallbackApplied = true;
			return;
		}
		effectiveExtractionProvider = "none";
		extractionStatus = "blocked";
		extractionFallbackApplied = false;
	};

	if (pipelinePaused) {
		logger.info("config", "Pipeline paused; extraction provider startup deferred");
		effectiveExtractionProvider = "none";
		extractionStatus = "paused";
	} else if (effectiveExtractionProvider === "none") {
		logger.info("config", "Extraction provider set to 'none', pipeline LLM disabled");
		extractionStatus = "disabled";
	} else if (effectiveExtractionProvider === "command") {
		logger.info(
			"config",
			"Extraction provider set to 'command'; summary worker will execute pipelineV2.extraction.command",
		);
	} else if (effectiveExtractionProvider === "opencode") {
		if (extractionOpenCodeShouldManage) {
			const serverReady = await ensureOpenCodeServer(4096);
			if (!serverReady) {
				markExtractionUnavailable("OpenCode server not available for extraction startup preflight");
			}
		} else {
			logger.info("config", "Using external OpenCode endpoint for extraction", {
				baseUrl: redactUrlForLogs(extractionOpenCodeBaseUrl),
			});
		}
	} else if (effectiveExtractionProvider === "claude-code") {
		const resolvedClaude = Bun.which("claude");
		if (resolvedClaude === null) {
			markExtractionUnavailable("Claude Code CLI not found during extraction startup preflight");
		} else {
			try {
				const exitCode = await new Promise<number>((resolve) => {
					const proc = spawn(resolvedClaude, ["--version"], {
						stdio: "pipe",
						windowsHide: true,
						env: { ...process.env, SIGNET_NO_HOOKS: "1" },
					});
					proc.on("close", (code) => resolve(code ?? 1));
					proc.on("error", () => resolve(1));
				});
				if (exitCode !== 0) throw new Error("non-zero exit");
			} catch {
				markExtractionUnavailable("Claude Code CLI failed extraction startup preflight");
			}
		}
	} else if (effectiveExtractionProvider === "codex") {
		const resolvedCodex = Bun.which("codex");
		if (resolvedCodex === null) {
			markExtractionUnavailable("Codex CLI not found during extraction startup preflight");
		} else {
			try {
				const exitCode = await new Promise<number>((resolve) => {
					const proc = spawn(resolvedCodex, ["--version"], {
						stdio: "pipe",
						windowsHide: true,
						env: {
							...process.env,
							SIGNET_NO_HOOKS: "1",
							SIGNET_CODEX_BYPASS_WRAPPER: "1",
						},
					});
					proc.on("close", (code) => resolve(code ?? 1));
					proc.on("error", () => resolve(1));
				});
				if (exitCode !== 0) throw new Error("non-zero exit");
			} catch {
				markExtractionUnavailable("Codex CLI failed extraction startup preflight");
			}
		}
	}
	const keyCache = new Map<"ANTHROPIC_API_KEY" | "OPENROUTER_API_KEY", string | undefined>();
	const getKey = async (name: "ANTHROPIC_API_KEY" | "OPENROUTER_API_KEY"): Promise<string | undefined> => {
		if (keyCache.has(name)) return keyCache.get(name);
		let key = process.env[name];
		if (!key) {
			try {
				key = (await getSecret(name)) ?? undefined;
			} catch {
				logger.warn("config", `Failed to resolve ${name} from secrets store`);
			}
		}
		keyCache.set(name, key);
		return key;
	};

	let anthropicApiKey: string | undefined;
	const needsAnthropicForSynthesis =
		memoryCfg.pipelineV2.synthesis.enabled && memoryCfg.pipelineV2.synthesis.provider === "anthropic";
	if (effectiveExtractionProvider === "anthropic" || needsAnthropicForSynthesis) {
		anthropicApiKey = await getKey("ANTHROPIC_API_KEY");
		if (!anthropicApiKey) {
			logger.error(
				"config",
				"ANTHROPIC_API_KEY not found — falling back to ollama. Set via env or `signet secrets set ANTHROPIC_API_KEY`",
			);
			if (effectiveExtractionProvider === "anthropic") {
				markExtractionUnavailable("ANTHROPIC_API_KEY not found for extraction startup preflight");
			}
		}
	}

	let openRouterApiKey: string | undefined;
	const needsOpenRouterForSynthesis =
		memoryCfg.pipelineV2.synthesis.enabled && memoryCfg.pipelineV2.synthesis.provider === "openrouter";
	if (effectiveExtractionProvider === "openrouter" || needsOpenRouterForSynthesis) {
		openRouterApiKey = await getKey("OPENROUTER_API_KEY");
		if (!openRouterApiKey) {
			logger.error(
				"config",
				"OPENROUTER_API_KEY not found — falling back to ollama. Set via env or `signet secrets set OPENROUTER_API_KEY`",
			);
			if (effectiveExtractionProvider === "openrouter") {
				markExtractionUnavailable("OPENROUTER_API_KEY not found for extraction startup preflight");
			}
		}
	}

	const createExtractionProvider = (provider: typeof effectiveExtractionProvider) => {
		const model = resolveRuntimeModel(
			provider,
			memoryCfg.pipelineV2.extraction.provider,
			memoryCfg.pipelineV2.extraction.model,
		);
		const usingExtractionOllamaFallback =
			provider === "ollama" && memoryCfg.pipelineV2.extraction.provider !== "ollama";
		if (provider === "none") return null;
		if (provider === "anthropic") {
			if (!anthropicApiKey) return null;
			return createAnthropicProvider({
				model: model || "haiku",
				apiKey: anthropicApiKey,
				defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
			});
		}
		if (provider === "openrouter") {
			if (!openRouterApiKey) return null;
			return createOpenRouterProvider({
				model: model || "openai/gpt-4o-mini",
				apiKey: openRouterApiKey,
				baseUrl: extractionOpenRouterBaseUrl,
				referer: readEnvTrimmed("OPENROUTER_HTTP_REFERER"),
				title: readEnvTrimmed("OPENROUTER_TITLE"),
				defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
			});
		}
		if (provider === "opencode") {
			return createOpenCodeProvider({
				model: model || "anthropic/claude-haiku-4-5-20251001",
				baseUrl: extractionOpenCodeBaseUrl,
				ollamaFallbackBaseUrl: extractionOllamaFallbackBaseUrl,
				ollamaFallbackMaxContextTokens: ollamaFallbackMaxContextTokens,
				defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
			});
		}
		if (provider === "claude-code") {
			return createClaudeCodeProvider({
				model: model || "haiku",
				defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
			});
		}
		if (provider === "codex") {
			return createCodexProvider({
				model: model || "gpt-5-codex-mini",
				defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
			});
		}
		return createOllamaProvider({
			...(model ? { model } : {}),
			baseUrl: extractionOllamaFallbackBaseUrl,
			defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
			...(usingExtractionOllamaFallback
				? {
						maxContextTokens: ollamaFallbackMaxContextTokens,
					}
				: {}),
		});
	};

	let llmProvider = createExtractionProvider(effectiveExtractionProvider);
	if (llmProvider) {
		const preflightOk = await llmProvider.available();
		if (!preflightOk) {
			const failedProvider = effectiveExtractionProvider;
			const failedReason = extractionReason ?? `Extraction provider ${failedProvider} failed startup preflight`;
			if (failedProvider !== "ollama" && extractionFallbackProvider === "ollama") {
				extractionReason = failedReason;
				extractionSince = extractionSince ?? new Date().toISOString();
				extractionDegraded = true;
				extractionFallbackApplied = true;
				extractionStatus = "degraded";
				effectiveExtractionProvider = "ollama";
				llmProvider = createExtractionProvider("ollama");
				if (!llmProvider || !(await llmProvider.available())) {
					effectiveExtractionProvider = "none";
					extractionStatus = "blocked";
					extractionFallbackApplied = false;
					extractionReason = `${failedReason}; ollama fallback startup preflight failed`;
					llmProvider = null;
				}
			} else {
				effectiveExtractionProvider = "none";
				extractionStatus = "blocked";
				extractionDegraded = true;
				extractionFallbackApplied = false;
				extractionReason =
					extractionFallbackProvider === "none" ? `${failedReason}; fallbackProvider is none` : failedReason;
				extractionSince = extractionSince ?? new Date().toISOString();
				llmProvider = null;
			}
		}
	}

	const effectiveExtractionModel = resolveRuntimeModel(
		effectiveExtractionProvider,
		memoryCfg.pipelineV2.extraction.provider,
		memoryCfg.pipelineV2.extraction.model,
	);
	providerRuntimeResolution.extraction = {
		configured: providerHints.extraction,
		resolved: memoryCfg.pipelineV2.extraction.provider,
		effective: effectiveExtractionProvider,
		fallbackProvider: extractionFallbackProvider,
		status: extractionStatus,
		degraded: extractionDegraded,
		fallbackApplied: extractionFallbackApplied,
		reason: extractionReason,
		since: extractionSince,
	};
	if (providerHints.extraction && providerHints.extraction !== effectiveExtractionProvider) {
		logger.warn("config", "Extraction provider resolved differently than configured", {
			configured: providerHints.extraction,
			resolved: memoryCfg.pipelineV2.extraction.provider,
			effective: effectiveExtractionProvider,
			fallbackProvider: extractionFallbackProvider,
			status: extractionStatus,
			reason: extractionReason,
		});
	}
	logger.info("config", "Extraction provider", {
		configured: providerHints.extraction,
		resolved: memoryCfg.pipelineV2.extraction.provider,
		effective: effectiveExtractionProvider,
		fallbackProvider: extractionFallbackProvider,
		status: extractionStatus,
		degraded: extractionDegraded,
		reason: extractionReason,
		endpoint: redactUrlForLogs(
			effectiveExtractionProvider === "ollama"
				? extractionOllamaFallbackBaseUrl
				: effectiveExtractionProvider === "opencode"
					? extractionOpenCodeBaseUrl
					: effectiveExtractionProvider === "openrouter"
						? extractionOpenRouterBaseUrl
						: undefined,
		),
	});
	const extractionModelName = effectiveExtractionModel ?? memoryCfg.pipelineV2.extraction.model;
	if (
		effectiveExtractionProvider === "anthropic" ||
		effectiveExtractionProvider === "openrouter" ||
		effectiveExtractionProvider === "opencode"
	) {
		logger.warn(
			"config",
			"Extraction is intended for Claude Code (Haiku), Codex CLI (GPT Mini) on Pro/Max, or local Ollama qwen3:4b+. Remote API extraction can create extreme fees fast. Set provider to 'none' to disable it on a VPS.",
			{
				provider: effectiveExtractionProvider,
				model: extractionModelName,
			},
		);
	}

	if (
		effectiveExtractionProvider === "claude-code" &&
		extractionModelName &&
		!extractionModelName.toLowerCase().includes("haiku")
	) {
		logger.warn("config", "Claude Code extraction is safest on Haiku. Larger models increase cost significantly.", {
			model: extractionModelName,
		});
	}
	if (
		effectiveExtractionProvider === "codex" &&
		extractionModelName &&
		!extractionModelName.toLowerCase().includes("mini")
	) {
		logger.warn("config", "Codex extraction is safest on GPT Mini. Larger models increase cost significantly.", {
			model: extractionModelName,
		});
	}

	const startupExtractionBlocked = extractionStatus === "blocked" && extractionReason !== null;
	if (startupExtractionBlocked && !llmProvider) {
		const blockedReason = extractionReason ?? "Extraction provider unavailable during startup preflight";
		const deadLettered = deadLetterPendingExtractionJobs(getDbAccessor(), {
			reason: blockedReason,
			extractionModel: effectiveExtractionModel || undefined,
		});
		if (deadLettered > 0) {
			logger.warn("pipeline", "Dead-lettered pending extraction jobs at startup", {
				count: deadLettered,
				reason: blockedReason,
			});
		}
	}
	if (llmProvider) {
		llmProvider = withRateLimit(llmProvider, memoryCfg.pipelineV2.extraction.rateLimit);
		initLlmProvider(llmProvider);
	}

	if (memoryCfg.pipelineV2.modelRegistry.enabled && !pipelinePaused) {
		const registryAnthropicApiKey = anthropicApiKey ?? (await getKey("ANTHROPIC_API_KEY"));
		const registryOpenRouterApiKey = openRouterApiKey ?? (await getKey("OPENROUTER_API_KEY"));
		initModelRegistry(
			memoryCfg.pipelineV2.modelRegistry,
			effectiveExtractionProvider === "ollama" ? extractionOllamaBaseUrl : undefined,
			registryAnthropicApiKey,
			registryOpenRouterApiKey,
			effectiveExtractionProvider === "openrouter" ? extractionOpenRouterBaseUrl : undefined,
		);
	}

	if (pipelinePaused) {
		providerRuntimeResolution.synthesis = {
			configured: providerHints.synthesis,
			resolved: memoryCfg.pipelineV2.synthesis.enabled ? memoryCfg.pipelineV2.synthesis.provider : null,
			effective: null,
		};
		logger.info("config", "Pipeline paused; synthesis provider startup deferred");
	} else if (memoryCfg.pipelineV2.synthesis.provider === "none") {
		logger.info("config", "Synthesis provider set to 'none', synthesis disabled");
	} else if (memoryCfg.pipelineV2.synthesis.enabled) {
		let effectiveSynthesisProvider = memoryCfg.pipelineV2.synthesis.provider;
		const synthesisOllamaBaseUrl = normalizeRuntimeBaseUrl(
			memoryCfg.pipelineV2.synthesis.endpoint,
			"http://127.0.0.1:11434",
		);
		const synthesisOllamaFallbackBaseUrl =
			memoryCfg.pipelineV2.synthesis.provider === "opencode" ? "http://127.0.0.1:11434" : synthesisOllamaBaseUrl;
		const synthesisOpenCodeBaseUrl = normalizeRuntimeBaseUrl(
			memoryCfg.pipelineV2.synthesis.endpoint,
			"http://127.0.0.1:4096",
		);
		const synthesisOpenRouterBaseUrl = normalizeRuntimeBaseUrl(
			memoryCfg.pipelineV2.synthesis.endpoint,
			"https://openrouter.ai/api/v1",
		);
		const synthesisOpenCodeShouldManage = isManagedOpenCodeLocalEndpoint(synthesisOpenCodeBaseUrl);
		if (effectiveSynthesisProvider === "opencode") {
			if (synthesisOpenCodeShouldManage) {
				const serverReady = await ensureOpenCodeServer(4096);
				if (!serverReady) {
					logger.warn("config", "OpenCode server not available for synthesis, falling back to ollama");
					effectiveSynthesisProvider = "ollama";
				}
			} else {
				logger.info("config", "Using external OpenCode endpoint for synthesis", {
					baseUrl: redactUrlForLogs(synthesisOpenCodeBaseUrl),
				});
			}
		} else if (effectiveSynthesisProvider === "anthropic") {
			if (!anthropicApiKey) {
				logger.warn("config", "ANTHROPIC_API_KEY not found for synthesis, falling back to ollama");
				effectiveSynthesisProvider = "ollama";
			}
		} else if (effectiveSynthesisProvider === "openrouter") {
			if (!openRouterApiKey) {
				logger.warn("config", "OPENROUTER_API_KEY not found for synthesis, falling back to ollama");
				effectiveSynthesisProvider = "ollama";
			}
		} else if (effectiveSynthesisProvider === "claude-code") {
			const resolvedClaude = Bun.which("claude");
			if (resolvedClaude === null) {
				logger.warn("config", "Claude Code CLI not found, falling back to ollama for synthesis");
				effectiveSynthesisProvider = "ollama";
			} else {
				try {
					const exitCode = await new Promise<number>((resolve) => {
						const proc = spawn(resolvedClaude, ["--version"], {
							stdio: "pipe",
							windowsHide: true,
							env: { ...process.env, SIGNET_NO_HOOKS: "1" },
						});
						proc.on("close", (code) => resolve(code ?? 1));
						proc.on("error", () => resolve(1));
					});
					if (exitCode !== 0) throw new Error("non-zero exit");
				} catch {
					logger.warn("config", "Claude Code CLI not found, falling back to ollama for synthesis");
					effectiveSynthesisProvider = "ollama";
				}
			}
		} else if (effectiveSynthesisProvider === "codex") {
			const resolvedCodex = Bun.which("codex");
			if (resolvedCodex === null) {
				logger.warn("config", "Codex CLI not found, falling back to ollama for synthesis");
				effectiveSynthesisProvider = "ollama";
			} else {
				try {
					const exitCode = await new Promise<number>((resolve) => {
						const proc = spawn(resolvedCodex, ["--version"], {
							stdio: "pipe",
							windowsHide: true,
							env: {
								...process.env,
								SIGNET_NO_HOOKS: "1",
								SIGNET_CODEX_BYPASS_WRAPPER: "1",
							},
						});
						proc.on("close", (code) => resolve(code ?? 1));
						proc.on("error", () => resolve(1));
					});
					if (exitCode !== 0) throw new Error("non-zero exit");
				} catch {
					logger.warn("config", "Codex CLI not found, falling back to ollama for synthesis");
					effectiveSynthesisProvider = "ollama";
				}
			}
		}
		providerRuntimeResolution.synthesis = {
			configured: providerHints.synthesis,
			resolved: memoryCfg.pipelineV2.synthesis.provider,
			effective: effectiveSynthesisProvider,
		};
		if (providerHints.synthesis && providerHints.synthesis !== effectiveSynthesisProvider) {
			logger.warn("config", "Synthesis provider resolved differently than configured", {
				configured: providerHints.synthesis,
				resolved: memoryCfg.pipelineV2.synthesis.provider,
				effective: effectiveSynthesisProvider,
			});
		}
		logger.info("config", "Synthesis provider", {
			configured: providerHints.synthesis,
			resolved: memoryCfg.pipelineV2.synthesis.provider,
			effective: effectiveSynthesisProvider,
			endpoint: redactUrlForLogs(
				effectiveSynthesisProvider === "ollama"
					? synthesisOllamaFallbackBaseUrl
					: effectiveSynthesisProvider === "opencode"
						? synthesisOpenCodeBaseUrl
						: effectiveSynthesisProvider === "openrouter"
							? synthesisOpenRouterBaseUrl
							: undefined,
			),
		});

		const effectiveSynthesisModel = resolveRuntimeModel(
			effectiveSynthesisProvider,
			memoryCfg.pipelineV2.synthesis.provider,
			memoryCfg.pipelineV2.synthesis.model,
		);
		const usingSynthesisOllamaFallback =
			effectiveSynthesisProvider === "ollama" && memoryCfg.pipelineV2.synthesis.provider !== "ollama";

		let synthesisProvider =
			effectiveSynthesisProvider === "anthropic" && anthropicApiKey
				? createAnthropicProvider({
						model: effectiveSynthesisModel || "haiku",
						apiKey: anthropicApiKey,
						defaultTimeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
					})
				: effectiveSynthesisProvider === "openrouter" && openRouterApiKey
					? createOpenRouterProvider({
							model: effectiveSynthesisModel || "openai/gpt-4o-mini",
							apiKey: openRouterApiKey,
							baseUrl: synthesisOpenRouterBaseUrl,
							referer: readEnvTrimmed("OPENROUTER_HTTP_REFERER"),
							title: readEnvTrimmed("OPENROUTER_TITLE"),
							defaultTimeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
						})
					: effectiveSynthesisProvider === "opencode"
						? createOpenCodeProvider({
								model: effectiveSynthesisModel || "anthropic/claude-haiku-4-5-20251001",
								baseUrl: synthesisOpenCodeBaseUrl,
								ollamaFallbackBaseUrl: synthesisOllamaFallbackBaseUrl,
								ollamaFallbackMaxContextTokens: ollamaFallbackMaxContextTokens,
								defaultTimeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
							})
						: effectiveSynthesisProvider === "codex"
							? createCodexProvider({
									model: effectiveSynthesisModel || "gpt-5-codex-mini",
									defaultTimeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
								})
							: effectiveSynthesisProvider === "claude-code"
								? createClaudeCodeProvider({
										model: effectiveSynthesisModel || "haiku",
										defaultTimeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
									})
								: createOllamaProvider({
										...(effectiveSynthesisModel ? { model: effectiveSynthesisModel } : {}),
										baseUrl: synthesisOllamaFallbackBaseUrl,
										defaultTimeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
										...(usingSynthesisOllamaFallback
											? {
													maxContextTokens: ollamaFallbackMaxContextTokens,
												}
											: {}),
									});
		initSynthesisProvider(synthesisProvider);
		const widgetProvider = synthesisProvider;
		synthesisProvider = withRateLimit(synthesisProvider, memoryCfg.pipelineV2.synthesis.rateLimit);
		initSynthesisProvider(synthesisProvider);
		// Widget generation uses the same model family by default, but should not
		// consume the background synthesis rate-limit budget.
		if (
			memoryCfg.pipelineV2.synthesis.rateLimit !== undefined &&
			Object.keys(memoryCfg.pipelineV2.synthesis.rateLimit).length > 0
		) {
			logger.info("pipeline", "Widget synthesis provider is exempt from the synthesis rate limit", {
				rateLimit: memoryCfg.pipelineV2.synthesis.rateLimit,
			});
		}
		initWidgetProvider(widgetProvider);
	} else {
		providerRuntimeResolution.synthesis = {
			configured: providerHints.synthesis,
			resolved: null,
			effective: null,
		};
		logger.info("config", "Synthesis disabled");
	}

	if (memoryCfg.pipelineV2.enabled && !pipelinePaused && effectiveExtractionProvider !== "none") {
		startPipeline(
			getDbAccessor(),
			memoryCfg.pipelineV2,
			memoryCfg.embedding,
			fetchEmbedding,
			memoryCfg.search,
			providerTracker,
			analyticsCollector,
			telemetry,
		);
	} else {
		ensureRetentionWorker(getDbAccessor(), DEFAULT_RETENTION);
	}

	if (memoryCfg.embedding.provider !== "none" && memoryCfg.pipelineV2.embeddingTracker.enabled && !pipelinePaused) {
		embeddingTrackerHandle = startEmbeddingTracker(
			getDbAccessor(),
			memoryCfg.embedding,
			memoryCfg.pipelineV2.embeddingTracker,
			fetchEmbedding,
			checkEmbeddingProvider,
		);
		setEmbeddingTrackerHandle(embeddingTrackerHandle);
	}

	if (memoryCfg.dreaming.enabled && !pipelinePaused && !memoryCfg.pipelineV2.mutationsFrozen) {
		try {
			dreamingWorkerHandle = startDreamingWorker(getDbAccessor(), memoryCfg.dreaming, AGENTS_DIR, resolveAgentId({}));
			setDreamingWorker(dreamingWorkerHandle);
		} catch (err) {
			logger.warn("dreaming", "Failed to start dreaming worker (non-fatal)", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	if (memoryCfg.pipelineV2.graph.enabled && memoryCfg.pipelineV2.structural.enabled && !pipelinePaused) {
		const backfillCtx: RepairContext = {
			reason: "post-upgrade structural backfill",
			actor: "daemon",
			actorType: "daemon",
		};
		structuralBackfillTimer = setTimeout(() => {
			structuralBackfillTimer = null;
			try {
				const result = structuralBackfill(getDbAccessor(), memoryCfg.pipelineV2, backfillCtx, repairLimiter, {
					batchSize: 50,
				});
				if (result.affected > 0) {
					logger.info("pipeline", "Structural backfill completed", {
						affected: result.affected,
						message: result.message,
					});
				}
			} catch (err) {
				logger.warn("pipeline", "Structural backfill failed (non-fatal)", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}, 10_000);
	}

	if (memoryCfg.pipelineV2.predictor?.enabled && !pipelinePaused) {
		const predictorCfg = memoryCfg.pipelineV2.predictor;
		try {
			const client = createPredictorClient(predictorCfg, "default", memoryCfg.embedding.dimensions);
			await client.start();
			predictorClientRef = client;
			setPredictorClientRef(client);
			logger.info("predictor", "Predictor sidecar started");
		} catch (err) {
			logger.warn("predictor", "Failed to start predictor sidecar (non-fatal)", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	if (memoryCfg.pipelineV2.nativeShadowEnabled) {
		const binary = resolveDaemonBinary();
		if (binary) {
			const shadowAgentsDir = setupShadowDb(AGENTS_DIR);
			shadowProcess = spawn(binary, [], {
				env: { ...process.env, SIGNET_PORT: "3851", SIGNET_PATH: shadowAgentsDir },
				stdio: "ignore",
				windowsHide: true,
			});
			shadowProcess.unref();
			logger.info("shadow", "Rust daemon shadow started", {
				pid: shadowProcess.pid,
				port: 3851,
			});
		} else {
			logger.warn("shadow", "shadowEnabled but signet-daemon binary not found — skipping");
		}
	}

	if (memoryCfg.pipelineV2.procedural.enabled && !pipelinePaused) {
		skillReconcilerHandle = startReconciler({
			accessor: getDbAccessor(),
			pipelineConfig: memoryCfg.pipelineV2,
			embeddingConfig: memoryCfg.embedding,
			fetchEmbedding,
			getProvider: () => {
				try {
					return getLlmProvider();
				} catch {
					return null;
				}
			},
			agentsDir: AGENTS_DIR,
		});
	}

	invalidateDiagnosticsCache();
}

setRestartPipelineRuntime(restartPipelineRuntime);

// ============================================================================
// Shutdown
// ============================================================================

async function cleanup() {
	setShuttingDown(true);
	bindAbort.abort();
	logger.info("daemon", "Shutting down");

	if (httpServer) {
		const srv = httpServer;
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				logger.warn("daemon", "HTTP server drain timed out, forcing close");
				if ("closeAllConnections" in srv && typeof srv.closeAllConnections === "function") {
					srv.closeAllConnections();
				}
				resolve();
			}, 15_000);
			srv.close(() => {
				clearTimeout(timeout);
				resolve();
			});
		});
		httpServer = null;
	}

	if (syncTimer) {
		clearTimeout(syncTimer);
		syncTimer = null;
	}

	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
		setHeartbeatTimer(undefined);
	}
	if (checkpointPruneTimer) {
		clearInterval(checkpointPruneTimer);
		checkpointPruneTimer = undefined;
		setCheckpointPruneTimer(undefined);
	}
	if (telemetryRef) {
		try {
			await telemetryRef.stop();
		} catch {}
		telemetryRef = undefined;
		setTelemetryRef(undefined);
	}

	try {
		flushPendingCheckpoints();
	} catch {}

	await stopPipelineRuntime();

	try {
		const { shutdownNativeProvider } = await import("./native-embedding");
		await shutdownNativeProvider();
	} catch {}

	const released = releaseAllSessions();
	const cleared = clearAllPresence();
	if (released > 0 || cleared > 0) {
		logger.info("daemon", "Cleaned cross-agent state", { sessions: released, presence: cleared });
	}

	stopSessionCleanup();

	await stopGitSyncTimer();
	stopUpdateTimer();

	closeDbAccessor();

	if (watcher) {
		watcher.close();
	}

	if (existsSync(PID_FILE)) {
		try {
			unlinkSync(PID_FILE);
		} catch {}
	}
}

process.on("SIGINT", () => {
	cleanup().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
	cleanup().finally(() => process.exit(0));
});

process.on("uncaughtException", (err) => {
	logger.error("daemon", "Uncaught exception", err);
	cleanup().finally(() => process.exit(1));
});

// ============================================================================
// Main
// ============================================================================

async function main() {
	logger.info("daemon", "Signet Daemon starting");
	logger.info("daemon", "Agents directory", { path: AGENTS_DIR });
	logger.info("daemon", "Network configured", { port: PORT, host: HOST, bindHost: BIND_HOST });

	mkdirSync(DAEMON_DIR, { recursive: true });
	mkdirSync(LOG_DIR, { recursive: true });

	initDbAccessor(MEMORY_DB, { agentsDir: AGENTS_DIR });
	startSessionCleanup();

	syncAgentRoster(AGENTS_DIR);

	invalidateTraversalCache();

	writeFileSync(PID_FILE, process.pid.toString());
	logger.info("daemon", "Process ID", { pid: process.pid });

	try {
		migrateConfig(AGENTS_DIR);
	} catch (err) {
		logger.warn("config-migration", "Config migration failed; continuing startup", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	startFileWatcher();
	logger.info("watcher", "File watcher started");

	await ensureArchitectureDoc();

	const memoryCfg = loadMemoryConfig(AGENTS_DIR);
	let telemetryCollector: TelemetryCollector | undefined;
	if (memoryCfg.pipelineV2.telemetryEnabled) {
		let posthogApiKey = memoryCfg.pipelineV2.telemetry.posthogApiKey;
		if (!posthogApiKey) {
			try {
				posthogApiKey = await getSecret("POSTHOG_API_KEY");
			} catch {
				posthogApiKey = "";
			}
		}
		const resolvedTelemetryCfg = {
			...memoryCfg.pipelineV2.telemetry,
			posthogApiKey,
		};
		telemetryCollector = createTelemetryCollector(getDbAccessor(), resolvedTelemetryCfg, CURRENT_VERSION);
		telemetryCollector.start();
		telemetryRef = telemetryCollector;
		setTelemetryRef(telemetryCollector);

		const daemonStartTime = Date.now();
		heartbeatTimer = setInterval(
			() => {
				if (!telemetryRef) return;
				try {
					const liveCfg = loadMemoryConfig(AGENTS_DIR);
					const memoryCount = getDbAccessor().withReadDb((db) => {
						const row = db
							.prepare("SELECT COUNT(*) as cnt FROM memories WHERE is_deleted = 0 OR is_deleted IS NULL")
							.get() as { cnt: number } | undefined;
						return row?.cnt ?? 0;
					});
					const connectors = listConnectors(getDbAccessor());
					telemetryRef.record("daemon.heartbeat", {
						uptimeMs: Date.now() - daemonStartTime,
						memoryCount,
						connectorsActive: connectors.filter((cn) => cn.status === "active").length,
						pipelineMode: readPipelineMode(liveCfg.pipelineV2),
						extractionProvider: liveCfg.pipelineV2.extraction.provider,
						embeddingProvider: liveCfg.embedding.provider,
					});
				} catch {}
			},
			5 * 60 * 1000,
		);
		setHeartbeatTimer(heartbeatTimer);
	}

	await startPipelineRuntime(memoryCfg, telemetryCollector);

	initCheckpointFlush(getDbAccessor());

	schedulerHandle = startSchedulerWorker(getDbAccessor());

	checkpointPruneTimer = setInterval(() => {
		try {
			const cfg = loadMemoryConfig(AGENTS_DIR).pipelineV2.continuity;
			if (cfg.enabled) {
				pruneCheckpoints(getDbAccessor(), cfg.retentionDays);
			}
		} catch (err) {
			logger.warn("daemon", "Checkpoint pruning failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}, 3600_000);
	setCheckpointPruneTimer(checkpointPruneTimer);

	startGitSyncTimer();
	initUpdateSystem(CURRENT_VERSION, AGENTS_DIR, () => {
		const daemonScript = process.argv[1] ?? "";
		if (!daemonScript) {
			logger.warn("daemon", "Cannot self-restart: process.argv[1] is empty, falling back to clean exit");
			setTimeout(() => {
				process.exit(0);
			}, 500);
			return;
		}

		logger.info("daemon", "Spawning replacement daemon process", {
			execPath: process.execPath,
			script: daemonScript,
		});

		const replacement = spawn(process.execPath, [daemonScript], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			env: {
				...process.env,
				SIGNET_PORT: String(PORT),
				SIGNET_HOST: HOST,
				SIGNET_BIND: BIND_HOST,
				SIGNET_PATH: AGENTS_DIR,
			},
		});
		replacement.unref();

		logger.info("daemon", "Replacement daemon spawned, exiting current process");
		setTimeout(() => {
			process.exit(0);
		}, 500);
	});
	initFeatureFlags(AGENTS_DIR);
	startUpdateTimer();

	const REQUEST_BODY_LIMIT = 10 * 1_048_576;
	const { createServer: nodeCreateServer } = await import("node:http");
	const createBoundedServer: typeof nodeCreateServer = (...args: Parameters<typeof nodeCreateServer>) => {
		const server = nodeCreateServer(...args);
		server.on("request", (req, res) => {
			let bytes = 0;
			let aborted = false;
			req.on("data", (chunk: Buffer) => {
				if (aborted) return;
				bytes += chunk.length;
				if (bytes > REQUEST_BODY_LIMIT) {
					aborted = true;
					logger.warn("http", "Request body exceeded limit", { bytes, limit: REQUEST_BODY_LIMIT });
					if (!res.headersSent) {
						res.writeHead(413, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "payload too large" }), () => {
							req.socket?.destroy();
						});
					}
				}
			});
		});
		return server;
	};

	const BIND_MAX_DELAY_MS = 30_000;
	const BIND_RETRY_BASE_MS = 1000;

	const onListening = (info: { address: string; port: number }): void => {
		logger.info("daemon", "Server listening", {
			address: info.address,
			port: info.port,
		});
		logger.info("daemon", "Daemon ready");

		const healthStampPath = join(DAEMON_DIR, "last-healthy-start");
		try {
			let previousVersion: string | null = null;
			if (existsSync(healthStampPath)) {
				const prev = JSON.parse(readFileSync(healthStampPath, "utf-8"));
				previousVersion = typeof prev.version === "string" ? prev.version : null;
			}
			writeFileSync(
				healthStampPath,
				JSON.stringify({
					version: CURRENT_VERSION,
					startedAt: new Date().toISOString(),
					pid: process.pid,
				}),
			);
			if (previousVersion && previousVersion !== CURRENT_VERSION && CURRENT_VERSION !== "0.0.0") {
				logger.info("daemon", `Upgraded from ${previousVersion} to ${CURRENT_VERSION}`, {
					previousVersion,
					currentVersion: CURRENT_VERSION,
				});
				logger.info(
					"daemon",
					"What's new: knowledge graph, session continuity, constellation entity overlay, predictive scorer (opt-in)",
				);
			}
		} catch {}

		importExistingMemoryFiles().catch((e) => {
			const errDetails = e instanceof Error ? { message: e.message, stack: e.stack } : { error: String(e) };
			logger.error("daemon", "Failed to import existing memory files", undefined, errDetails);
		});

		const claudeProjectsDir = join(homedir(), ".claude", "projects");
		if (existsSync(claudeProjectsDir)) {
			syncExistingClaudeMemories(claudeProjectsDir);
		}
	};

	bindWithRetry({
		port: PORT,
		hostname: BIND_HOST,
		signal: bindAbort.signal,
		maxDelayMs: BIND_MAX_DELAY_MS,
		baseDelayMs: BIND_RETRY_BASE_MS,
		createServer: () =>
			createAdaptorServer({
				fetch: app.fetch,
				hostname: BIND_HOST,
				createServer: createBoundedServer,
			}),
		onBound: (server) => {
			httpServer = server;
		},
		onListening,
	});
}

if (import.meta.main) {
	main().catch((err) => {
		logger.error("daemon", "Fatal error", err);
		process.exit(1);
	});
}
