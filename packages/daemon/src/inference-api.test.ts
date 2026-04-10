import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
	AuthRateLimiter,
	createAuthMiddleware,
	createToken,
	parseAuthConfig,
	requirePermission,
	requireRateLimit,
} from "./auth";
import { getOrCreateInferenceRouter, resetInferenceRouterForTests } from "./inference-router";
import { mountInferenceRoutes } from "./routes/inference";

let app: {
	request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};
let dir = "";
let prev: string | undefined;

function writeRoutingFixture(root: string): void {
	mkdirSync(join(root, "memory"), { recursive: true });
	writeFileSync(
		join(root, "agent.yaml"),
		`memory:
  pipelineV2:
    extraction:
      provider: none
routing:
  defaultPolicy: auto
  targets:
    remote:
      executor: openrouter
      endpoint: https://openrouter.ai/api/v1
      models:
        sonnet:
          model: anthropic/claude-sonnet-4-6
          reasoning: medium
          toolUse: true
          streaming: true
    local:
      executor: ollama
      endpoint: http://127.0.0.1:11434
      models:
        gemma:
          model: gemma4
          reasoning: medium
          streaming: true
  policies:
    auto:
      mode: automatic
      defaultTargets:
        - remote/sonnet
        - local/gemma
  taskClasses:
    casual_chat:
      preferredTargets:
        - local/gemma
  agents:
    rose:
      defaultPolicy: auto
      roster:
        - local/gemma
  workloads:
    interactive:
      policy: auto
      taskClass: casual_chat
`,
	);
}

function writeStreamingRoutingFixture(root: string, endpoint: string): void {
	mkdirSync(join(root, "memory"), { recursive: true });
	writeFileSync(
		join(root, "agent.yaml"),
		`memory:
  pipelineV2:
    extraction:
      provider: none
routing:
  defaultPolicy: auto
  targets:
    fake:
      executor: openai-compatible
      endpoint: ${endpoint}
      models:
        stream:
          model: fake-stream
          reasoning: medium
          streaming: true
  policies:
    auto:
      mode: automatic
      defaultTargets:
        - fake/stream
  workloads:
    interactive:
      policy: auto
`,
	);
}

interface FakeOpenAiServer {
	readonly url: string;
	stop(): void;
}

function startFakeOpenAiServer(mode: "success" | "error"): FakeOpenAiServer {
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/models") {
				return Response.json({
					object: "list",
					data: [{ id: "fake-stream", object: "model" }],
				});
			}

			if (url.pathname === "/chat/completions") {
				return req.json().then((body: unknown) => {
					const payload = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
					if (payload.stream === true) {
						const encoder = new TextEncoder();
						const stream = new ReadableStream<Uint8Array>({
							start(controller) {
								let closed = false;
								const safeClose = () => {
									if (closed) return;
									closed = true;
									controller.close();
								};
								const safeError = (error: Error) => {
									if (closed) return;
									closed = true;
									controller.error(error);
								};
								const safeEnqueue = (text: string) => {
									if (closed) return;
									try {
										controller.enqueue(encoder.encode(text));
									} catch {
										closed = true;
									}
								};
								safeEnqueue(
									`data: ${JSON.stringify({
										id: "fake-stream",
										object: "chat.completion.chunk",
										choices: [{ index: 0, delta: { content: "hel" }, finish_reason: null }],
									})}\n\n`,
								);
								setTimeout(() => {
									if (mode === "error") {
										safeClose();
										return;
									}
									safeEnqueue(
										`data: ${JSON.stringify({
											id: "fake-stream",
											object: "chat.completion.chunk",
											choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }],
										})}\n\n`,
									);
									safeEnqueue(
										`data: ${JSON.stringify({
											id: "fake-stream",
											object: "chat.completion.chunk",
											choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
											usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
										})}\n\n`,
									);
									safeEnqueue("data: [DONE]\n\n");
									safeClose();
								}, 20);
							},
						});
						return new Response(stream, {
							headers: {
								"content-type": "text/event-stream",
							},
						});
					}

					return Response.json({
						id: "fake-completion",
						object: "chat.completion",
						choices: [{ message: { content: "hello" } }],
						usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
					});
				});
			}

			return new Response("not found", { status: 404 });
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}`,
		stop() {
			server.stop(true);
		},
	};
}

function createInferenceTestApp(
	root: string,
	opts?: {
		readonly enforceDaemonPermissions?: boolean;
		readonly inferenceExplainMax?: number;
		readonly inferenceExecuteMax?: number;
		readonly inferenceGatewayMax?: number;
	},
): {
	readonly app: Hono;
	readonly secret: Buffer;
} {
	resetInferenceRouterForTests();
	getOrCreateInferenceRouter(root);

	const cfg = parseAuthConfig(
		{
			mode: "team",
			rateLimits: {
				inferenceExplain: { windowMs: 60_000, max: opts?.inferenceExplainMax ?? 120 },
				inferenceExecute: { windowMs: 60_000, max: opts?.inferenceExecuteMax ?? 20 },
				inferenceGateway: { windowMs: 60_000, max: opts?.inferenceGatewayMax ?? 30 },
			},
		},
		root,
	);
	const secret = Buffer.alloc(32, 7);
	const app = new Hono();
	app.use("*", createAuthMiddleware(cfg, secret));

	if (opts?.enforceDaemonPermissions !== false) {
		const explainLimiter = new AuthRateLimiter(
			cfg.rateLimits.inferenceExplain.windowMs,
			cfg.rateLimits.inferenceExplain.max,
		);
		const executeLimiter = new AuthRateLimiter(
			cfg.rateLimits.inferenceExecute.windowMs,
			cfg.rateLimits.inferenceExecute.max,
		);
		const gatewayLimiter = new AuthRateLimiter(
			cfg.rateLimits.inferenceGateway.windowMs,
			cfg.rateLimits.inferenceGateway.max,
		);
		app.use("/api/inference", async (c, next) => {
			if (c.req.method === "GET") {
				return requirePermission("diagnostics", cfg)(c, next);
			}
			return requirePermission("admin", cfg)(c, next);
		});
		app.use("/api/inference/*", async (c, next) => {
			if (c.req.method === "GET") {
				return requirePermission("diagnostics", cfg)(c, next);
			}
			return requirePermission("admin", cfg)(c, next);
		});
		app.use("/v1/*", async (c, next) => requirePermission("admin", cfg)(c, next));
		app.use("/api/inference/explain", async (c, next) => {
			if (c.req.method !== "POST") return next();
			return requireRateLimit("inferenceExplain", explainLimiter, cfg)(c, next);
		});
		app.use("/api/inference/execute", async (c, next) => {
			if (c.req.method !== "POST") return next();
			return requireRateLimit("inferenceExecute", executeLimiter, cfg)(c, next);
		});
		app.use("/api/inference/stream", async (c, next) => {
			if (c.req.method !== "POST") return next();
			return requireRateLimit("inferenceExecute", executeLimiter, cfg)(c, next);
		});
		app.use("/v1/chat/completions", async (c, next) =>
			requireRateLimit("inferenceGateway", gatewayLimiter, cfg)(c, next),
		);
	}

	mountInferenceRoutes(app, { getAuthMode: () => cfg.mode });
	return { app, secret };
}

async function readNextSseEvent(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	bufferRef: { value: string },
): Promise<{ event?: string; data: string } | null> {
	const decoder = new TextDecoder();

	while (true) {
		const boundary = bufferRef.value.indexOf("\n\n");
		if (boundary >= 0) {
			const block = bufferRef.value.slice(0, boundary);
			bufferRef.value = bufferRef.value.slice(boundary + 2);
			const lines = block.split(/\r?\n/);
			const event = lines
				.flatMap((line) => (line.startsWith("event:") ? [line.slice("event:".length).trim()] : []))
				.at(0);
			const data = lines
				.flatMap((line) => (line.startsWith("data:") ? [line.slice("data:".length).trimStart()] : []))
				.join("\n");
			return { event, data };
		}

		const next = await reader.read();
		if (next.done) return null;
		bufferRef.value += decoder.decode(next.value, { stream: true });
	}
}

describe("inference routing api", () => {
	beforeAll(async () => {
		prev = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-daemon-routing-"));
		writeRoutingFixture(dir);
		process.env.SIGNET_PATH = dir;

		const daemon = await import("./daemon");
		app = daemon.app;
	});

	afterAll(() => {
		if (prev === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		if (prev !== undefined) process.env.SIGNET_PATH = prev;
		rmSync(dir, { recursive: true, force: true });
	});

	it("exposes inference routing status", async () => {
		const res = await app.request("http://localhost/api/inference/status");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			enabled?: boolean;
			source?: string;
			targetRefs?: string[];
			policies?: string[];
		};
		expect(body.enabled).toBe(true);
		expect(body.source).toBe("explicit");
		expect(body.targetRefs).toContain("local/gemma");
		expect(body.policies).toContain("auto");
	});

	it("lists gateway models including automatic routing alias", async () => {
		const res = await app.request("http://localhost/v1/models");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data?: Array<{ id?: string }>;
		};
		const ids = (body.data ?? []).flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : []));
		expect(ids).toContain("signet:auto");
		expect(ids).toContain("policy:auto");
		expect(ids).toContain("local/gemma");
	});
});

describe("inference route hardening", () => {
	it("keeps status diagnostics-readable but blocks execution without admin", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-inference-auth-"));
		writeRoutingFixture(root);
		try {
			const { app, secret } = createInferenceTestApp(root);
			const operatorToken = createToken(secret, { sub: "operator", scope: {}, role: "operator" }, 60);

			const statusRes = await app.request(
				new Request("http://localhost/api/inference/status", {
					headers: { Authorization: `Bearer ${operatorToken}` },
				}),
			);
			expect(statusRes.status).toBe(200);

			const executeRes = await app.request(
				new Request("http://localhost/api/inference/execute", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${operatorToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ prompt: "hi there" }),
				}),
			);
			expect(executeRes.status).toBe(403);
		} finally {
			resetInferenceRouterForTests();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects mismatched scoped agent ids on route requests", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-inference-scope-"));
		writeRoutingFixture(root);
		try {
			const { app, secret } = createInferenceTestApp(root, { enforceDaemonPermissions: false });
			const scopedToken = createToken(secret, { sub: "rose-bot", scope: { agent: "rose" }, role: "agent" }, 60);
			const res = await app.request(
				new Request("http://localhost/api/inference/explain", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${scopedToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ agentId: "miles", operation: "interactive" }),
				}),
			);
			expect(res.status).toBe(403);
			const body = (await res.json()) as { error?: string };
			expect(body.error).toContain("scope restricted to agent 'rose'");
		} finally {
			resetInferenceRouterForTests();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects explicit target overrides outside the scoped agent roster", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-inference-override-"));
		writeRoutingFixture(root);
		try {
			const { app, secret } = createInferenceTestApp(root, { enforceDaemonPermissions: false });
			const scopedToken = createToken(secret, { sub: "rose-bot", scope: { agent: "rose" }, role: "agent" }, 60);
			const res = await app.request(
				new Request("http://localhost/api/inference/explain", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${scopedToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						operation: "interactive",
						explicitTargets: ["remote/sonnet"],
					}),
				}),
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error?: string };
			expect(body.error).toContain("Explicit target overrides are not allowed");
		} finally {
			resetInferenceRouterForTests();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rate limits repeated gateway calls independently of diagnostics", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-inference-rate-"));
		writeRoutingFixture(root);
		try {
			const { app, secret } = createInferenceTestApp(root, { inferenceGatewayMax: 1 });
			const adminToken = createToken(secret, { sub: "admin", scope: {}, role: "admin" }, 60);
			const first = await app.request(
				new Request("http://localhost/v1/chat/completions", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${adminToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						model: "signet:auto",
						messages: [{ role: "user", content: "hello" }],
					}),
				}),
			);
			expect(first.status).not.toBe(429);

			const second = await app.request(
				new Request("http://localhost/v1/chat/completions", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${adminToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						model: "signet:auto",
						messages: [{ role: "user", content: "hello again" }],
					}),
				}),
			);
			expect(second.status).toBe(429);

			const statusRes = await app.request(
				new Request("http://localhost/api/inference/status", {
					headers: { Authorization: `Bearer ${adminToken}` },
				}),
			);
			expect(statusRes.status).toBe(200);
		} finally {
			resetInferenceRouterForTests();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rate limits repeated execute calls independently of diagnostics", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-inference-execute-rate-"));
		writeRoutingFixture(root);
		try {
			const { app, secret } = createInferenceTestApp(root, { inferenceExecuteMax: 1 });
			const adminToken = createToken(secret, { sub: "admin", scope: {}, role: "admin" }, 60);
			const first = await app.request(
				new Request("http://localhost/api/inference/execute", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${adminToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						operation: "interactive",
						prompt: "hello there",
					}),
				}),
			);
			expect(first.status).not.toBe(429);

			const second = await app.request(
				new Request("http://localhost/api/inference/execute", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${adminToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						operation: "interactive",
						prompt: "hello again",
					}),
				}),
			);
			expect(second.status).toBe(429);

			const statusRes = await app.request(
				new Request("http://localhost/api/inference/status", {
					headers: { Authorization: `Bearer ${adminToken}` },
				}),
			);
			expect(statusRes.status).toBe(200);
		} finally {
			resetInferenceRouterForTests();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects oversized execute prompts before provider execution", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-inference-prompt-limit-"));
		writeRoutingFixture(root);
		try {
			const { app, secret } = createInferenceTestApp(root);
			const adminToken = createToken(secret, { sub: "admin", scope: {}, role: "admin" }, 60);
			const res = await app.request(
				new Request("http://localhost/api/inference/execute", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${adminToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						operation: "interactive",
						prompt: "x".repeat(200_001),
					}),
				}),
			);
			expect(res.status).toBe(413);
		} finally {
			resetInferenceRouterForTests();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed Signet gateway hint headers", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-inference-header-limit-"));
		writeRoutingFixture(root);
		try {
			const { app, secret } = createInferenceTestApp(root);
			const adminToken = createToken(secret, { sub: "admin", scope: {}, role: "admin" }, 60);
			const res = await app.request(
				new Request("http://localhost/v1/chat/completions", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${adminToken}`,
						"content-type": "application/json",
						"x-signet-agent-id": "bad value!",
					},
					body: JSON.stringify({
						model: "signet:auto",
						messages: [{ role: "user", content: "hello" }],
					}),
				}),
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error?: { message?: string } };
			expect(body.error?.message).toContain("x-signet-agent-id contains unsupported characters");
		} finally {
			resetInferenceRouterForTests();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects hostile remote overrides for local_only requests", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-inference-local-only-"));
		writeRoutingFixture(root);
		try {
			const { app, secret } = createInferenceTestApp(root, { enforceDaemonPermissions: false });
			const adminToken = createToken(secret, { sub: "admin", scope: {}, role: "admin" }, 60);
			const res = await app.request(
				new Request("http://localhost/api/inference/explain", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${adminToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						operation: "interactive",
						privacy: "local_only",
						explicitTargets: ["remote/sonnet"],
					}),
				}),
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error?: string };
			expect(body.error).toContain("Explicit target overrides are not allowed");
		} finally {
			resetInferenceRouterForTests();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("inference streaming", () => {
	it("streams gateway chat completions over SSE", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-inference-stream-gateway-"));
		const fake = startFakeOpenAiServer("success");
		writeStreamingRoutingFixture(root, fake.url);
		try {
			const { app, secret } = createInferenceTestApp(root);
			const adminToken = createToken(secret, { sub: "admin", scope: {}, role: "admin" }, 60);
			const res = await app.request(
				new Request("http://localhost/v1/chat/completions", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${adminToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						model: "signet:auto",
						stream: true,
						messages: [{ role: "user", content: "hello" }],
					}),
				}),
			);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/event-stream");
			expect(res.headers.get("x-signet-request-id")).toBeTruthy();

			const reader = res.body?.getReader();
			expect(reader).toBeTruthy();
			if (!reader) return;

			const buffer = { value: "" };
			const events: Array<{ event?: string; data: string }> = [];
			while (events.length < 5) {
				const next = await readNextSseEvent(reader, buffer);
				if (!next) break;
				events.push(next);
				if (next.data === "[DONE]") break;
			}

			const payloads = events
				.filter((entry) => entry.data !== "[DONE]")
				.map((entry) => JSON.parse(entry.data) as Record<string, unknown>);
			expect(payloads[0]?.choices).toBeTruthy();
			expect(JSON.stringify(payloads)).toContain("hel");
			expect(JSON.stringify(payloads)).toContain("lo");
			expect(events.at(-1)?.data).toBe("[DONE]");
		} finally {
			resetInferenceRouterForTests();
			fake.stop();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("supports cancelling native inference streams", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-inference-stream-cancel-"));
		const fake = startFakeOpenAiServer("success");
		writeStreamingRoutingFixture(root, fake.url);
		try {
			const { app, secret } = createInferenceTestApp(root);
			const adminToken = createToken(secret, { sub: "admin", scope: {}, role: "admin" }, 60);
			const res = await app.request(
				new Request("http://localhost/api/inference/stream", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${adminToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						operation: "interactive",
						prompt: "hello",
					}),
				}),
			);
			expect(res.status).toBe(200);
			const requestId = res.headers.get("x-signet-request-id");
			expect(requestId).toBeTruthy();
			if (!requestId) return;

			const reader = res.body?.getReader();
			expect(reader).toBeTruthy();
			if (!reader) return;
			const buffer = { value: "" };

			const meta = await readNextSseEvent(reader, buffer);
			expect(meta?.event).toBe("meta");
			const delta = await readNextSseEvent(reader, buffer);
			expect(delta?.event).toBe("delta");

			const cancelRes = await app.request(
				new Request(`http://localhost/api/inference/requests/${requestId}`, {
					method: "DELETE",
					headers: { Authorization: `Bearer ${adminToken}` },
				}),
			);
			expect(cancelRes.status).toBe(200);

			let cancelled = false;
			for (let i = 0; i < 5; i++) {
				const next = await readNextSseEvent(reader, buffer);
				if (!next) break;
				if (next.event === "cancelled") {
					cancelled = true;
					break;
				}
			}
			expect(cancelled).toBe(true);
		} finally {
			resetInferenceRouterForTests();
			fake.stop();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns degraded partial output when the upstream stream dies mid-flight", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-inference-stream-error-"));
		const fake = startFakeOpenAiServer("error");
		writeStreamingRoutingFixture(root, fake.url);
		try {
			const { app, secret } = createInferenceTestApp(root);
			const adminToken = createToken(secret, { sub: "admin", scope: {}, role: "admin" }, 60);
			const res = await app.request(
				new Request("http://localhost/api/inference/stream", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${adminToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						operation: "interactive",
						prompt: "hello",
					}),
				}),
			);
			expect(res.status).toBe(200);

			const reader = res.body?.getReader();
			expect(reader).toBeTruthy();
			if (!reader) return;
			const buffer = { value: "" };

			await readNextSseEvent(reader, buffer); // meta
			const delta = await readNextSseEvent(reader, buffer);
			expect(delta?.event).toBe("delta");
			expect(delta?.data).toContain("hel");

			let errorPayload: Record<string, unknown> | null = null;
			for (let i = 0; i < 5; i++) {
				const next = await readNextSseEvent(reader, buffer);
				if (!next) break;
				if (next.event === "error") {
					errorPayload = JSON.parse(next.data) as Record<string, unknown>;
					break;
				}
			}

			expect(errorPayload).toBeTruthy();
			expect(JSON.stringify(errorPayload)).toContain("partialText");
			expect(JSON.stringify(errorPayload)).toContain("hel");
		} finally {
			resetInferenceRouterForTests();
			fake.stop();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
