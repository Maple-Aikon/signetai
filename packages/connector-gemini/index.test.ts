import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

	it("removes signet-managed skill symlinks on uninstall", async () => {
		writeIdentity(tmpRoot);
		const skillsDir = join(tmpRoot, "skills");
		const skillSubdir = join(skillsDir, "my-skill");
		mkdirSync(skillSubdir, { recursive: true });
		writeFileSync(join(skillSubdir, "test.md"), "# test", "utf-8");

		const connector = makeConnector();
		await connector.install(tmpRoot);
		expect(existsSync(join(geminiDir, "skills"))).toBe(true);

		const result = await connector.uninstall();
		expect(result.filesRemoved.some((f) => f.endsWith("skills"))).toBe(true);
		expect(existsSync(join(geminiDir, "skills"))).toBe(false);
	});

	it("preserves user-managed real skills directory on uninstall", async () => {
		writeIdentity(tmpRoot);
		mkdirSync(join(geminiDir, "skills", "user-skill"), { recursive: true });
		writeFileSync(join(geminiDir, "skills", "user-skill", "skill.md"), "# user skill", "utf-8");

		const connector = makeConnector();
		const result = await connector.uninstall();
		expect(result.filesRemoved.some((f) => f.endsWith("skills"))).toBe(false);
		expect(existsSync(join(geminiDir, "skills", "user-skill", "skill.md"))).toBe(true);
	});

	it("preserves non-signet symlinks inside skills on uninstall", async () => {
		writeIdentity(tmpRoot);
		const userSkillSource = join(tmpRoot, "user-skills");
		mkdirSync(userSkillSource, { recursive: true });
		writeFileSync(join(userSkillSource, "custom.md"), "# custom", "utf-8");

		mkdirSync(join(geminiDir, "skills"), { recursive: true });
		symlinkSync(userSkillSource, join(geminiDir, "skills", "custom-skill"));

		const connector = makeConnector();
		const result = await connector.uninstall();
		expect(result.filesRemoved.some((f) => f.endsWith("skills"))).toBe(false);
		expect(existsSync(join(geminiDir, "skills", "custom-skill"))).toBe(true);
	});

	it("preserves prefix-colliding symlink paths on uninstall", async () => {
		writeIdentity(tmpRoot);
		const skillsBackup = join(tmpRoot, "skills-backup");
		mkdirSync(skillsBackup, { recursive: true });
		writeFileSync(join(skillsBackup, "backup.md"), "# backup", "utf-8");

		mkdirSync(join(geminiDir, "skills"), { recursive: true });
		symlinkSync(skillsBackup, join(geminiDir, "skills", "backup"));

		const connector = makeConnector();
		const result = await connector.uninstall();
		expect(result.filesRemoved.some((f) => f.endsWith("skills"))).toBe(false);
		expect(existsSync(join(geminiDir, "skills", "backup"))).toBe(true);
	});

	it("preserves non-signet hooks within the same group", async () => {
		writeIdentity(tmpRoot);
		const settings = {
			hooks: {
				SessionStart: [
					{
						matcher: "*",
						hooks: [
							{ type: "command", command: "echo hello", name: "user-hook" },
						],
					},
				],
			},
		};
		writeFileSync(join(geminiDir, "settings.json"), JSON.stringify(settings), "utf-8");

		const connector = makeConnector();
		await connector.install(tmpRoot);

		const afterInstall = JSON.parse(readFileSync(join(geminiDir, "settings.json"), "utf-8"));
		const sessionStart = afterInstall.hooks.SessionStart as Array<Record<string, unknown>>;
		const userGroup = sessionStart.find((g) => {
			const hooks = g.hooks as Array<Record<string, string>>;
			return hooks?.some((h) => h.name === "user-hook");
		});
		expect(userGroup).toBeDefined();

		await connector.uninstall();

		const afterUninstall = JSON.parse(readFileSync(join(geminiDir, "settings.json"), "utf-8"));
		const remaining = afterUninstall.hooks?.SessionStart as Array<Record<string, unknown>> | undefined;
		if (remaining) {
			for (const group of remaining) {
				const hooks = group.hooks as Array<Record<string, string>>;
				for (const h of hooks) {
					expect(h.name).not.toStartWith("signet-");
				}
				expect(hooks.some((h) => h.name === "user-hook")).toBe(true);
			}
		}
	});
});
