import { afterEach, describe, expect, it } from "bun:test";
import { getDaemonStatus } from "./runtime.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("getDaemonStatus", () => {
	it("parses extraction provider degradation from /api/status", async () => {
		globalThis.fetch = async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith("/health")) {
				return new Response("ok", { status: 200 });
			}
			if (url.endsWith("/api/status")) {
				return Response.json({
					pid: 42,
					uptime: 123,
					version: "0.77.4",
					host: "127.0.0.1",
					bindHost: "127.0.0.1",
					networkMode: "local",
					providerResolution: {
						extraction: {
							configured: "claude-code",
							effective: "ollama",
							fallbackProvider: "ollama",
							status: "degraded",
							degraded: true,
							reason: "Claude Code CLI not found during extraction startup preflight",
							since: "2026-03-26T00:00:00.000Z",
						},
					},
				});
			}
			return new Response("not found", { status: 404 });
		};

		const status = await getDaemonStatus();
		expect(status.running).toBe(true);
		expect(status.extraction).toEqual({
			configured: "claude-code",
			effective: "ollama",
			fallbackProvider: "ollama",
			status: "degraded",
			degraded: true,
			reason: "Claude Code CLI not found during extraction startup preflight",
			since: "2026-03-26T00:00:00.000Z",
		});
	});
});
