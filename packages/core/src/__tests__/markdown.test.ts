import { describe, expect, test } from "bun:test";
import { buildArchitectureDoc, buildSignetBlock } from "../markdown";

describe("buildSignetBlock", () => {
	test("returns empty string for compatibility", () => {
		const block = buildSignetBlock();
		expect(block).toBe("");
	});
});

describe("buildArchitectureDoc", () => {
	test("explains identity stewardship and MEMORY.md ownership", () => {
		const doc = buildArchitectureDoc("/tmp/signet-agent");

		expect(doc).toContain("`/tmp/signet-agent/AGENTS.md`");
		expect(doc).toContain("Do not edit `/tmp/signet-agent/MEMORY.md` manually");
		expect(doc).toContain("Identity files are your durable substrate");
	});
});
