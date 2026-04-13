import { describe, expect, it } from "bun:test";
import { markDeprecatedVersions } from "./model-registry";

describe("markDeprecatedVersions", () => {
	it("marks older same-family models as deprecated", () => {
		const entries = [
			{ id: "claude-opus-4.0", provider: "anthropic", label: "Claude Opus 4.0", tier: "high", deprecated: false },
			{ id: "claude-opus-4.6", provider: "anthropic", label: "Claude Opus 4.6", tier: "high", deprecated: false },
		];
		const result = markDeprecatedVersions(entries);
		expect(result.find((e) => e.id === "claude-opus-4.0")?.deprecated).toBe(true);
		expect(result.find((e) => e.id === "claude-opus-4.6")?.deprecated).toBe(false);
	});

	it("does not mark unrelated models as deprecated", () => {
		const entries = [
			{ id: "claude-opus-4.6", provider: "anthropic", label: "Claude Opus 4.6", tier: "high", deprecated: false },
			{ id: "claude-sonnet-4.0", provider: "anthropic", label: "Claude Sonnet 4.0", tier: "medium", deprecated: false },
		];
		const result = markDeprecatedVersions(entries);
		expect(result.every((e) => !e.deprecated)).toBe(true);
	});

	it("handles empty and single-entry arrays", () => {
		expect(markDeprecatedVersions([])).toEqual([]);
		const single = [{ id: "claude-opus-4.0", provider: "anthropic", label: "Opus 4", tier: "high", deprecated: false }];
		const result = markDeprecatedVersions(single);
		expect(result[0].deprecated).toBe(false);
	});
});
