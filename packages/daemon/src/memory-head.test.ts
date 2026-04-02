import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";
import { MEMORY_HEAD_MAX_TOKENS, writeMemoryHead } from "./memory-head";

const tok = new Tiktoken(cl100k_base);

let agentsDir = "";
let prevSignetPath: string | undefined;

function readMemoryHead(): string {
	return readFileSync(join(agentsDir, "MEMORY.md"), "utf-8");
}

describe("writeMemoryHead", () => {
	beforeAll(() => {
		prevSignetPath = process.env.SIGNET_PATH;
		agentsDir = mkdtempSync(join(tmpdir(), "signet-memory-head-"));
		process.env.SIGNET_PATH = agentsDir;
	});

	beforeEach(() => {
		rmSync(agentsDir, { recursive: true, force: true });
		mkdirSync(agentsDir, { recursive: true });
	});

	afterAll(() => {
		rmSync(agentsDir, { recursive: true, force: true });
		if (prevSignetPath === undefined) {
			delete process.env.SIGNET_PATH;
			return;
		}
		process.env.SIGNET_PATH = prevSignetPath;
	});

	it("keeps short MEMORY.md content intact", () => {
		const content = "# MEMORY\n\n## Active\n- short note\n";

		const result = writeMemoryHead(content);
		expect(result.ok).toBe(true);

		const file = readMemoryHead();
		expect(file.startsWith("<!-- generated ")).toBe(true);
		expect(file).toContain("## Active\n- short note");
		expect(tok.encode(file).length).toBeLessThanOrEqual(MEMORY_HEAD_MAX_TOKENS);
	});

	it("truncates the tail of oversized MEMORY.md content to 5000 tokens", () => {
		const keep = "# MEMORY\n\n## Active\n- retain this context\n\n";
		const chunk = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega\n";
		const tail = "\n## Tail Marker\nthis section should be truncated away\n";
		let content = keep;

		while (tok.encode(content).length < 6000) {
			content += chunk;
		}
		content += tail;

		const result = writeMemoryHead(content);
		expect(result.ok).toBe(true);

		const file = readMemoryHead();
		expect(file.startsWith("<!-- generated ")).toBe(true);
		expect(file).toContain("retain this context");
		expect(file).not.toContain("## Tail Marker");
		expect(tok.encode(file).length).toBeLessThanOrEqual(MEMORY_HEAD_MAX_TOKENS);
	});
});
