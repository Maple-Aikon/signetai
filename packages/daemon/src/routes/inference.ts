import {
	ROUTING_COST_TIERS,
	ROUTING_OPERATION_KINDS,
	ROUTING_PRIVACY_TIERS,
	type RouteRequest,
	parseRoutingTargetRef,
} from "@signet/core";
import type { Hono } from "hono";
import type { AuthMode } from "../auth/index.js";
import { checkScope } from "../auth/index.js";
import { getInferenceRouterOrNull } from "../inference-router.js";

const MAX_EXPLAIN_BYTES = 128 * 1024;
const MAX_EXECUTE_BYTES = 512 * 1024;
const MAX_GATEWAY_BYTES = 512 * 1024;
const MAX_PROMPT_CHARS = 200_000;
const MAX_PROMPT_PREVIEW_CHARS = 4_000;
const MAX_HINT_CHARS = 160;
const MAX_EXPLICIT_TARGETS = 8;
const MAX_EXPECTED_TOKENS = 10_000_000;
const MAX_LATENCY_BUDGET_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESPONSE_TOKENS = 100_000;
const MAX_GATEWAY_MESSAGES = 128;
const SAFE_HINT_PATTERN = /^[A-Za-z0-9._:/-]+$/;
const DEFAULT_AUTH_MODE: AuthMode = "local";

type ValidationResult<T> =
	| { readonly ok: true; readonly value: T }
	| {
			readonly ok: false;
			readonly status: number;
			readonly message: string;
			readonly details?: Record<string, unknown>;
	  };

export interface InferenceRouteOptions {
	readonly getAuthMode?: () => AuthMode;
}

interface ActiveInferenceRequest {
	readonly cancel: (reason?: string) => void;
}

const activeInferenceRequests = new Map<string, ActiveInferenceRequest>();
const SSE_KEEPALIVE_MS = 15_000;

function valid<T>(value: T): ValidationResult<T> {
	return { ok: true, value };
}

function invalid(message: string, status = 400, details?: Record<string, unknown>): ValidationResult<never> {
	return { ok: false, status, message, ...(details ? { details } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function parseHint(
	value: unknown,
	field: string,
	maxChars = MAX_HINT_CHARS,
	pattern = SAFE_HINT_PATTERN,
): ValidationResult<string | undefined> {
	if (value === undefined || value === null) return valid(undefined);
	if (typeof value !== "string") return invalid(`${field} must be a string`);
	const trimmed = value.trim();
	if (trimmed.length === 0) return valid(undefined);
	if (trimmed.length > maxChars) return invalid(`${field} exceeds ${maxChars} characters`, 413);
	if (!pattern.test(trimmed)) return invalid(`${field} contains unsupported characters`);
	return valid(trimmed);
}

function parseEnum<T extends readonly string[]>(
	value: unknown,
	field: string,
	allowed: T,
): ValidationResult<T[number] | undefined> {
	if (value === undefined || value === null) return valid(undefined);
	if (typeof value !== "string") return invalid(`${field} must be a string`);
	const trimmed = value.trim();
	if (trimmed.length === 0) return valid(undefined);
	return allowed.includes(trimmed) ? valid(trimmed) : invalid(`${field} must be one of: ${allowed.join(", ")}`);
}

function parseBoolean(value: unknown, field: string): ValidationResult<boolean | undefined> {
	if (value === undefined || value === null) return valid(undefined);
	if (typeof value !== "boolean") return invalid(`${field} must be a boolean`);
	return valid(value);
}

function parseBoundedNumber(value: unknown, field: string, max: number): ValidationResult<number | undefined> {
	if (value === undefined || value === null) return valid(undefined);
	if (typeof value !== "number" || !Number.isFinite(value)) return invalid(`${field} must be a finite number`);
	if (value < 0) return invalid(`${field} must be non-negative`);
	return valid(Math.min(Math.floor(value), max));
}

function parsePrompt(value: unknown): ValidationResult<string> {
	if (typeof value !== "string") return invalid("prompt is required");
	if (value.trim().length === 0) return invalid("prompt is required");
	if (value.length > MAX_PROMPT_CHARS) {
		return invalid(`prompt exceeds ${MAX_PROMPT_CHARS} characters`, 413);
	}
	return valid(value);
}

function parsePromptPreview(value: unknown): ValidationResult<string | undefined> {
	if (value === undefined || value === null) return valid(undefined);
	if (typeof value !== "string") return invalid("promptPreview must be a string");
	const trimmed = value.trim();
	return valid(trimmed.length > 0 ? trimmed.slice(0, MAX_PROMPT_PREVIEW_CHARS) : undefined);
}

function parseExplicitTargets(value: unknown): ValidationResult<readonly string[] | undefined> {
	if (value === undefined || value === null) return valid(undefined);
	if (!Array.isArray(value)) return invalid("explicitTargets must be an array of target refs");
	if (value.length > MAX_EXPLICIT_TARGETS) {
		return invalid(`explicitTargets may contain at most ${MAX_EXPLICIT_TARGETS} entries`);
	}
	const refs: string[] = [];
	for (const entry of value) {
		const parsed = parseHint(entry, "explicitTargets entry");
		if (!parsed.ok) return parsed;
		if (!parsed.value) continue;
		const targetRef = parseRoutingTargetRef(parsed.value);
		if (!targetRef.ok) return invalid(`invalid explicit target ref '${parsed.value}'`);
		if (!refs.includes(parsed.value)) refs.push(parsed.value);
	}
	return valid(refs.length > 0 ? refs : undefined);
}

async function readJsonObject(
	c: { req: { header: (name: string) => string | undefined; text: () => Promise<string> } },
	maxBytes: number,
): Promise<ValidationResult<Record<string, unknown>>> {
	const contentLength = parseTrimmedString(c.req.header("content-length"));
	if (contentLength) {
		const bytes = Number(contentLength);
		if (Number.isFinite(bytes) && bytes > maxBytes) {
			return invalid(`payload exceeds ${maxBytes} byte limit`, 413);
		}
	}

	const raw = await c.req.text().catch(() => null);
	if (raw === null) return invalid("invalid request body");
	if (Buffer.byteLength(raw, "utf8") > maxBytes) {
		return invalid(`payload exceeds ${maxBytes} byte limit`, 413);
	}
	if (raw.trim().length === 0) return valid({});

	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return invalid("request body must be valid JSON");
	}
	if (!isRecord(value)) return invalid("request body must be a JSON object");
	return valid(value);
}

function buildRouteRequest(body: Readonly<Record<string, unknown>>): ValidationResult<RouteRequest> {
	const agentId = parseHint(body.agentId, "agentId");
	if (!agentId.ok) return agentId;
	const taskClass = parseHint(body.taskClass, "taskClass");
	if (!taskClass.ok) return taskClass;
	const explicitPolicy = parseHint(body.explicitPolicy, "explicitPolicy");
	if (!explicitPolicy.ok) return explicitPolicy;
	const explicitTargets = parseExplicitTargets(body.explicitTargets);
	if (!explicitTargets.ok) return explicitTargets;
	const operation = parseEnum(body.operation, "operation", ROUTING_OPERATION_KINDS);
	if (!operation.ok) return operation;
	const privacy = parseEnum(body.privacy, "privacy", ROUTING_PRIVACY_TIERS);
	if (!privacy.ok) return privacy;
	const costCeiling = parseEnum(body.costCeiling, "costCeiling", ROUTING_COST_TIERS);
	if (!costCeiling.ok) return costCeiling;
	const requireTools = parseBoolean(body.requireTools, "requireTools");
	if (!requireTools.ok) return requireTools;
	const requireStreaming = parseBoolean(body.requireStreaming, "requireStreaming");
	if (!requireStreaming.ok) return requireStreaming;
	const requireMultimodal = parseBoolean(body.requireMultimodal, "requireMultimodal");
	if (!requireMultimodal.ok) return requireMultimodal;
	const expectedInputTokens = parseBoundedNumber(body.expectedInputTokens, "expectedInputTokens", MAX_EXPECTED_TOKENS);
	if (!expectedInputTokens.ok) return expectedInputTokens;
	const expectedOutputTokens = parseBoundedNumber(
		body.expectedOutputTokens,
		"expectedOutputTokens",
		MAX_EXPECTED_TOKENS,
	);
	if (!expectedOutputTokens.ok) return expectedOutputTokens;
	const latencyBudgetMs = parseBoundedNumber(body.latencyBudgetMs, "latencyBudgetMs", MAX_LATENCY_BUDGET_MS);
	if (!latencyBudgetMs.ok) return latencyBudgetMs;
	const promptPreview = parsePromptPreview(body.promptPreview);
	if (!promptPreview.ok) return promptPreview;

	return valid({
		agentId: agentId.value,
		operation: operation.value ?? "interactive",
		taskClass: taskClass.value,
		explicitPolicy: explicitPolicy.value,
		explicitTargets: explicitTargets.value,
		requireTools: requireTools.value,
		requireStreaming: requireStreaming.value,
		requireMultimodal: requireMultimodal.value,
		expectedInputTokens: expectedInputTokens.value,
		expectedOutputTokens: expectedOutputTokens.value,
		privacy: privacy.value,
		latencyBudgetMs: latencyBudgetMs.value,
		costCeiling: costCeiling.value,
		promptPreview: promptPreview.value,
	});
}

function applyScopedAgent(
	authMode: AuthMode,
	auth:
		| { readonly claims: { readonly role?: string; readonly scope?: { readonly agent?: string } } | null }
		| undefined,
	request: RouteRequest,
): ValidationResult<RouteRequest> {
	if (authMode === "local" || (authMode === "hybrid" && !auth?.claims)) {
		return valid(request);
	}
	if (auth?.claims?.role === "admin") {
		return valid(request);
	}
	const scopedAgentId = parseTrimmedString(auth?.claims?.scope?.agent);
	if (request.agentId) {
		const decision = checkScope(auth?.claims ?? null, { agent: request.agentId }, authMode);
		if (!decision.allowed) return invalid(decision.reason ?? "scope violation", 403);
	}
	return valid({
		...request,
		agentId: request.agentId ?? scopedAgentId,
	});
}

function parseGatewayModelAlias(
	router: ReturnType<typeof getInferenceRouterOrNull>,
	model: unknown,
): ValidationResult<Pick<RouteRequest, "explicitPolicy" | "explicitTargets">> {
	const parsedModel = parseHint(model, "model");
	if (!parsedModel.ok) return parsedModel;
	const trimmed = parsedModel.value;
	if (!trimmed) return valid({});
	if (!router) return valid({});
	if (trimmed.startsWith("policy:") && trimmed.slice("policy:".length).trim().length === 0) {
		return invalid("model policy alias must include a policy id");
	}
	const parsed = router.parseGatewayModel(trimmed);
	const explicitPolicy = parseHint(parsed.explicitPolicy, "model");
	if (!explicitPolicy.ok) return explicitPolicy;
	const explicitTargets = parseExplicitTargets(parsed.explicitTargets);
	if (!explicitTargets.ok) return explicitTargets;
	return valid({
		explicitPolicy: explicitPolicy.value,
		explicitTargets: explicitTargets.value,
	});
}

function buildGatewayRouteRequest(
	c: { req: { header: (name: string) => string | undefined } },
	router: ReturnType<typeof getInferenceRouterOrNull>,
	model: unknown,
): ValidationResult<Partial<RouteRequest>> {
	const agentId = parseHint(c.req.header("x-signet-agent-id"), "x-signet-agent-id");
	if (!agentId.ok) return agentId;
	const taskClass = parseHint(c.req.header("x-signet-task-class"), "x-signet-task-class");
	if (!taskClass.ok) return taskClass;
	const privacy = parseEnum(c.req.header("x-signet-privacy-tier"), "x-signet-privacy-tier", ROUTING_PRIVACY_TIERS);
	if (!privacy.ok) return privacy;
	const operation = parseEnum(c.req.header("x-signet-operation"), "x-signet-operation", ROUTING_OPERATION_KINDS);
	if (!operation.ok) return operation;
	const explicitPolicy = parseHint(c.req.header("x-signet-route-policy"), "x-signet-route-policy");
	if (!explicitPolicy.ok) return explicitPolicy;
	const headerTarget = c.req.header("x-signet-explicit-target");
	const explicitTargets =
		headerTarget === undefined ? valid<readonly string[] | undefined>(undefined) : parseExplicitTargets([headerTarget]);
	if (!explicitTargets.ok) return explicitTargets;
	const alias = parseGatewayModelAlias(router, model);
	if (!alias.ok) return alias;
	return valid({
		agentId: agentId.value,
		taskClass: taskClass.value,
		privacy: privacy.value,
		operation: operation.value ?? "interactive",
		explicitPolicy: explicitPolicy.value ?? alias.value.explicitPolicy,
		explicitTargets: explicitTargets.value ?? alias.value.explicitTargets,
	});
}

function parseGatewayMessages(
	value: unknown,
): ValidationResult<readonly Array<{ readonly role: string; readonly content: string }>> {
	if (!Array.isArray(value) || value.length === 0) {
		return invalid("messages are required");
	}
	if (value.length > MAX_GATEWAY_MESSAGES) {
		return invalid(`messages may contain at most ${MAX_GATEWAY_MESSAGES} entries`);
	}
	let totalChars = 0;
	const messages = value.flatMap((message) => {
		if (!isRecord(message)) return [];
		const content = typeof message.content === "string" ? message.content : "";
		if (content.trim().length === 0) return [];
		totalChars += content.length;
		if (totalChars > MAX_PROMPT_CHARS) return [];
		return [
			{
				role: typeof message.role === "string" && message.role.trim().length > 0 ? message.role.trim() : "user",
				content,
			},
		];
	});
	if (totalChars > MAX_PROMPT_CHARS) {
		return invalid(`messages exceed ${MAX_PROMPT_CHARS} characters`, 413);
	}
	if (messages.length === 0) {
		return invalid("messages must contain string content");
	}
	return valid(messages);
}

function getAuthMode(opts: InferenceRouteOptions): AuthMode {
	return opts.getAuthMode?.() ?? DEFAULT_AUTH_MODE;
}

function registerActiveInferenceRequest(requestId: string, cancel: (reason?: string) => void): () => void {
	activeInferenceRequests.set(requestId, { cancel });
	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeInferenceRequests.delete(requestId);
	};
}

function sseFrame(payload: string, event?: string): Uint8Array {
	const prefix = event ? `event: ${event}\n` : "";
	return new TextEncoder().encode(`${prefix}data: ${payload}\n\n`);
}

function buildUsagePayload(
	usage:
		| {
				readonly inputTokens: number | null;
				readonly outputTokens: number | null;
		  }
		| null
		| undefined,
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined {
	if (!usage) return undefined;
	return {
		prompt_tokens: usage.inputTokens ?? 0,
		completion_tokens: usage.outputTokens ?? 0,
		total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
	};
}

export function mountInferenceRoutes(app: Hono, opts: InferenceRouteOptions = {}): void {
	app.get("/api/inference/status", async (c) => {
		const router = getInferenceRouterOrNull();
		if (!router) return c.json({ error: "inference router not initialized" }, 503);
		const result = await router.status(c.req.query("refresh") === "1");
		if (!result.ok) return c.json({ error: result.error.message, details: result.error.details ?? null }, 400);
		return c.json(result.value);
	});

	app.post("/api/inference/explain", async (c) => {
		const router = getInferenceRouterOrNull();
		if (!router) return c.json({ error: "inference router not initialized" }, 503);
		const body = await readJsonObject(c, MAX_EXPLAIN_BYTES);
		if (!body.ok) return c.json({ error: body.message, details: body.details ?? null }, body.status);
		const request = buildRouteRequest(body.value);
		if (!request.ok) return c.json({ error: request.message, details: request.details ?? null }, request.status);
		const scoped = applyScopedAgent(getAuthMode(opts), c.get("auth"), request.value);
		if (!scoped.ok) return c.json({ error: scoped.message, details: scoped.details ?? null }, scoped.status);
		const refresh = parseBoolean(body.value.refresh, "refresh");
		if (!refresh.ok) return c.json({ error: refresh.message, details: refresh.details ?? null }, refresh.status);
		const result = await router.explain(scoped.value, refresh.value === true);
		if (!result.ok) return c.json({ error: result.error.message, details: result.error.details ?? null }, 400);
		return c.json(result.value);
	});

	app.post("/api/inference/execute", async (c) => {
		const router = getInferenceRouterOrNull();
		if (!router) return c.json({ error: "inference router not initialized" }, 503);
		const body = await readJsonObject(c, MAX_EXECUTE_BYTES);
		if (!body.ok) return c.json({ error: body.message, details: body.details ?? null }, body.status);
		const prompt = parsePrompt(body.value.prompt);
		if (!prompt.ok) return c.json({ error: prompt.message, details: prompt.details ?? null }, prompt.status);
		const request = buildRouteRequest({
			...body.value,
			promptPreview: body.value.promptPreview ?? prompt.value,
		});
		if (!request.ok) return c.json({ error: request.message, details: request.details ?? null }, request.status);
		const scoped = applyScopedAgent(getAuthMode(opts), c.get("auth"), request.value);
		if (!scoped.ok) return c.json({ error: scoped.message, details: scoped.details ?? null }, scoped.status);
		const timeoutMs = parseBoundedNumber(body.value.timeoutMs, "timeoutMs", MAX_TIMEOUT_MS);
		if (!timeoutMs.ok)
			return c.json({ error: timeoutMs.message, details: timeoutMs.details ?? null }, timeoutMs.status);
		const maxTokens = parseBoundedNumber(body.value.maxTokens, "maxTokens", MAX_RESPONSE_TOKENS);
		if (!maxTokens.ok)
			return c.json({ error: maxTokens.message, details: maxTokens.details ?? null }, maxTokens.status);
		const refresh = parseBoolean(body.value.refresh, "refresh");
		if (!refresh.ok) return c.json({ error: refresh.message, details: refresh.details ?? null }, refresh.status);
		const result = await router.execute(scoped.value, prompt.value, {
			timeoutMs: timeoutMs.value,
			maxTokens: maxTokens.value,
			refresh: refresh.value === true,
		});
		if (!result.ok) {
			return c.json({ error: result.error.message, details: result.error.details ?? null }, 502);
		}
		return c.json(result.value);
	});

	app.post("/api/inference/stream", async (c) => {
		const router = getInferenceRouterOrNull();
		if (!router) return c.json({ error: "inference router not initialized" }, 503);
		const body = await readJsonObject(c, MAX_EXECUTE_BYTES);
		if (!body.ok) return c.json({ error: body.message, details: body.details ?? null }, body.status);
		const prompt = parsePrompt(body.value.prompt);
		if (!prompt.ok) return c.json({ error: prompt.message, details: prompt.details ?? null }, prompt.status);
		const request = buildRouteRequest({
			...body.value,
			promptPreview: body.value.promptPreview ?? prompt.value,
			requireStreaming: true,
		});
		if (!request.ok) return c.json({ error: request.message, details: request.details ?? null }, request.status);
		const scoped = applyScopedAgent(getAuthMode(opts), c.get("auth"), request.value);
		if (!scoped.ok) return c.json({ error: scoped.message, details: scoped.details ?? null }, scoped.status);
		const timeoutMs = parseBoundedNumber(body.value.timeoutMs, "timeoutMs", MAX_TIMEOUT_MS);
		if (!timeoutMs.ok)
			return c.json({ error: timeoutMs.message, details: timeoutMs.details ?? null }, timeoutMs.status);
		const maxTokens = parseBoundedNumber(body.value.maxTokens, "maxTokens", MAX_RESPONSE_TOKENS);
		if (!maxTokens.ok)
			return c.json({ error: maxTokens.message, details: maxTokens.details ?? null }, maxTokens.status);
		const refresh = parseBoolean(body.value.refresh, "refresh");
		if (!refresh.ok) return c.json({ error: refresh.message, details: refresh.details ?? null }, refresh.status);

		const result = await router.stream(scoped.value, prompt.value, {
			timeoutMs: timeoutMs.value,
			maxTokens: maxTokens.value,
			refresh: refresh.value === true,
			abortSignal: c.req.raw.signal,
		});
		if (!result.ok) {
			return c.json({ error: result.error.message, details: result.error.details ?? null }, 502);
		}

		const requestId = crypto.randomUUID();
		const release = registerActiveInferenceRequest(requestId, result.value.cancel);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				let closed = false;
				const reader = result.value.stream.getReader();
				const close = () => {
					if (closed) return;
					closed = true;
					release();
					try {
						controller.close();
					} catch {}
				};

				const write = (event: string, payload: unknown) => {
					if (closed) return;
					try {
						controller.enqueue(sseFrame(JSON.stringify(payload), event));
					} catch {
						result.value.cancel("native stream write failure");
						close();
					}
				};

				write("meta", {
					requestId,
					decision: result.value.decision,
				});

				const keepAlive = setInterval(() => {
					if (closed) return;
					try {
						controller.enqueue(sseFrame(JSON.stringify({ requestId, keepalive: true }), "keepalive"));
					} catch {
						result.value.cancel("native stream keepalive failure");
						close();
					}
				}, SSE_KEEPALIVE_MS);

				const cleanup = () => {
					clearInterval(keepAlive);
					reader.releaseLock();
					close();
				};

				const pump = async () => {
					try {
						while (true) {
							const next = await reader.read();
							if (next.done) {
								cleanup();
								return;
							}
							const event = next.value;
							switch (event.type) {
								case "delta":
									write("delta", { requestId, text: event.text });
									break;
								case "done":
									write("done", {
										requestId,
										text: event.text,
										usage: buildUsagePayload(event.usage),
										decision: event.decision,
										attempts: event.attempts,
									});
									cleanup();
									return;
								case "cancelled":
									write("cancelled", {
										requestId,
										partialText: event.partialText,
										decision: event.decision,
										attempts: event.attempts,
									});
									cleanup();
									return;
								case "error":
									write("error", {
										requestId,
										error: event.error,
										partialText: event.partialText,
										decision: event.decision,
										attempts: event.attempts,
									});
									cleanup();
									return;
							}
						}
					} catch {
						result.value.cancel("native stream reader failure");
						cleanup();
					}
				};

				void pump();
				c.req.raw.signal.addEventListener(
					"abort",
					() => {
						result.value.cancel("client disconnected");
						cleanup();
					},
					{ once: true },
				);
			},
			cancel(reason) {
				release();
				result.value.cancel(typeof reason === "string" ? reason : "native stream cancelled");
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"x-signet-request-id": requestId,
			},
		});
	});

	app.delete("/api/inference/requests/:id", (c) => {
		const requestId = c.req.param("id");
		const active = activeInferenceRequests.get(requestId);
		if (!active) {
			return c.json({ error: "inference request not found" }, 404);
		}
		active.cancel("cancelled by api");
		activeInferenceRequests.delete(requestId);
		return c.json({ ok: true, requestId });
	});

	app.get("/v1/models", async (c) => {
		const router = getInferenceRouterOrNull();
		if (!router) return c.json({ error: { message: "inference router not initialized" } }, 503);
		const models = await router.gatewayModels(c.req.query("refresh") === "1");
		if (!models.ok) return c.json({ error: { message: models.error.message } }, 400);
		return c.json({
			object: "list",
			data: models.value.map((id) => ({ id, object: "model", owned_by: "signet" })),
		});
	});

	app.post("/v1/chat/completions", async (c) => {
		const router = getInferenceRouterOrNull();
		if (!router) return c.json({ error: { message: "inference router not initialized" } }, 503);
		const body = await readJsonObject(c, MAX_GATEWAY_BYTES);
		if (!body.ok) return c.json({ error: { message: body.message, details: body.details ?? null } }, body.status);
		const stream = parseBoolean(body.value.stream, "stream");
		if (!stream.ok)
			return c.json({ error: { message: stream.message, details: stream.details ?? null } }, stream.status);
		const messages = parseGatewayMessages(body.value.messages);
		if (!messages.ok)
			return c.json({ error: { message: messages.message, details: messages.details ?? null } }, messages.status);
		const routeBase = buildGatewayRouteRequest(c, router, body.value.model);
		if (!routeBase.ok)
			return c.json({ error: { message: routeBase.message, details: routeBase.details ?? null } }, routeBase.status);
		const routeRequest = buildRouteRequest({
			...routeBase.value,
			promptPreview: messages.value[messages.value.length - 1]?.content,
			requireStreaming: false,
		});
		if (!routeRequest.ok) {
			return c.json(
				{ error: { message: routeRequest.message, details: routeRequest.details ?? null } },
				routeRequest.status,
			);
		}
		const scoped = applyScopedAgent(getAuthMode(opts), c.get("auth"), routeRequest.value);
		if (!scoped.ok)
			return c.json({ error: { message: scoped.message, details: scoped.details ?? null } }, scoped.status);
		const maxTokens = parseBoundedNumber(body.value.max_tokens, "max_tokens", MAX_RESPONSE_TOKENS);
		if (!maxTokens.ok)
			return c.json({ error: { message: maxTokens.message, details: maxTokens.details ?? null } }, maxTokens.status);
		const prompt = router.buildGatewayPrompt(messages.value);
		if (stream.value === true) {
			const streaming = await router.stream(
				{
					...scoped.value,
					requireStreaming: true,
				},
				prompt,
				{
					maxTokens: maxTokens.value,
					abortSignal: c.req.raw.signal,
				},
			);
			if (!streaming.ok) {
				return c.json({ error: { message: streaming.error.message, details: streaming.error.details ?? null } }, 502);
			}

			const requestId = `chatcmpl_${crypto.randomUUID()}`;
			const created = Math.floor(Date.now() / 1000);
			const release = registerActiveInferenceRequest(requestId, streaming.value.cancel);
			const streamResponse = new ReadableStream<Uint8Array>({
				start(controller) {
					let closed = false;
					let sentRole = false;
					const reader = streaming.value.stream.getReader();

					const writeChunk = (payload: Record<string, unknown>) => {
						if (closed) return;
						try {
							controller.enqueue(sseFrame(JSON.stringify(payload)));
						} catch {
							streaming.value.cancel("gateway stream write failure");
							close();
						}
					};

					const close = () => {
						if (closed) return;
						closed = true;
						release();
						try {
							controller.enqueue(sseFrame("[DONE]"));
						} catch {}
						try {
							controller.close();
						} catch {}
					};

					writeChunk({
						id: requestId,
						object: "chat.completion.chunk",
						created,
						model: streaming.value.decision.targetRef,
						choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
					});
					sentRole = true;

					const pump = async () => {
						try {
							while (true) {
								const next = await reader.read();
								if (next.done) {
									close();
									return;
								}
								const event = next.value;
								switch (event.type) {
									case "delta":
										writeChunk({
											id: requestId,
											object: "chat.completion.chunk",
											created,
											model: streaming.value.decision.targetRef,
											choices: [
												{
													index: 0,
													delta: sentRole ? { content: event.text } : { role: "assistant", content: event.text },
													finish_reason: null,
												},
											],
										});
										sentRole = true;
										break;
									case "done":
										writeChunk({
											id: requestId,
											object: "chat.completion.chunk",
											created,
											model: event.decision.targetRef,
											choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
											usage: buildUsagePayload(event.usage),
											signet: {
												decision: event.decision,
												attempts: event.attempts,
											},
										});
										close();
										return;
									case "cancelled":
										writeChunk({
											id: requestId,
											object: "chat.completion.chunk",
											created,
											model: event.decision.targetRef,
											choices: [{ index: 0, delta: {}, finish_reason: "cancelled" }],
											signet: {
												decision: event.decision,
												attempts: event.attempts,
												partialText: event.partialText,
											},
										});
										close();
										return;
									case "error":
										writeChunk({
											id: requestId,
											object: "chat.completion.chunk",
											created,
											model: event.decision.targetRef,
											choices: [{ index: 0, delta: {}, finish_reason: "error" }],
											signet: {
												error: event.error,
												decision: event.decision,
												attempts: event.attempts,
												partialText: event.partialText,
											},
										});
										close();
										return;
								}
							}
						} catch {
							streaming.value.cancel("gateway stream reader failure");
							close();
						}
					};

					void pump();
					c.req.raw.signal.addEventListener(
						"abort",
						() => {
							streaming.value.cancel("client disconnected");
							close();
						},
						{ once: true },
					);
				},
				cancel(reason) {
					release();
					streaming.value.cancel(typeof reason === "string" ? reason : "gateway stream cancelled");
				},
			});

			return new Response(streamResponse, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"x-signet-request-id": requestId,
				},
			});
		}

		const result = await router.execute(scoped.value, prompt, {
			maxTokens: maxTokens.value,
		});
		if (!result.ok) {
			return c.json({ error: { message: result.error.message, details: result.error.details ?? null } }, 502);
		}
		return c.json({
			id: `chatcmpl_${Date.now()}`,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: result.value.decision.targetRef,
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: result.value.text },
					finish_reason: "stop",
				},
			],
			usage: result.value.usage
				? {
						prompt_tokens: result.value.usage.inputTokens ?? 0,
						completion_tokens: result.value.usage.outputTokens ?? 0,
						total_tokens: (result.value.usage.inputTokens ?? 0) + (result.value.usage.outputTokens ?? 0),
					}
				: undefined,
			signet: {
				decision: result.value.decision,
				attempts: result.value.attempts,
			},
		});
	});
}
