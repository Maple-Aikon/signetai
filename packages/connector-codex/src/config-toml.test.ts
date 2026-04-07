/**
 * Integration tests for CodexConnector MCP config.toml management.
 *
 * Tests exercise real production code via CodexConnector.install() and
 * CodexConnector.uninstall(). A subclass redirects getCodexHome() to a
 * temp directory so the real ~/.codex is never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexConnector, buildMcpBlock } from "./index.js";

class TempConnector extends CodexConnector {
	constructor(private home: string) {
		super();
	}
	protected override getCodexHome(): string {
		return join(this.home, ".codex");
	}
	protected override getLocalBinDir(): string {
		return join(this.home, ".local", "bin");
	}
}

let tempHome: string;
let codexDir: string;
let configPath: string;
let hooksPath: string;
let localBinDir: string;
let wrapperPath: string;
let watcherPath: string;

beforeEach(() => {
	tempHome = join(tmpdir(), `signet-codex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	codexDir = join(tempHome, ".codex");
	configPath = join(codexDir, "config.toml");
	hooksPath = join(codexDir, "hooks.json");
	localBinDir = join(tempHome, ".local", "bin");
	wrapperPath = join(localBinDir, "codex");
	watcherPath = join(localBinDir, "codex-signet-watch.js");
	mkdirSync(codexDir, { recursive: true });
	mkdirSync(localBinDir, { recursive: true });
});

afterEach(() => {
	rmSync(tempHome, { recursive: true, force: true });
});

function connector(): TempConnector {
	return new TempConnector(tempHome);
}

describe("CodexConnector.install — legacy SIGNET block migration", () => {
	test("strips legacy block from AGENTS.md and reports path in filesWritten", async () => {
		const agentsPath = join(tempHome, "AGENTS.md");
		writeFileSync(
			agentsPath,
			`before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n`,
			"utf-8",
		);

		const result = await connector().install(tempHome);

		expect(readFileSync(agentsPath, "utf-8")).toBe("before\nafter\n");
		expect(result.filesWritten).toContain(agentsPath);
	});

	test("leaves AGENTS.md untouched and does not add path when no legacy block", async () => {
		const agentsPath = join(tempHome, "AGENTS.md");
		writeFileSync(agentsPath, "plain content\n", "utf-8");

		const result = await connector().install(tempHome);

		expect(readFileSync(agentsPath, "utf-8")).toBe("plain content\n");
		expect(result.filesWritten).not.toContain(agentsPath);
	});
});

describe("CodexConnector.install — config.toml MCP registration", () => {
	test("creates config.toml with string command when file does not exist", async () => {
		await connector().install(tempHome);
		expect(existsSync(configPath)).toBe(true);
		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("[mcp_servers.signet]");
		expect(content).toContain("command = 'signet-mcp'");
		// Must not be an array — Codex's Rust parser expects Option<String>
		expect(content).not.toContain("command = [");
	});

	test("repairs stale array-format command on re-install (regression: #273 / invalid transport)", async () => {
		// This is the exact config that caused "invalid transport in 'mcp_servers.signet'"
		// errors for users who installed before PR #273 fixed the array bug.
		writeFileSync(
			configPath,
			"# Signet MCP server\n[mcp_servers.signet]\ncommand = ['signet-mcp']\n",
		);

		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("command = 'signet-mcp'");
		expect(content).not.toContain("command = [");
	});

	test("preserves other config sections when repairing stale entry", async () => {
		writeFileSync(
			configPath,
			'[model]\nname = "gpt-4o"\n\n# Signet MCP server\n[mcp_servers.signet]\ncommand = [\'signet-mcp\']\n\n[history]\nenabled = true\n',
		);

		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("[model]");
		expect(content).toContain('name = "gpt-4o"');
		expect(content).toContain("[history]");
		expect(content).toContain("enabled = true");
		expect(content).toContain("command = 'signet-mcp'");
		expect(content).not.toContain("command = [");
	});

	test("appends section when config exists but has no signet entry", async () => {
		writeFileSync(configPath, '[model]\nname = "gpt-4o"\n');

		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("[model]");
		expect(content).toContain("[mcp_servers.signet]");
		expect(content).toContain("command = 'signet-mcp'");
	});

	test("idempotent: re-running install produces identical config.toml", async () => {
		await connector().install(tempHome);
		const first = readFileSync(configPath, "utf-8");

		await connector().install(tempHome);
		const second = readFileSync(configPath, "utf-8");

		expect(second).toBe(first);
	});

	test("config section appears exactly once after repeated installs", async () => {
		await connector().install(tempHome);
		await connector().install(tempHome);
		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content.match(/\[mcp_servers\.signet\]/g)?.length).toBe(1);
	});
});

describe("CodexConnector.install — hooks.json registration", () => {
	test("writes Codex 0.118+ hook schema with command hooks", async () => {
		await connector().install(tempHome);

		const hooks = JSON.parse(readFileSync(hooksPath, "utf-8")) as Record<string, unknown>;
		expect(hooks._signet).toBe(true);
		expect(hooks.SessionStart).toBeArray();
		expect(hooks.UserPromptSubmit).toBeArray();
		expect(hooks.Stop).toBeArray();

		const sessionStartEntry = (hooks.SessionStart as Array<Record<string, unknown>>)[0];
		const sessionStartHook = (sessionStartEntry.hooks as Array<Record<string, unknown>>)[0];
		expect(sessionStartHook.type).toBe("command");
		expect(sessionStartHook.command).toBe("signet hook session-start -H codex");
		expect(sessionStartHook.timeout).toBe(10);
	});

	test("merges Signet hooks into existing modern hooks.json without replacing user hooks", async () => {
		writeFileSync(
			hooksPath,
			JSON.stringify(
				{
					SessionStart: [
						{
							hooks: [
								{
									type: "command",
									command: "echo existing-hook",
									timeout: 3,
								},
							],
						},
					],
				},
				null,
				2,
			),
		);

		const result = await connector().install(tempHome);
		const hooks = JSON.parse(readFileSync(hooksPath, "utf-8")) as Record<string, unknown>;
		const sessionStart = hooks.SessionStart as Array<Record<string, unknown>>;

		expect(result.warnings).toContain("Merged Signet hooks into existing hooks.json — existing hooks preserved");
		expect(sessionStart).toHaveLength(2);
		expect(((sessionStart[0]?.hooks as Array<Record<string, unknown>>)[0]?.command)).toBe("echo existing-hook");
		expect(((sessionStart[1]?.hooks as Array<Record<string, unknown>>)[0]?.command)).toBe(
			"signet hook session-start -H codex",
		);
	});

	test("uninstall removes legacy lowercase and modern uppercase Signet hook blocks", async () => {
		writeFileSync(
			hooksPath,
			JSON.stringify(
				{
					_signet: true,
					sessionStart: [
						{
							handlers: [
								{
									command: ["signet", "hook", "session-start", "-H", "codex"],
									timeout: 10,
								},
							],
						},
					],
					SessionStart: [
						{
							hooks: [
								{
									type: "command",
									command: "signet hook session-start -H codex",
									timeout: 10,
								},
							],
						},
					],
					Stop: [
						{
							hooks: [
								{
									type: "command",
									command: "echo keep-me",
									timeout: 3,
								},
							],
						},
					],
				},
				null,
				2,
			),
		);

		await connector().uninstall();

		const hooks = JSON.parse(readFileSync(hooksPath, "utf-8")) as Record<string, unknown>;
		expect(hooks.sessionStart).toBeUndefined();
		expect(hooks.SessionStart).toBeUndefined();
		expect(hooks.Stop).toEqual([
			{
				hooks: [
					{
						type: "command",
						command: "echo keep-me",
						timeout: 3,
					},
				],
			},
		]);
	});
});

describe("CodexConnector.install — wrapper fallback", () => {
	test("installs Signet-managed Codex wrapper and watcher", async () => {
		const result = await connector().install(tempHome);

		expect(result.filesWritten).toContain(wrapperPath);
		expect(result.filesWritten).toContain(watcherPath);
		expect(readFileSync(wrapperPath, "utf-8")).toContain("SIGNET-CODEX-FALLBACK");
		expect(readFileSync(watcherPath, "utf-8")).toContain("SIGNET-CODEX-FALLBACK");
	});

	test("does not replace a non-Signet codex wrapper", async () => {
		writeFileSync(wrapperPath, "#!/bin/zsh\necho user-wrapper\n", "utf-8");

		const result = await connector().install(tempHome);

		expect(readFileSync(wrapperPath, "utf-8")).toContain("user-wrapper");
		expect(result.warnings).toContain(`Skipped installing Codex wrapper at ${wrapperPath} — existing file is not Signet-managed`);
		expect(readFileSync(watcherPath, "utf-8")).toContain("SIGNET-CODEX-FALLBACK");
	});

	test("uninstall removes Signet-managed wrapper files", async () => {
		await connector().install(tempHome);

		const result = await connector().uninstall();

		expect(result.filesRemoved).toContain(wrapperPath);
		expect(result.filesRemoved).toContain(watcherPath);
		expect(existsSync(wrapperPath)).toBe(false);
		expect(existsSync(watcherPath)).toBe(false);
	});
});

describe("CodexConnector.uninstall — config.toml cleanup", () => {
	test("removes signet section from config.toml", async () => {
		const c = connector();
		await c.install(tempHome);
		expect(readFileSync(configPath, "utf-8")).toContain("[mcp_servers.signet]");

		await c.uninstall();

		expect(existsSync(configPath)).toBe(true);
		expect(readFileSync(configPath, "utf-8")).not.toContain("[mcp_servers.signet]");
	});

	test("preserves other sections when removing signet entry", async () => {
		writeFileSync(configPath, '[model]\nname = "gpt-4o"\n');
		const c = connector();
		await c.install(tempHome);
		await c.uninstall();

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("[model]");
		expect(content).not.toContain("[mcp_servers.signet]");
	});

	test("handles multi-line TOML args without corrupting surrounding sections (regression: unpatchConfigToml)", async () => {
		// A user who hand-edited args to multi-line form would have had
		// continuation lines left in the file by the old section-end detection.
		writeFileSync(
			configPath,
			[
				"[other]",
				"key = 'val'",
				"",
				"# Signet MCP server",
				"[mcp_servers.signet]",
				"command = 'signet-mcp'",
				"args = [",
				"  '--verbose'",
				"]",
				"",
				"[after]",
				"key = 'val'",
				"",
			].join("\n"),
		);

		const c = connector();
		await c.uninstall();

		const content = readFileSync(configPath, "utf-8");
		expect(content).not.toContain("[mcp_servers.signet]");
		// Continuation lines must not leak into the output
		expect(content).not.toContain("--verbose");
		expect(content).toContain("[other]");
		expect(content).toContain("[after]");
	});
});

// buildMcpBlock is tested directly here because resolveSignetMcp() always
// returns the non-Windows path on Linux, so Windows quoting can't be
// exercised through install().
describe("buildMcpBlock — TOML quoting", () => {
	test("produces string command, not array", () => {
		const block = buildMcpBlock({ command: "signet-mcp", args: [] });
		expect(block).toContain("command = 'signet-mcp'");
		expect(block).not.toContain("command = [");
	});

	test("Windows paths with backslashes are quoted correctly", () => {
		const block = buildMcpBlock({
			command: "C:\\Program Files\\node.exe",
			args: ["C:\\signet\\mcp-stdio.js"],
		});
		// No single-quote in the path, so literal single-quote TOML strings are used
		expect(block).toContain("command = 'C:\\Program Files\\node.exe'");
		expect(block).toContain("args = ['C:\\signet\\mcp-stdio.js']");
		expect(block).not.toContain("command = [");
	});

	test("omits args line when args is empty", () => {
		const block = buildMcpBlock({ command: "signet-mcp", args: [] });
		expect(block).not.toContain("args");
	});

	test("includes args line when args are present", () => {
		const block = buildMcpBlock({ command: "node", args: ["mcp.js", "--port", "3000"] });
		expect(block).toContain("args = ['mcp.js', '--port', '3000']");
	});
});
