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
			extractionWorker: null,
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
			extractionWorker: null,
		});

		expect(notice?.level).toBe("error");
		expect(notice?.title).toBe("Extraction blocked");
		expect(notice?.detail).toContain("fallback: none");
	});

	it("returns a warning when extraction worker is load-shedding", () => {
		const notice = getExtractionStatusNotice({
			running: true,
			pid: 1,
			uptime: 10,
			version: "0.0.1",
			host: "127.0.0.1",
			bindHost: "127.0.0.1",
			networkMode: "local",
			extraction: null,
			extractionWorker: {
				running: true,
				overloaded: true,
				loadPerCpu: 1.82,
				maxLoadPerCpu: 0.8,
				overloadBackoffMs: 30000,
				overloadSince: "2026-03-26T00:00:00.000Z",
				nextTickInMs: 28000,
			},
		});

		expect(notice).toEqual({
			level: "warn",
			title: "Pipeline load-shedding",
			detail: "load/core 1.82 > threshold 0.80 — next tick in 28s",
		});
	});

	it("prioritizes blocked extraction over load-shedding warning", () => {
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
			extractionWorker: {
				running: true,
				overloaded: true,
				loadPerCpu: 1.82,
				maxLoadPerCpu: 0.8,
				overloadBackoffMs: 30000,
				overloadSince: "2026-03-26T00:00:00.000Z",
				nextTickInMs: 28000,
			},
		});

		expect(notice?.level).toBe("error");
		expect(notice?.title).toBe("Extraction blocked");
	});
});
