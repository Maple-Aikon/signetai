import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app: {
	request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};
let dir = "";
let prev: string | undefined;

describe("inference routing api", () => {
	beforeAll(async () => {
		prev = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-daemon-routing-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    extraction:
      provider: none
routing:
  defaultPolicy: auto
  targets:
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
        - local/gemma
  taskClasses:
    casual_chat:
      preferredTargets:
        - local/gemma
  workloads:
    interactive:
      policy: auto
      taskClass: casual_chat
`,
		);
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
