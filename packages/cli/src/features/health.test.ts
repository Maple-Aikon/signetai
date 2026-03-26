import { describe, expect, it } from "bun:test";
import { getExtractionStatusNotice } from "./health.js";

describe("getExtractionStatusNotice", () => {
	it("returns a warning for degraded extraction", () => {
		const notice = getExtractionStatusNotice({
			running: true,
			pid: 1,
			uptime: 10,
			version: "0.0.1",
			host: "127.0.0.1",
			bindHost: "127.0.0.1",
			networkMode: "local",
			extraction: {
				configured: "claude-code",
				effective: "ollama",
				fallbackProvider: "ollama",
				status: "degraded",
				degraded: true,
				reason: "Claude Code CLI not found during extraction startup preflight",
				since: "2026-03-26T00:00:00.000Z",
			},
		});

		expect(notice).toEqual({
			level: "warn",
			title: "Extraction degraded",
			detail:
				"configured: claude-code, effective: ollama — Claude Code CLI not found during extraction startup preflight",
		});
	});

	it("returns an error for blocked extraction", () => {
		const notice = getExtractionStatusNotice({
			running: true,
			pid: 1,
			uptime: 10,
			version: "0.0.1",
			host: "127.0.0.1",
			bindHost: "127.0.0.1",
			networkMode: "local",
			extraction: {
				configured: "claude-code",
				effective: "none",
				fallbackProvider: "none",
				status: "blocked",
				degraded: true,
				reason: "Claude Code CLI not found during extraction startup preflight; fallbackProvider is none",
				since: "2026-03-26T00:00:00.000Z",
			},
		});

		expect(notice?.level).toBe("error");
		expect(notice?.title).toBe("Extraction blocked");
		expect(notice?.detail).toContain("fallback: none");
	});
});
