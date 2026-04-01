/**
 * Integration tests for /api/hooks/prompt-eval and /api/hooks/agent-eval.
 *
 * These tests cover the HTTP contract of the endpoints — auth, validation,
 * and the fail-open behavior when no synthesis provider is configured.
 * The LLM parsing logic itself is tested in hook-eval.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app: {
	request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};
let dir = "";
let prev: string | undefined;

describe("hook eval endpoints", () => {
	beforeAll(async () => {
		prev = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-hook-eval-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		// Pipeline disabled — no synthesis provider available.
		// All eval calls should fail-open ({ok: true}).
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: false
`,
		);
		process.env.SIGNET_PATH = dir;
		const daemon = await import("./daemon");
		app = daemon.app;
	});

	afterAll(() => {
		if (prev === undefined) delete process.env.SIGNET_PATH;
		else process.env.SIGNET_PATH = prev;
		rmSync(dir, { recursive: true, force: true });
	});

	describe("POST /api/hooks/prompt-eval", () => {
		it("returns 400 when prompt is missing", async () => {
			const res = await app.request("http://localhost/api/hooks/prompt-eval", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBeTruthy();
		});

		it("returns 400 when prompt is empty string", async () => {
			const res = await app.request("http://localhost/api/hooks/prompt-eval", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "" }),
			});
			expect(res.status).toBe(400);
		});

		it("returns 400 when body is not JSON object", async () => {
			const res = await app.request("http://localhost/api/hooks/prompt-eval", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify("just a string"),
			});
			expect(res.status).toBe(400);
		});

		it("fails open (ok:true) when no synthesis provider configured", async () => {
			const res = await app.request("http://localhost/api/hooks/prompt-eval", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "should this tool call be allowed?" }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { ok: boolean; reason: unknown; inject: unknown };
			expect(body.ok).toBe(true);
			expect(body.reason).toBeNull();
			expect(body.inject).toBeNull();
		});

		it("response shape matches documented contract", async () => {
			const res = await app.request("http://localhost/api/hooks/prompt-eval", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "test prompt" }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			// Must have these fields — not optional — so Forge's DaemonExecutor can parse
			expect("ok" in body).toBe(true);
			expect("reason" in body).toBe(true);
			expect("inject" in body).toBe(true);
		});
	});

	describe("POST /api/hooks/agent-eval", () => {
		it("returns 400 when prompt is missing", async () => {
			const res = await app.request("http://localhost/api/hooks/agent-eval", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
		});

		it("fails open (ok:true) when no synthesis provider configured", async () => {
			const res = await app.request("http://localhost/api/hooks/agent-eval", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "evaluate this agent action" }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { ok: boolean };
			expect(body.ok).toBe(true);
		});

		it("response shape is identical to prompt-eval", async () => {
			const promptRes = await app.request("http://localhost/api/hooks/prompt-eval", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "same prompt" }),
			});
			const agentRes = await app.request("http://localhost/api/hooks/agent-eval", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "same prompt" }),
			});
			// Both endpoints should return the same field set
			const pBody = (await promptRes.json()) as Record<string, unknown>;
			const aBody = (await agentRes.json()) as Record<string, unknown>;
			expect(Object.keys(pBody).sort()).toEqual(Object.keys(aBody).sort());
		});
	});
});
