import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendProviderTransitions,
	applyProviderRollback,
	detectProviderTransitions,
	executeProviderRollback,
	isRollbackInFlight,
	readProviderTransitions,
	validateProviderSafety,
} from "./provider-safety";

const tmpDirs: string[] = [];

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (!dir) continue;
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-provider-safety-"));
	tmpDirs.push(dir);
	return dir;
}

describe("provider safety", () => {
	it("flags local-to-remote provider transitions for audit", () => {
		const before = "memory:\n  pipelineV2:\n    extractionProvider: ollama\n";
		const after = "memory:\n  pipelineV2:\n    extractionProvider: anthropic\n";
		const entries = detectProviderTransitions(before, after, "test", undefined, new Date("2026-04-12T00:00:00Z"));

		expect(entries).toEqual([
			{
				role: "extraction",
				from: "ollama",
				to: "anthropic",
				timestamp: "2026-04-12T00:00:00.000Z",
				source: "test",
				actor: undefined,
				risky: true,
			},
		]);
	});

	it("blocks remote providers when allowRemoteProviders is false", () => {
		const result = validateProviderSafety(`memory:
  pipelineV2:
    allowRemoteProviders: false
    extractionProvider: openrouter
`);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("allowRemoteProviders is false");
			expect(result.error).toContain("openrouter");
		}
	});

	it("allows local providers when allowRemoteProviders is false", () => {
		const result = validateProviderSafety(`memory:
  pipelineV2:
    allowRemoteProviders: false
    extractionProvider: ollama
`);

		expect(result).toEqual({ ok: true });
	});

	it("rejects malformed YAML during safety validation", () => {
		const result = validateProviderSafety("memory:\n  pipelineV2: [");

		expect(result).toEqual({ ok: false, error: "Invalid YAML config" });
	});

	it("records transitions and rolls back the latest provider", () => {
		const agentsDir = makeTempDir();
		const entries = detectProviderTransitions(
			"memory:\n  pipelineV2:\n    extractionProvider: none\n",
			"memory:\n  pipelineV2:\n    extractionProvider: codex\n",
			"test",
		);
		appendProviderTransitions(agentsDir, entries);

		const stored = readProviderTransitions(agentsDir);
		expect(stored).toHaveLength(1);
		const next = applyProviderRollback("memory:\n  pipelineV2:\n    extractionProvider: codex\n", stored[0]);
		writeFileSync(join(agentsDir, "agent.yaml"), next, "utf-8");

		expect(readFileSync(join(agentsDir, "agent.yaml"), "utf-8")).toContain("extractionProvider: none");
	});

	it("prevents rollback ping-pong by marking consumed entries", () => {
		const agentsDir = makeTempDir();
		const configDir = makeTempDir();

		writeFileSync(join(configDir, "agent.yaml"), "memory:\n  pipelineV2:\n    extractionProvider: ollama\n", "utf-8");

		const entries = detectProviderTransitions(
			"memory:\n  pipelineV2:\n    extractionProvider: ollama\n",
			"memory:\n  pipelineV2:\n    extractionProvider: anthropic\n",
			"test",
		);
		appendProviderTransitions(agentsDir, entries);

		const result1 = executeProviderRollback(agentsDir, join(configDir, "agent.yaml"));
		expect(result1.success).toBe(true);
		expect(result1.rolledBack.to).toBe("anthropic");

		const afterFirst = readFileSync(join(configDir, "agent.yaml"), "utf-8");
		expect(afterFirst).toContain("extractionProvider: ollama");

		expect(() => executeProviderRollback(agentsDir, join(configDir, "agent.yaml"))).toThrow(
			"No provider transition with rollback target found",
		);

		const stored = readProviderTransitions(agentsDir);
		expect(stored[0].rolledBack).toBe(true);
	});

	it("sets rollback in-flight flag during execution", () => {
		const agentsDir = makeTempDir();
		const configDir = makeTempDir();

		writeFileSync(join(configDir, "agent.yaml"), "memory:\n  pipelineV2:\n    extractionProvider: none\n", "utf-8");
		const entries = detectProviderTransitions(
			"memory:\n  pipelineV2:\n    extractionProvider: none\n",
			"memory:\n  pipelineV2:\n    extractionProvider: codex\n",
			"test",
		);
		appendProviderTransitions(agentsDir, entries);

		expect(isRollbackInFlight()).toBe(false);
	});

	it("skips corrupted entries in audit file", () => {
		const agentsDir = makeTempDir();
		const auditPath = join(agentsDir, ".daemon");
		const { mkdirSync } = require("node:fs");
		mkdirSync(auditPath, { recursive: true });
		writeFileSync(
			join(auditPath, "provider-transitions.json"),
			JSON.stringify([
				{
					role: "extraction",
					from: "ollama",
					to: "anthropic",
					timestamp: "2026-04-12T00:00:00Z",
					source: "test",
					risky: true,
				},
				{ garbage: true },
				42,
				{ role: "synthesis" },
				null,
				"string",
				{
					role: "extraction",
					from: "ollama",
					to: "codex",
					timestamp: "2026-04-12T00:01:00Z",
					source: "test",
					risky: true,
				},
			]),
			"utf-8",
		);

		const stored = readProviderTransitions(agentsDir);
		expect(stored).toHaveLength(2);
		expect(stored[0].to).toBe("anthropic");
		expect(stored[1].to).toBe("codex");
	});

	it("returns empty array for non-array audit file content", () => {
		const agentsDir = makeTempDir();
		const auditPath = join(agentsDir, ".daemon");
		const { mkdirSync } = require("node:fs");
		mkdirSync(auditPath, { recursive: true });
		writeFileSync(join(auditPath, "provider-transitions.json"), JSON.stringify({ not: "an array" }), "utf-8");

		expect(readProviderTransitions(agentsDir)).toEqual([]);
	});

	it("returns empty array for missing audit file", () => {
		const agentsDir = makeTempDir();
		expect(readProviderTransitions(agentsDir)).toEqual([]);
	});

	it("executeProviderRollback rejects when no eligible transition exists", () => {
		const agentsDir = makeTempDir();
		const configDir = makeTempDir();
		writeFileSync(join(configDir, "agent.yaml"), "memory:\n  pipelineV2:\n    extractionProvider: ollama\n", "utf-8");

		expect(() => executeProviderRollback(agentsDir, join(configDir, "agent.yaml"))).toThrow(
			"No provider transition with rollback target found",
		);
	});
});
