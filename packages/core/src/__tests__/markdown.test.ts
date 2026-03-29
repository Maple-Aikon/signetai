import { describe, expect, test } from "bun:test";
import { buildArchitectureDoc, buildSignetBlock } from "../markdown";

describe("buildSignetBlock", () => {
	test("uses workspace-relative file references by default", () => {
		const block = buildSignetBlock();

		expect(block).toContain("`$SIGNET_WORKSPACE/AGENTS.md`");
		expect(block).toContain("`$SIGNET_WORKSPACE/MEMORY.md`");
		expect(block).toContain("Do not edit `MEMORY.md` manually");
		expect(block).toContain("maintain `AGENTS.md`,");
	});

	test("renders a custom workspace path when provided", () => {
		const block = buildSignetBlock("/tmp/signet-agent");

		expect(block).toContain("`/tmp/signet-agent/AGENTS.md`");
		expect(block).toContain("`/tmp/signet-agent/SIGNET-ARCHITECTURE.md`");
		expect(block).not.toContain("`~/.agents/AGENTS.md`");
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
