import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseConnector, type InstallResult, type UninstallResult, atomicWriteJson } from "@signet/connector-base";
import { expandHome } from "@signet/core";

// ---------------------------------------------------------------------------
// Signet command resolution
// ---------------------------------------------------------------------------

function resolvePackagedBin(relativePaths: string[]): string | null {
	const entry = process.argv[1] || "";
	if (!entry) return null;
	for (const relativePath of relativePaths) {
		const candidate = join(entry, "..", "..", relativePath);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function findPathExecutable(name: string, excludeDirs: string[] = []): string | null {
	const pathValue = process.env.PATH || "";
	for (const dir of pathValue.split(":")) {
		if (!dir || excludeDirs.includes(dir)) continue;
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function shellDoubleQuote(value: string): string {
	return `"${value.replace(/"/g, '\\"')}"`;
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/** Resolve signet command for hook invocation. hooks.json only supports a command string,
 *  so keep the longstanding non-Windows "signet" path and only use the packaged absolute
 *  entrypoint on Windows where PATH lookup is the historical failure mode. */
function resolveSignetCommand(): string {
	if (process.platform !== "win32") return "signet";
	const signetJs = resolvePackagedBin(["bin/signet.js"]);
	if (signetJs) return `${shellDoubleQuote(process.execPath)} ${shellDoubleQuote(signetJs)}`;
	return "signet";
}

/** Resolve signet-mcp as { command, args } for Codex config.toml.
 *  Codex expects `command` as a string and `args` as a separate array. */
function resolveSignetMcp(): { command: string; args: string[] } {
	if (process.platform !== "win32") return { command: "signet-mcp", args: [] };
	const mcpJs = resolvePackagedBin(["dist/mcp-stdio.js", "bin/mcp-stdio.js"]);
	if (mcpJs) return { command: process.execPath, args: [mcpJs] };
	return { command: "signet-mcp", args: [] };
}

const WRAPPER_MARKER = "SIGNET-CODEX-FALLBACK";
const WRAPPER_LOG_SOURCE = "codex-wrapper-fallback";

function buildWatcherScript(): string {
	return `#!/usr/bin/env node
// ${WRAPPER_MARKER}

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const project = process.argv[2];
const launchMs = Number(process.argv[3] || Date.now());
const signetWorkspace = process.argv[4] || path.join(os.homedir(), ".agents");
if (!project) process.exit(1);

const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
const logDir = path.join(signetWorkspace, ".daemon", "logs");

let watchedFile = null;
let lineCount = 0;

function walk(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, results);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) results.push(full);
  }
  return results;
}

function latestSessionFile() {
  const files = walk(sessionsRoot);
  let best = null;
  let bestMtime = -1;
  for (const file of files) {
    const stat = fs.statSync(file);
    if (stat.mtimeMs + 1000 < launchMs) continue;
    try {
      const firstLine = fs.readFileSync(file, "utf8").split("\\n", 1)[0];
      const record = JSON.parse(firstLine);
      const startedAt = Date.parse(record?.payload?.timestamp || "");
      if (!Number.isFinite(startedAt) || startedAt + 1000 < launchMs) continue;
    } catch {
      continue;
    }
    if (stat.mtimeMs > bestMtime) {
      best = file;
      bestMtime = stat.mtimeMs;
    }
  }
  return best;
}

function appendDaemonLog(message, extra = {}) {
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString();
  const file = path.join(logDir, \`signet-\${stamp.slice(0, 10)}.log\`);
  const line = {
    timestamp: stamp,
    level: "info",
    category: "hooks",
    message,
    data: {
      harness: "codex",
      project,
      source: "${WRAPPER_LOG_SOURCE}",
      nativeHooks: false,
      ...extra,
    },
  };
  fs.appendFileSync(file, \`\${JSON.stringify(line)}\\n\`);
}

function extractPrompt(record) {
  if (record?.type !== "response_item") return null;
  const payload = record.payload;
  if (payload?.type !== "message" || payload?.role !== "user") return null;
  const texts = [];
  for (const item of payload.content || []) {
    if (item?.type === "input_text" && typeof item.text === "string") texts.push(item.text);
  }
  if (texts.length === 0) return null;
  const text = texts.join("\\n").trim();
  if (!text) return null;
  if (text.includes("<INSTRUCTIONS>")) return null;
  if (text.startsWith("<environment_context>")) return null;
  return text;
}

function emitPromptHook(prompt) {
  appendDaemonLog("Codex native prompt hook unavailable — using wrapper fallback", { prompt });
  spawnSync("signet", ["hook", "user-prompt-submit", "-H", "codex", "--project", project], {
    input: JSON.stringify({ cwd: project, prompt, userMessage: prompt }),
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 8000,
  });
}

function poll() {
  if (!watchedFile) {
    watchedFile = latestSessionFile();
    if (!watchedFile) return;
  }

  let content;
  try {
    content = fs.readFileSync(watchedFile, "utf8");
  } catch {
    return;
  }

  const lines = content.split("\\n").filter(Boolean);
  if (lines.length <= lineCount) return;
  for (const line of lines.slice(lineCount)) {
    try {
      const record = JSON.parse(line);
      const prompt = extractPrompt(record);
      if (prompt) emitPromptHook(prompt);
    } catch {
      // Ignore malformed lines while the file is still being written.
    }
  }
  lineCount = lines.length;
}

setInterval(poll, 250);

process.on("SIGTERM", () => {
  poll();
  process.exit(0);
});

process.on("SIGINT", () => {
  poll();
  process.exit(0);
});
`;
}

function buildCodexWrapperScript(realCodexPath: string, watcherPath: string): string {
	return `#!/bin/zsh

set -euo pipefail

readonly REAL_CODEX=${shellSingleQuote(realCodexPath)}
readonly WATCHER_BIN=${shellSingleQuote(watcherPath)}
readonly SIGNET_WORKSPACE="\${SIGNET_WORKSPACE:-$HOME/.agents}"
readonly MARKER_START="<!-- ${WRAPPER_MARKER}:START -->"
readonly MARKER_END="<!-- ${WRAPPER_MARKER}:END -->"
readonly SIGNET_LOG_DIR="$SIGNET_WORKSPACE/.daemon/logs"

json_escape() {
  local value="$1"
  value="\${value//\\/\\\\}"
  value="\${value//\"/\\\"}"
  value="\${value//$'\\n'/\\n}"
  value="\${value//$'\\r'/\\r}"
  value="\${value//$'\\t'/\\t}"
  printf '%s' "$value"
}

daemon_log_path() {
  printf '%s/signet-%s.log\\n' "$SIGNET_LOG_DIR" "$(date +%F)"
}

append_daemon_log() {
  local message="$1"
  local project="$2"
  local log_path payload message_json project_json

  message_json="$(json_escape "$message")"
  project_json="$(json_escape "$project")"

  mkdir -p "$SIGNET_LOG_DIR"
  log_path="$(daemon_log_path)"
  payload="$(printf '{"timestamp":"%s","level":"info","category":"hooks","message":"%s","data":{"harness":"codex","project":"%s","source":"${WRAPPER_LOG_SOURCE}","nativeHooks":false}}' \\
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\
    "$message_json" \\
    "$project_json")"
  printf '%s\\n' "$payload" >>"$log_path"
}

trigger_session_start() {
  local project="$1"

  append_daemon_log "Codex native hooks unavailable — using wrapper fallback" "$project"
  signet hook session-start -H codex --project "$project" >/dev/null 2>/dev/null || true
}

trigger_session_end() {
  local project="$1"

  append_daemon_log "Codex native stop hook unavailable — using wrapper fallback" "$project"
  signet hook session-end -H codex >/dev/null 2>/dev/null || true
}

workspace_root() {
  local root
  if root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    printf '%s\\n' "$root"
  else
    pwd
  fi
}

compose_block() {
  local source content

  printf '%s\\n' "$MARKER_START"
  printf '%s\\n\\n' "# Signet Codex Fallback"
  printf '%s\\n\\n' "This block is generated by the local Signet Codex wrapper because Codex native hooks are unreliable on this machine."
  printf '%s\\n\\n' "Treat the following content as your persistent identity baseline for this session."

  for source in AGENTS.md SOUL.md IDENTITY.md USER.md MEMORY.md; do
    if [[ ! -f "$SIGNET_WORKSPACE/$source" ]]; then
      continue
    fi
    content="$(<"$SIGNET_WORKSPACE/$source")"
    content="\${content%"\${content##*[!$'\\n']}"}"
    if [[ -z "$content" ]]; then
      continue
    fi
    printf '%s\\n\\n' "## $source"
    printf '%s\\n\\n' "$content"
  done

  printf '%s\\n' "$MARKER_END"
}

ensure_git_ignored() {
  local root="$1"
  local exclude

  if [[ ! -d "$root/.git" ]]; then
    return 0
  fi

  if git -C "$root" ls-files --error-unmatch AGENTS.md >/dev/null 2>&1; then
    return 0
  fi

  exclude="$root/.git/info/exclude"
  mkdir -p "\${exclude:h}"
  touch "$exclude"
  if ! grep -Fxq "AGENTS.md" "$exclude"; then
    printf '\\n# Signet Codex fallback\\nAGENTS.md\\n' >>"$exclude"
  fi
}

sync_agents_file() {
  local root="$1"
  local target="$root/AGENTS.md"
  local block existing

  block="$(compose_block)"

  if [[ ! -f "$target" ]]; then
    printf '%s\\n' "$block" >"$target"
    ensure_git_ignored "$root"
    return 0
  fi

  existing="$(<"$target")"

  if [[ "$existing" == *"$MARKER_START"* && "$existing" == *"$MARKER_END"* ]]; then
    existing="\${existing%%$MARKER_START*}"
    existing="\${existing%"\${existing##*[!$'\\n']}"}"
    if [[ -n "$existing" ]]; then
      printf '%s\\n\\n%s\\n' "$existing" "$block" >"$target"
    else
      printf '%s\\n' "$block" >"$target"
    fi
    ensure_git_ignored "$root"
    return 0
  fi

  if git -C "$root" rev-parse --show-toplevel >/dev/null 2>&1; then
    if git -C "$root" ls-files --error-unmatch AGENTS.md >/dev/null 2>&1; then
      append_daemon_log "Signet fallback AGENTS sync skipped — repository already tracks AGENTS.md" "$root"
      return 0
    fi
  fi

  append_daemon_log "Signet fallback AGENTS sync skipped — existing AGENTS.md is not Signet-managed" "$root"
}

main() {
  local root launch_ms watcher_pid child_pid exit_code
  root="$(workspace_root)"
  launch_ms="$(( $(date +%s) * 1000 ))"

  if [[ -d "$SIGNET_WORKSPACE" ]]; then
    sync_agents_file "$root"
  fi

  trigger_session_start "$root"
  if [[ -x "$WATCHER_BIN" ]]; then
    "$WATCHER_BIN" "$root" "$launch_ms" "$SIGNET_WORKSPACE" >/dev/null 2>/dev/null &
    watcher_pid=$!
  else
    watcher_pid=""
  fi

  "$REAL_CODEX" "$@" &
  child_pid=$!
  trap 'kill -TERM "$child_pid" >/dev/null 2>&1 || true' INT TERM
  wait "$child_pid"
  exit_code=$?

  if [[ -n "\${watcher_pid:-}" ]]; then
    sleep 1
    kill -TERM "$watcher_pid" >/dev/null 2>&1 || true
    wait "$watcher_pid" >/dev/null 2>&1 || true
  fi

  trigger_session_end "$root"
  exit "$exit_code"
}

main "$@"
`;
}

// ---------------------------------------------------------------------------
// hooks.json management
// ---------------------------------------------------------------------------

interface HooksJson {
	_signet?: boolean;
	SessionStart?: unknown[];
	UserPromptSubmit?: unknown[];
	Stop?: unknown[];
	[key: string]: unknown;
}

function buildHooksJson(signetCommand: string): HooksJson {
	return {
		_signet: true,
		SessionStart: [
			{
				hooks: [
					{
						type: "command",
						command: `${signetCommand} hook session-start -H codex`,
						timeout: 10,
					},
				],
			},
		],
		UserPromptSubmit: [
			{
				hooks: [
					{
						type: "command",
						command: `${signetCommand} hook user-prompt-submit -H codex`,
						timeout: 5,
					},
				],
			},
		],
		Stop: [
			{
				hooks: [
					{
						type: "command",
						command: `${signetCommand} hook session-end -H codex`,
						timeout: 30,
					},
				],
			},
		],
	};
}

function readHooksJson(path: string): HooksJson | null {
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as HooksJson;
	} catch {
		return null;
	}
}

function isSignetOwned(hooks: HooksJson): boolean {
	return hooks._signet === true;
}

function writeHooksJson(path: string, hooks: HooksJson): void {
	mkdirSync(join(path, ".."), { recursive: true });
	atomicWriteJson(path, hooks);
}

const SIGNET_HOOK_CMDS = ["hook session-start", "hook user-prompt-submit", "hook session-end"] as const;

function isSignetHandler(entry: unknown): boolean {
	if (typeof entry !== "object" || entry === null) return false;
	const hooks = (entry as Record<string, unknown>).hooks;
	if (Array.isArray(hooks)) {
		for (const hook of hooks) {
			if (typeof hook !== "object" || hook === null) continue;
			const cmd = (hook as Record<string, unknown>).command;
			if (typeof cmd === "string" && SIGNET_HOOK_CMDS.some((s) => cmd.includes(s))) return true;
		}
	}
	const handlers = (entry as Record<string, unknown>).handlers;
	if (Array.isArray(handlers)) {
		for (const handler of handlers) {
			if (typeof handler !== "object" || handler === null) continue;
			const cmd = (handler as Record<string, unknown>).command;
			if (Array.isArray(cmd)) {
				const joined = cmd.join(" ");
				if (SIGNET_HOOK_CMDS.some((s) => joined.includes(s))) return true;
			}
		}
	}
	return false;
}

function removeSignetHooks(hooks: HooksJson): HooksJson {
	const cleaned = { ...hooks };
	for (const key of ["SessionStart", "UserPromptSubmit", "Stop", "sessionStart", "userPromptSubmit", "stop"] as const) {
		if (!Array.isArray(cleaned[key])) continue;
		const filtered = (cleaned[key] as unknown[]).filter((e) => !isSignetHandler(e));
		if (filtered.length === 0) {
			delete cleaned[key];
		} else {
			cleaned[key] = filtered;
		}
	}
	// Only remove marker if no Signet entries remain
	const hasSignet = ["SessionStart", "UserPromptSubmit", "Stop", "sessionStart", "userPromptSubmit", "stop"].some(
		(k) => Array.isArray(cleaned[k]) && (cleaned[k] as unknown[]).some(isSignetHandler),
	);
	if (!hasSignet) delete cleaned._signet;
	return cleaned;
}

// ---------------------------------------------------------------------------
// MCP server registration (config.toml)
// ---------------------------------------------------------------------------

function tomlQuote(s: string): string {
	// Use TOML literal strings (single-quoted) to avoid backslash escaping
	if (!s.includes("'")) return `'${s}'`;
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

function tomlInlineArray(items: string[]): string {
	return `[${items.map(tomlQuote).join(", ")}]`;
}

export function buildMcpBlock(mcp: { command: string; args: string[] }): string {
	let block = `# Signet MCP server\n[mcp_servers.signet]\ncommand = ${tomlQuote(mcp.command)}\n`;
	if (mcp.args.length > 0) {
		block += `args = ${tomlInlineArray(mcp.args)}\n`;
	}
	return block;
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

function unpatchConfigToml(path: string): boolean {
	if (!existsSync(path)) return false;
	const content = readFileSync(path, "utf-8");
	if (!content.includes("[mcp_servers.signet]")) return false;

	// Remove the signet MCP block — handles both with and without comment
	const lines = content.split("\n");
	const filtered: string[] = [];
	let inSection = false;
	for (const line of lines) {
		if (line.trim() === "# Signet MCP server") continue;
		if (line.trim() === "[mcp_servers.signet]") {
			inSection = true;
			continue;
		}
		// Skip all lines belonging to the signet section until next header
		if (inSection) {
			if (line.match(/^\[/)) inSection = false;
			else continue;
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

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class CodexConnector extends BaseConnector {
	readonly name = "Codex";
	readonly harnessId = "codex";

	protected getCodexHome(): string {
		return join(homedir(), ".codex");
	}

	private getHooksJsonPath(): string {
		return join(this.getCodexHome(), "hooks.json");
	}

	getConfigPath(): string {
		return join(this.getCodexHome(), "config.toml");
	}

	protected getLocalBinDir(): string {
		return join(homedir(), ".local", "bin");
	}

	protected getCodexWrapperPath(): string {
		return join(this.getLocalBinDir(), "codex");
	}

	protected getCodexWatcherPath(): string {
		return join(this.getLocalBinDir(), "codex-signet-watch.js");
	}

	private isManagedWrapper(path: string): boolean {
		if (!existsSync(path)) return false;
		return readFileSync(path, "utf-8").includes(WRAPPER_MARKER);
	}

	private installWrapperFiles(filesWritten: string[], warnings: string[]): void {
		const localBinDir = this.getLocalBinDir();
		const wrapperPath = this.getCodexWrapperPath();
		const watcherPath = this.getCodexWatcherPath();
		const realCodexPath = findPathExecutable("codex", [localBinDir]) || "codex";

		mkdirSync(localBinDir, { recursive: true });

		if (existsSync(wrapperPath) && !this.isManagedWrapper(wrapperPath)) {
			warnings.push(`Skipped installing Codex wrapper at ${wrapperPath} — existing file is not Signet-managed`);
		} else {
			writeFileSync(wrapperPath, buildCodexWrapperScript(realCodexPath, watcherPath), "utf-8");
			chmodSync(wrapperPath, 0o755);
			filesWritten.push(wrapperPath);
		}

		if (existsSync(watcherPath) && !this.isManagedWrapper(watcherPath)) {
			warnings.push(`Skipped installing Codex watcher at ${watcherPath} — existing file is not Signet-managed`);
		} else {
			writeFileSync(watcherPath, buildWatcherScript(), "utf-8");
			chmodSync(watcherPath, 0o755);
			filesWritten.push(watcherPath);
		}
	}

	private uninstallWrapperFiles(filesRemoved: string[]): void {
		for (const path of [this.getCodexWrapperPath(), this.getCodexWatcherPath()]) {
			if (!existsSync(path) || !this.isManagedWrapper(path)) continue;
			rmSync(path, { force: true });
			filesRemoved.push(path);
		}
	}

	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const configsPatched: string[] = [];
		const warnings: string[] = [];
		const expandedBasePath = expandHome(basePath || join(homedir(), ".agents"));
		const strippedAgentsPath = this.stripLegacySignetBlock(expandedBasePath);
		if (strippedAgentsPath !== null) {
			filesWritten.push(strippedAgentsPath);
		}

		const codexHome = this.getCodexHome();
		mkdirSync(codexHome, { recursive: true });

		const signetCommand = resolveSignetCommand();

		// 1. Install hooks.json (native Codex hook system)
		const hooksPath = this.getHooksJsonPath();
		const existing = readHooksJson(hooksPath);

		if (existing && !isSignetOwned(existing)) {
			// User has their own hooks.json — merge Signet hooks in
			const signetHooks = buildHooksJson(signetCommand);
			const merged: HooksJson = { ...existing };
			merged._signet = true;
			for (const key of ["SessionStart", "UserPromptSubmit", "Stop"] as const) {
				const current = Array.isArray(merged[key]) ? (merged[key] as unknown[]) : [];
				const signet = signetHooks[key] as unknown[];
				merged[key] = [...current, ...signet];
			}
			writeHooksJson(hooksPath, merged);
			warnings.push("Merged Signet hooks into existing hooks.json — existing hooks preserved");
		} else {
			writeHooksJson(hooksPath, buildHooksJson(signetCommand));
		}
		filesWritten.push(hooksPath);

		// 2. Symlink skills directory
		const skillsResult = this.symlinkSkills(expandedBasePath, codexHome);
		if (!skillsResult) {
			warnings.push("Failed to symlink skills directory");
		}

		// 3. Register MCP server in config.toml
		const mcp = resolveSignetMcp();
		if (patchConfigToml(this.getConfigPath(), mcp)) {
			configsPatched.push(this.getConfigPath());
		}

		// 4. Install wrapper fallback for Codex builds that skip native hooks.
		this.installWrapperFiles(filesWritten, warnings);

		return {
			success: true,
			message: "Codex integration installed — native hooks + MCP server + wrapper fallback",
			filesWritten,
			configsPatched,
			warnings,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		const configsPatched: string[] = [];

		// 1. Remove hooks.json (or clean Signet entries from merged file)
		const hooksPath = this.getHooksJsonPath();
		const existing = readHooksJson(hooksPath);
		if (existing) {
			// Check marker first; fall back to handler scan if marker was stripped
			const hasMarker = isSignetOwned(existing);
			const hasHandlers = ["SessionStart", "UserPromptSubmit", "Stop", "sessionStart", "userPromptSubmit", "stop"].some(
				(k) =>
					Array.isArray((existing as Record<string, unknown>)[k]) &&
					((existing as Record<string, unknown>)[k] as unknown[]).some(isSignetHandler),
			);
			if (hasMarker || hasHandlers) {
				const cleaned = removeSignetHooks(existing);
				const remaining = Object.keys(cleaned).filter((k) => k !== "_signet");
				if (remaining.length === 0) {
					rmSync(hooksPath, { force: true });
					filesRemoved.push(hooksPath);
				} else {
					writeHooksJson(hooksPath, cleaned);
					configsPatched.push(hooksPath);
				}
			}
		}

		// 2. Remove skills symlink
		const skillsLink = join(this.getCodexHome(), "skills");
		if (existsSync(skillsLink)) {
			rmSync(skillsLink, { force: true });
			filesRemoved.push(skillsLink);
		}

		// 3. Remove MCP server from config.toml
		if (unpatchConfigToml(this.getConfigPath())) {
			configsPatched.push(this.getConfigPath());
		}

		// 4. Remove Signet-managed fallback wrapper files.
		this.uninstallWrapperFiles(filesRemoved);

		return { filesRemoved, configsPatched };
	}

	isInstalled(): boolean {
		const hooks = readHooksJson(this.getHooksJsonPath());
		if (!hooks) return false;
		return ["SessionStart", "UserPromptSubmit", "Stop", "sessionStart", "userPromptSubmit", "stop"].some(
			(k) =>
				Array.isArray((hooks as Record<string, unknown>)[k]) &&
				((hooks as Record<string, unknown>)[k] as unknown[]).some(isSignetHandler),
		);
	}
}
