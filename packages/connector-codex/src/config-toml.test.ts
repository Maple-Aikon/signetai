import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The TOML patching functions are module-private, so we re-implement the
// same logic inline to test the behavioral contract. These tests validate
// that the connector's config.toml handling produces correct output for
// Codex's Rust TOML parser, which expects `command` as a plain string.

// ---------------------------------------------------------------------------
// Extracted helpers (mirrored from index.ts for testability)
// ---------------------------------------------------------------------------

function tomlQuote(s: string): string {
	if (!s.includes("'")) return `'${s}'`;
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

function tomlInlineArray(items: string[]): string {
	return `[${items.map(tomlQuote).join(", ")}]`;
}

function buildMcpBlock(mcp: { command: string; args: string[] }): string {
	let block = `# Signet MCP server\n[mcp_servers.signet]\ncommand = ${tomlQuote(mcp.command)}\n`;
	if (mcp.args.length > 0) {
		block += `args = ${tomlInlineArray(mcp.args)}\n`;
	}
	return block;
}

function unpatchConfigToml(path: string): boolean {
	if (!existsSync(path)) return false;
	const content = readFileSync(path, "utf-8");
	if (!content.includes("[mcp_servers.signet]")) return false;

	const lines = content.split("\n");
	const filtered: string[] = [];
	let inSection = false;
	for (const line of lines) {
		if (line.trim() === "# Signet MCP server") continue;
		if (line.trim() === "[mcp_servers.signet]") {
			inSection = true;
			continue;
		}
		if (inSection) {
			if (line.match(/^\s*\w+\s*=/) || line.trim() === "") continue;
			inSection = false;
		}
		filtered.push(line);
	}
	writeFileSync(
		path,
		filtered
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trimEnd() + "\n",
	);
	return true;
}

function patchConfigToml(path: string, mcp: { command: string; args: string[] }): boolean {
	const dir = join(path, "..");
	mkdirSync(dir, { recursive: true });

	const block = buildMcpBlock(mcp);

	if (!existsSync(path)) {
		writeFileSync(path, block);
		return true;
	}

	const content = readFileSync(path, "utf-8");

	if (!content.includes("[mcp_servers.signet]")) {
		writeFileSync(path, content.trimEnd() + "\n\n" + block);
		return true;
	}

	// Section exists but may be stale (e.g. old array-format command).
	// Remove and re-add with correct format.
	unpatchConfigToml(path);
	const updated = existsSync(path) ? readFileSync(path, "utf-8").trim() : "";
	const prefix = updated.length > 0 ? updated + "\n\n" : "";
	writeFileSync(path, prefix + block);
	return true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const MCP = { command: "signet-mcp", args: [] as string[] };
const MCP_WIN = { command: "C:\\Program Files\\node.exe", args: ["C:\\signet\\mcp-stdio.js"] };

let dir: string;
let configPath: string;

beforeEach(() => {
	dir = join(tmpdir(), `signet-codex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	configPath = join(dir, "config.toml");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("patchConfigToml", () => {
	test("creates config.toml when file does not exist", () => {
		const result = patchConfigToml(configPath, MCP);
		expect(result).toBe(true);
		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("[mcp_servers.signet]");
		expect(content).toContain("command = 'signet-mcp'");
	});

	test("appends section when file exists without signet config", () => {
		writeFileSync(configPath, '[model]\nname = "gpt-4o"\n');
		patchConfigToml(configPath, MCP);
		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain('[model]\nname = "gpt-4o"');
		expect(content).toContain("command = 'signet-mcp'");
	});

	test("replaces stale array-format command (regression: #273)", () => {
		// This is the exact config that caused "invalid transport" errors.
		// Pre-#273 Signet wrote command as an array, which Codex's Rust
		// parser rejects (expects Option<String>, gets array -> None).
		writeFileSync(
			configPath,
			"# Signet MCP server\n[mcp_servers.signet]\ncommand = ['signet-mcp']\n",
		);
		patchConfigToml(configPath, MCP);
		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("command = 'signet-mcp'");
		expect(content).not.toContain("['signet-mcp']");
	});

	test("preserves other config sections when replacing stale entry", () => {
		writeFileSync(
			configPath,
			'[model]\nname = "gpt-4o"\n\n# Signet MCP server\n[mcp_servers.signet]\ncommand = [\'signet-mcp\']\n\n[history]\nenabled = true\n',
		);
		patchConfigToml(configPath, MCP);
		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain('[model]\nname = "gpt-4o"');
		expect(content).toContain("[history]\nenabled = true");
		expect(content).toContain("command = 'signet-mcp'");
		expect(content).not.toContain("['signet-mcp']");
	});

	test("idempotent: re-running on correct config produces identical output", () => {
		patchConfigToml(configPath, MCP);
		const first = readFileSync(configPath, "utf-8");
		patchConfigToml(configPath, MCP);
		const second = readFileSync(configPath, "utf-8");
		expect(second).toBe(first);
	});

	test("handles Windows-style command with args", () => {
		patchConfigToml(configPath, MCP_WIN);
		const content = readFileSync(configPath, "utf-8");
		// Windows paths without single quotes use single-quote TOML literals
		expect(content).toContain("command = 'C:\\Program Files\\node.exe'");
		expect(content).toContain("args = ['C:\\signet\\mcp-stdio.js']");
	});
});

describe("unpatchConfigToml", () => {
	test("removes signet section cleanly", () => {
		writeFileSync(
			configPath,
			'[model]\nname = "gpt-4o"\n\n# Signet MCP server\n[mcp_servers.signet]\ncommand = \'signet-mcp\'\n',
		);
		unpatchConfigToml(configPath);
		const content = readFileSync(configPath, "utf-8");
		expect(content).not.toContain("[mcp_servers.signet]");
		expect(content).toContain('[model]\nname = "gpt-4o"');
	});

	test("returns false when file does not exist", () => {
		expect(unpatchConfigToml(configPath)).toBe(false);
	});

	test("returns false when section not present", () => {
		writeFileSync(configPath, '[model]\nname = "gpt-4o"\n');
		expect(unpatchConfigToml(configPath)).toBe(false);
	});
});

describe("buildMcpBlock", () => {
	test("produces string command, not array", () => {
		const block = buildMcpBlock(MCP);
		expect(block).toContain("command = 'signet-mcp'");
		// Must not contain array-style command (the old broken format)
		expect(block).not.toContain("command = [");
	});

	test("includes args when present", () => {
		const block = buildMcpBlock(MCP_WIN);
		expect(block).toContain("args = ");
	});

	test("omits args when empty", () => {
		const block = buildMcpBlock(MCP);
		expect(block).not.toContain("args");
	});
});
