import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendProviderTransitions,
	applyProviderRollback,
	detectProviderTransitions,
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
});
