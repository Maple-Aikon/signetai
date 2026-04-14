import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiConnector } from "./src/index.js";

let tmpRoot = "";
let geminiDir = "";

function writeIdentity(dir: string): void {
	for (const file of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
		writeFileSync(join(dir, file), `# ${file}\n`, "utf-8");
	}
}

function makeConnector(): GeminiConnector {
	return new GeminiConnector(geminiDir);
}

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "signet-gemini-test-"));
	geminiDir = join(tmpRoot, ".gemini");
	mkdirSync(geminiDir, { recursive: true });
});

afterEach(() => {
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GeminiConnector.install", () => {
	it("writes GEMINI.md and settings.json hooks on install", async () => {
		writeIdentity(tmpRoot);
		const result = await makeConnector().install(tmpRoot);

		expect(result.success).toBe(true);
		expect(result.filesWritten.some((f) => f.endsWith("GEMINI.md"))).toBe(true);

		const geminiMd = readFileSync(join(geminiDir, "GEMINI.md"), "utf-8");
		expect(geminiMd).toContain("# AGENTS.md");
		expect(geminiMd).toContain("signet-managed");

		const settings = JSON.parse(readFileSync(join(geminiDir, "settings.json"), "utf-8"));
		expect(settings.hooks.SessionStart).toBeDefined();
		expect(settings.hooks.SessionEnd).toBeDefined();
		expect(settings.hooks.BeforeAgent).toBeDefined();
		expect(settings.hooks.PreCompress).toBeDefined();
		expect(settings.mcpServers.signet).toBeDefined();
		expect(settings.mcpServers.signet.type).toBe("stdio");
	});

	it("fails when no valid identity exists", async () => {
		const result = await makeConnector().install(tmpRoot);
		expect(result.success).toBe(false);
		expect(result.filesWritten).toHaveLength(0);
	});

	it("isInstalled returns true after install", async () => {
		writeIdentity(tmpRoot);
		const connector = makeConnector();
		expect(connector.isInstalled()).toBe(false);
		await connector.install(tmpRoot);
		expect(connector.isInstalled()).toBe(true);
	});

	it("isInstalled returns false when settings.json has no signet hooks", async () => {
		writeFileSync(join(geminiDir, "settings.json"), "{}", "utf-8");
		expect(makeConnector().isInstalled()).toBe(false);
	});
});

describe("GeminiConnector.uninstall", () => {
	it("removes signet-managed GEMINI.md and cleans settings", async () => {
		writeIdentity(tmpRoot);
		const connector = makeConnector();
		await connector.install(tmpRoot);

		const result = await connector.uninstall();
		expect(result.filesRemoved.some((f) => f.endsWith("GEMINI.md"))).toBe(true);

		const settings = JSON.parse(readFileSync(join(geminiDir, "settings.json"), "utf-8"));
		expect(settings.hooks).toBeUndefined();
		expect(settings.mcpServers?.signet).toBeUndefined();
	});

	it("does not remove non-signet GEMINI.md", async () => {
		writeFileSync(join(geminiDir, "GEMINI.md"), "user content", "utf-8");
		const result = await makeConnector().uninstall();
		expect(result.filesRemoved).toHaveLength(0);
		expect(existsSync(join(geminiDir, "GEMINI.md"))).toBe(true);
	});
});
