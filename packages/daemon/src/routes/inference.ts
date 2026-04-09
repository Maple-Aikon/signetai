import type { RouteRequest, RoutingOperationKind, RoutingPrivacyTier } from "@signet/core";
import type { Hono } from "hono";
import { getInferenceRouterOrNull } from "../inference-router.js";

interface ExplainRequest extends Partial<RouteRequest> {
	readonly refresh?: boolean;
}

interface ExecuteRequest extends Partial<RouteRequest> {
	readonly prompt?: string;
	readonly timeoutMs?: number;
	readonly maxTokens?: number;
	readonly refresh?: boolean;
}

interface OpenAiChatMessage {
	readonly role?: string;
	readonly content?: string;
}

interface OpenAiChatCompletionRequest {
	readonly model?: string;
	readonly messages?: readonly OpenAiChatMessage[];
	readonly stream?: boolean;
	readonly max_tokens?: number;
}

function parseOperation(value: unknown): RoutingOperationKind | undefined {
	return typeof value === "string" ? (value as RoutingOperationKind) : undefined;
}

function parsePrivacy(value: unknown): RoutingPrivacyTier | undefined {
	return typeof value === "string" ? (value as RoutingPrivacyTier) : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function parseNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function buildRouteRequest(body: Partial<RouteRequest>): RouteRequest {
	return {
		agentId: parseString(body.agentId),
		operation: parseOperation(body.operation) ?? "interactive",
		taskClass: parseString(body.taskClass),
		explicitPolicy: parseString(body.explicitPolicy),
		explicitTargets: Array.isArray(body.explicitTargets)
			? body.explicitTargets.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			: undefined,
		requireTools: parseBoolean(body.requireTools),
		requireStreaming: parseBoolean(body.requireStreaming),
		requireMultimodal: parseBoolean(body.requireMultimodal),
		expectedInputTokens: parseNumber(body.expectedInputTokens),
		expectedOutputTokens: parseNumber(body.expectedOutputTokens),
		privacy: parsePrivacy(body.privacy),
		latencyBudgetMs: parseNumber(body.latencyBudgetMs),
		costCeiling: typeof body.costCeiling === "string" ? body.costCeiling : undefined,
		promptPreview: parseString(body.promptPreview),
	};
}

function buildGatewayRouteRequest(
	c: { req: { header: (name: string) => string | undefined } },
	model: string | undefined,
): Partial<RouteRequest> {
	const router = getInferenceRouterOrNull();
	return {
		agentId: c.req.header("x-signet-agent-id")?.trim() || undefined,
		taskClass: c.req.header("x-signet-task-class")?.trim() || undefined,
		privacy: parsePrivacy(c.req.header("x-signet-privacy-tier")),
		operation: parseOperation(c.req.header("x-signet-operation")) ?? "interactive",
		explicitPolicy: c.req.header("x-signet-route-policy")?.trim() || router?.parseGatewayModel(model).explicitPolicy,
		explicitTargets: c.req.header("x-signet-explicit-target")?.trim()
			? [c.req.header("x-signet-explicit-target") as string]
			: router?.parseGatewayModel(model).explicitTargets,
	};
}

export function mountInferenceRoutes(app: Hono): void {
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
		const body = (await c.req.json().catch(() => ({}))) as ExplainRequest;
		const result = await router.explain(buildRouteRequest(body), body.refresh === true);
		if (!result.ok) return c.json({ error: result.error.message, details: result.error.details ?? null }, 400);
		return c.json(result.value);
	});

	app.post("/api/inference/execute", async (c) => {
		const router = getInferenceRouterOrNull();
		if (!router) return c.json({ error: "inference router not initialized" }, 503);
		const body = (await c.req.json().catch(() => ({}))) as ExecuteRequest;
		const prompt = parseString(body.prompt);
		if (!prompt) return c.json({ error: "prompt is required" }, 400);
		const request = buildRouteRequest({
			...body,
			promptPreview: body.promptPreview ?? prompt,
		});
		const result = await router.execute(request, prompt, {
			timeoutMs: parseNumber(body.timeoutMs),
			maxTokens: parseNumber(body.maxTokens),
			refresh: body.refresh === true,
		});
		if (!result.ok) {
			return c.json({ error: result.error.message, details: result.error.details ?? null }, 502);
		}
		return c.json(result.value);
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
		const body = (await c.req.json().catch(() => ({}))) as OpenAiChatCompletionRequest;
		if (body.stream === true) {
			return c.json({ error: { message: "streaming is not yet supported by the Signet gateway" } }, 501);
		}
		if (!Array.isArray(body.messages) || body.messages.length === 0) {
			return c.json({ error: { message: "messages are required" } }, 400);
		}
		const messages = body.messages.flatMap((message) => {
			const role = typeof message.role === "string" ? message.role : "user";
			const content = typeof message.content === "string" ? message.content : "";
			return content.trim().length > 0 ? [{ role, content }] : [];
		});
		if (messages.length === 0) {
			return c.json({ error: { message: "messages must contain string content" } }, 400);
		}
		const routeRequest = buildRouteRequest({
			...buildGatewayRouteRequest(c, body.model),
			promptPreview: messages[messages.length - 1]?.content,
			requireStreaming: false,
		});
		const prompt = router.buildGatewayPrompt(messages);
		const result = await router.execute(routeRequest, prompt, {
			maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
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
