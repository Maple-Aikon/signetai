import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseConnector, type InstallResult, type UninstallResult } from "@signet/connector-base";

const SHELL_BLOCK_START = "# >>> signet codex >>>";
const SHELL_BLOCK_END = "# <<< signet codex <<<";
const SHELL_BLOCK = `${SHELL_BLOCK_START}
if [ -d "$HOME/.config/signet/bin" ]; then
	case ":$PATH:" in
		*":$HOME/.config/signet/bin:"*) ;;
		*) export PATH="$HOME/.config/signet/bin:$PATH" ;;
	esac
fi
${SHELL_BLOCK_END}
`;

const TOML_COMMENT = "# Added by Signet — points to generated identity file";

function stripBlock(content: string): string {
	const start = content.indexOf(SHELL_BLOCK_START);
	if (start < 0) return content;
	const end = content.indexOf(SHELL_BLOCK_END, start);
	if (end < 0) return content;
	const after = content.slice(end + SHELL_BLOCK_END.length);
	const before = content.slice(0, start).trimEnd();
	return `${`${before}${before ? "\n\n" : ""}${after.trimStart()}`.trimEnd()}\n`;
}

function appendBlock(content: string): string {
	const stripped = stripBlock(content).trimEnd();
	return `${stripped}${stripped ? "\n\n" : ""}${SHELL_BLOCK}`;
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildWrapper(realCodexBin: string): string {
	return `#!/bin/sh
set -eu

REAL_CODEX_BIN=${shellSingleQuote(realCodexBin)}
SIGNET_BIN="\${SIGNET_CODEX_SIGNET_BIN:-signet}"
SESSION_ROOT="\${HOME}/.codex/sessions"
TMP_ROOT="\${TMPDIR:-/tmp}/signet-codex-\$\$"
SESSION_KEY=""
START_MARKER=""
INSTRUCTIONS_FILE=""

cleanup() {
	rm -rf "$TMP_ROOT"
}

# Escape a string for embedding in a JSON value (backslash, double-quote, newlines)
json_escape() {
	printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e 's/	/\\\\t/g' | tr '\\n' ' '
}

session_start() {
	mkdir -p "$TMP_ROOT"
	START_MARKER="$TMP_ROOT/start.marker"
	INSTRUCTIONS_FILE="$TMP_ROOT/model-instructions.md"
	: > "$START_MARKER"
	SESSION_KEY="$(uuidgen 2>/dev/null || printf "codex-%s-%s" "$(date +%s)" "$$")"

	# Start with persistent identity context if available
	CODEX_MD="\${HOME}/.codex/CODEX.md"
	if [ -f "$CODEX_MD" ]; then
		cp "$CODEX_MD" "$INSTRUCTIONS_FILE"
		printf '\\n\\n---\\n\\n' >> "$INSTRUCTIONS_FILE"
	fi

	# Append dynamic session context (live memories, recall results)
	DYNAMIC="$TMP_ROOT/dynamic.md"
	payload="$(printf '{"session_id":"%s","cwd":"%s"}' "$(json_escape "$SESSION_KEY")" "$(json_escape "$PWD")")"
	if printf "%s" "$payload" | "$SIGNET_BIN" hook session-start -H codex --project "$PWD" > "$DYNAMIC" 2>/dev/null; then
		if [ -s "$DYNAMIC" ]; then
			cat "$DYNAMIC" >> "$INSTRUCTIONS_FILE"
		fi
	fi

	# If nothing was written at all, clear
	if [ ! -s "$INSTRUCTIONS_FILE" ]; then
		rm -f "$INSTRUCTIONS_FILE"
		INSTRUCTIONS_FILE=""
	fi

	# Append live recall instruction only when there is real content
	if [ -n "$INSTRUCTIONS_FILE" ] && [ -s "$INSTRUCTIONS_FILE" ]; then
		cat >> "$INSTRUCTIONS_FILE" << 'LIVE_RECALL'

## Live Memory (Auto-Updated by Signet)

IMPORTANT: Before responding to each user message, read the file at
~/.codex/.signet-live-context.md — it contains memories recalled by
Signet that are relevant to the current conversation. This file is
updated after each user message. If the file exists and has content,
incorporate any relevant memories into your response. The file includes
a timestamp — ignore it if older than 60 seconds.
LIVE_RECALL
	fi
}

find_session_file() {
	if [ ! -d "$SESSION_ROOT" ] || [ -z "$START_MARKER" ] || [ ! -f "$START_MARKER" ]; then
		return 0
	fi

	find "$SESSION_ROOT" -type f -name '*.jsonl' -newer "$START_MARKER" 2>/dev/null | sort | tail -n 1
}

session_end() {
	if [ -z "$SESSION_KEY" ]; then
		return 0
	fi

	TRANSCRIPT_PATH="$(find_session_file)"
	payload="$(printf '{"session_id":"%s","transcript_path":"%s","cwd":"%s"}' "$(json_escape "$SESSION_KEY")" "$(json_escape "$TRANSCRIPT_PATH")" "$(json_escape "$PWD")")"
	printf "%s" "$payload" | "$SIGNET_BIN" hook session-end -H codex >/dev/null 2>&1 || true
}

if [ "\${SIGNET_NO_HOOKS:-}" = "1" ] || [ "\${SIGNET_CODEX_BYPASS_WRAPPER:-}" = "1" ]; then
	exec "$REAL_CODEX_BIN" "$@"
fi

if [ ! -x "$REAL_CODEX_BIN" ]; then
	echo "[signet] codex wrapper could not find real binary at $REAL_CODEX_BIN" >&2
	exit 1
fi

trap 'cleanup' EXIT

session_start

# Register for live recall watching (interactive mode only, not codex exec)
case "\${1:-}" in
	exec) ;;
	*)
		printf '{"sessionKey":"%s","project":"%s"}' "$(json_escape "$SESSION_KEY")" "$(json_escape "$PWD")" | "$SIGNET_BIN" hook codex-watch-start -H codex >/dev/null 2>&1 &
		;;
esac

set +e
if [ -n "$INSTRUCTIONS_FILE" ]; then
	"$REAL_CODEX_BIN" -c "model_instructions_file=$INSTRUCTIONS_FILE" "$@"
else
	"$REAL_CODEX_BIN" "$@"
fi
EXIT_CODE=$?
set -e

session_end
exit "$EXIT_CODE"
`;
}

/**
 * Build a Windows .cmd wrapper that mirrors the Unix shell wrapper above.
 *
 * Design notes:
 * - JSON payloads are built via PowerShell's ConvertTo-Json to safely escape
 *   special characters (", &, |, %) that would break raw cmd echo piping.
 * - Environment variables set with `set` inside `setlocal` are inherited by
 *   child PowerShell processes and accessed via $env: — this avoids double-
 *   expansion pitfalls in cmd's string interpolation.
 * - All PowerShell invocations use -NoProfile -ErrorAction SilentlyContinue
 *   to suppress stderr noise and prevent profile scripts from interfering.
 * - Session-start/end hooks match the Unix wrapper's behavior: generate a
 *   session key, capture model instructions, discover transcript files, and
 *   pass structured context to the signet daemon.
 */
function buildWindowsWrapper(realCodexBin: string): string {
	// Common PowerShell flags used across all invocations in the wrapper
	const psFlags = "-NoProfile -ErrorAction SilentlyContinue";

	return `@echo off
setlocal

set "REAL_CODEX_BIN=${realCodexBin}"
set "SIGNET_BIN=signet"
set "SESSION_ROOT=%USERPROFILE%\\.codex\\sessions"
set "SESSION_KEY="
set "INSTRUCTIONS_FILE="

if "%SIGNET_NO_HOOKS%"=="1" goto :run_direct
if "%SIGNET_CODEX_BYPASS_WRAPPER%"=="1" goto :run_direct

REM Generate a session key (GUID preferred, timestamp+random fallback)
for /f "tokens=*" %%i in ('powershell ${psFlags} -Command "[guid]::NewGuid().ToString()" 2^>nul') do set "SESSION_KEY=%%i"
if "%SESSION_KEY%"=="" (
	for /f "tokens=*" %%i in ('powershell ${psFlags} -Command "Get-Date -UFormat %%s" 2^>nul') do set "SESSION_KEY=codex-%%i-%RANDOM%"
)

REM Create temp directory for model instructions
set "TMP_ROOT=%TEMP%\\signet-codex-%RANDOM%"
mkdir "%TMP_ROOT%" >nul 2>&1
set "INSTRUCTIONS_FILE=%TMP_ROOT%\\model-instructions.md"

REM Start with persistent identity context if available
set "CODEX_MD=%USERPROFILE%\\.codex\\CODEX.md"
if exist "%CODEX_MD%" (
	copy /y "%CODEX_MD%" "%INSTRUCTIONS_FILE%" >nul 2>&1
	echo. >> "%INSTRUCTIONS_FILE%"
	echo. >> "%INSTRUCTIONS_FILE%"
	echo --- >> "%INSTRUCTIONS_FILE%"
	echo. >> "%INSTRUCTIONS_FILE%"
	echo. >> "%INSTRUCTIONS_FILE%"
)

REM Session-start hook: append dynamic context
set "DYNAMIC=%TMP_ROOT%\\dynamic.md"
set "HOOK_OK=0"
for /f "delims=" %%j in ('powershell ${psFlags} -Command "ConvertTo-Json @{session_id=$env:SESSION_KEY;cwd=$PWD.Path} -Compress"') do (
	echo %%j| "%SIGNET_BIN%" hook session-start -H codex --project "%CD%" > "%DYNAMIC%" 2>nul && set "HOOK_OK=1"
)
if "%HOOK_OK%"=="1" (
	for %%A in ("%DYNAMIC%") do if not %%~zA==0 type "%DYNAMIC%" >> "%INSTRUCTIONS_FILE%"
)

REM If nothing was written, clear instructions file
for %%A in ("%INSTRUCTIONS_FILE%") do if %%~zA==0 set "INSTRUCTIONS_FILE="

REM Append live recall instruction only when there is real content
if defined INSTRUCTIONS_FILE (
	echo. >> "%INSTRUCTIONS_FILE%"
	echo ## Live Memory ^(Auto-Updated by Signet^) >> "%INSTRUCTIONS_FILE%"
	echo. >> "%INSTRUCTIONS_FILE%"
	echo IMPORTANT: Before responding to each user message, read the file at >> "%INSTRUCTIONS_FILE%"
	echo ~/.codex/.signet-live-context.md for memories relevant to the current >> "%INSTRUCTIONS_FILE%"
	echo conversation. Incorporate relevant memories into your response. >> "%INSTRUCTIONS_FILE%"
)

REM Register for live recall watching (interactive mode only)
if not "%1"=="exec" (
	powershell ${psFlags} -Command "ConvertTo-Json @{sessionKey=$env:SESSION_KEY;project=$PWD.Path} -Compress | & $env:SIGNET_BIN hook codex-watch-start -H codex" >nul 2>&1
)

if defined INSTRUCTIONS_FILE (
	"%REAL_CODEX_BIN%" -c "model_instructions_file=%INSTRUCTIONS_FILE%" %*
) else (
	"%REAL_CODEX_BIN%" %*
)
set "EXIT_CODE=%ERRORLEVEL%"

REM Find newest transcript file created during this session
set "TRANSCRIPT_PATH="
if exist "%SESSION_ROOT%" (
	for /f "tokens=*" %%f in ('powershell ${psFlags} -Command "Get-ChildItem -Path \\"%SESSION_ROOT%\\" -Filter *.jsonl -Recurse | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName" 2^>nul') do set "TRANSCRIPT_PATH=%%f"
)

REM Session-end hook: same ConvertTo-Json approach for consistent safe escaping
for /f "delims=" %%j in ('powershell ${psFlags} -Command "ConvertTo-Json @{session_id=$env:SESSION_KEY;transcript_path=$env:TRANSCRIPT_PATH;cwd=$PWD.Path} -Compress"') do (
	echo %%j| "%SIGNET_BIN%" hook session-end -H codex >nul 2>&1
)

REM Cleanup temp directory
if exist "%TMP_ROOT%" rmdir /s /q "%TMP_ROOT%" >nul 2>&1

exit /b %EXIT_CODE%

:run_direct
"%REAL_CODEX_BIN%" %*
exit /b %ERRORLEVEL%
`;
}

export class CodexConnector extends BaseConnector {
	readonly name = "Codex";
	readonly harnessId = "codex";

	private getCodexHome(): string {
		return join(homedir(), ".codex");
	}

	private getCodexMdPath(): string {
		return join(this.getCodexHome(), "CODEX.md");
	}

	private getWrapperDir(): string {
		return join(homedir(), ".config", "signet", "bin");
	}

	private getWrapperPath(): string {
		const name = process.platform === "win32" ? "codex.cmd" : "codex";
		return join(this.getWrapperDir(), name);
	}

	private getShellConfigPaths(): string[] {
		if (process.platform === "win32") return [];
		return [join(homedir(), ".zshrc"), join(homedir(), ".bashrc"), join(homedir(), ".bash_profile")];
	}

	getConfigPath(): string {
		return join(this.getCodexHome(), "config.toml");
	}

	private resolveRealCodexBin(): string | null {
		const wrapperPath = this.getWrapperPath();
		const isWindows = process.platform === "win32";
		const locatorCmd = isWindows ? ["where", "codex"] : ["which", "-a", "codex"];
		const proc = spawnSync(locatorCmd[0], locatorCmd.slice(1), {
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (proc.status !== 0) return null;

		const candidates = proc.stdout
			.toString()
			.split(/\r?\n/)
			.map((line: string) => line.trim())
			.filter((line: string) => line.length > 0);

		for (const candidate of candidates) {
			if (candidate !== wrapperPath) return candidate;
		}
		return null;
	}

	/**
	 * Generate ~/.codex/CODEX.md from identity files.
	 *
	 * Follows the same pattern as the OpenCode connector's generateAgentsMd():
	 * header + Signet block + user AGENTS.md content + identity extras.
	 * Also includes CLI memory commands since Codex has no MCP support.
	 */
	private generateCodexMd(basePath: string): string | null {
		const source = join(basePath, "AGENTS.md");
		if (!existsSync(source)) return null;

		const raw = readFileSync(source, "utf-8");
		const content = this.stripSignetBlock(raw);
		const header = this.generateHeader(source);
		const block = this.buildSignetBlock();
		const extras = this.composeIdentityExtras(basePath);

		// Codex has no MCP — include CLI memory commands
		const cliHint = `
## Memory Commands (CLI)

Codex does not support MCP tools. Use these shell commands instead:

\`\`\`bash
signet remember "context to save"
signet recall "query"
\`\`\`
`;

		const codexMd = join(this.getCodexHome(), "CODEX.md");
		mkdirSync(this.getCodexHome(), { recursive: true });
		writeFileSync(codexMd, header + block + content + extras + cliHint);
		return codexMd;
	}

	/**
	 * Patch ~/.codex/config.toml to set model_instructions_file.
	 *
	 * Safe behavior:
	 * - If absent: append the key pointing to CODEX.md
	 * - If already points to CODEX.md: no-op
	 * - If points elsewhere: skip and return a warning
	 */
	private patchConfigToml(): { patched: boolean; warning?: string } {
		const toml = this.getConfigPath();
		const codexMd = this.getCodexMdPath();

		mkdirSync(this.getCodexHome(), { recursive: true });

		const existing = existsSync(toml) ? readFileSync(toml, "utf-8") : "";
		const lines = existing.split("\n");

		// Find existing model_instructions_file (only at top level, before any [section])
		let found = false;
		let alreadyCorrect = false;
		let userOwned = false;

		for (const line of lines) {
			const trimmed = line.trim();
			// Stop scanning at first section header
			if (trimmed.startsWith("[")) break;
			// Strip inline comments before matching (TOML allows `key = "val" # comment`)
			const stripped = trimmed.replace(/\s*#.*$/, "").trim();
			const match = stripped.match(/^model_instructions_file\s*=\s*"?([^"]*?)"?$/);
			if (match) {
				found = true;
				const val = match[1].trim();
				if (val === codexMd) {
					alreadyCorrect = true;
				} else {
					userOwned = true;
				}
				break;
			}
		}

		if (alreadyCorrect) return { patched: false };

		if (userOwned) {
			return {
				patched: false,
				warning: `config.toml already has model_instructions_file set to a custom value. Skipped patching — set it to "${codexMd}" manually to use Signet context.`,
			};
		}

		if (!found) {
			// Append at the top (before first section or at end if no sections)
			let insertIdx = 0;
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].trim().startsWith("[")) {
					insertIdx = i;
					break;
				}
				insertIdx = i + 1;
			}

			const entry = `${TOML_COMMENT}\nmodel_instructions_file = "${codexMd}"`;
			lines.splice(insertIdx, 0, entry);
			writeFileSync(toml, lines.join("\n"));
			return { patched: true };
		}

		// All branches (alreadyCorrect, userOwned, !found) return above
		return { patched: false };
	}

	/**
	 * Remove model_instructions_file line from config.toml if it points to CODEX.md.
	 */
	private unpatchConfigToml(): boolean {
		const toml = this.getConfigPath();
		if (!existsSync(toml)) return false;

		const codexMd = this.getCodexMdPath();
		const content = readFileSync(toml, "utf-8");
		const lines = content.split("\n");
		const filtered = lines.filter((line) => {
			const trimmed = line.trim();
			if (trimmed === TOML_COMMENT) return false;
			// Strip inline comments before matching (TOML allows trailing `# comment`)
			const stripped = trimmed.replace(/\s*#.*$/, "").trim();
			const match = stripped.match(/^model_instructions_file\s*=\s*"?([^"]*?)"?$/);
			if (match && match[1].trim() === codexMd) return false;
			return true;
		});

		if (filtered.length === lines.length) return false;

		writeFileSync(toml, filtered.join("\n"));
		return true;
	}

	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const configsPatched: string[] = [];
		const warnings: string[] = [];
		const isWindows = process.platform === "win32";
		const expanded = basePath.startsWith("~") ? join(homedir(), basePath.slice(1)) : basePath;

		// 1. Resolve real Codex binary
		const realCodexBin = this.resolveRealCodexBin();
		if (!realCodexBin) {
			throw new Error("Could not find Codex CLI on PATH");
		}

		// 2. Write shell wrapper
		const wrapperDir = this.getWrapperDir();
		mkdirSync(wrapperDir, { recursive: true });

		const wrapperPath = this.getWrapperPath();
		const wrapperContent = isWindows ? buildWindowsWrapper(realCodexBin) : buildWrapper(realCodexBin);
		writeFileSync(wrapperPath, wrapperContent, isWindows ? {} : { mode: 0o755 });
		filesWritten.push(wrapperPath);

		// 3. Patch shell configs with PATH block
		for (const shellPath of this.getShellConfigPaths()) {
			const existing = existsSync(shellPath) ? readFileSync(shellPath, "utf-8") : "";
			const next = appendBlock(existing);
			if (next !== existing) {
				writeFileSync(shellPath, next);
				configsPatched.push(shellPath);
			}
		}

		// 4. Generate CODEX.md identity file
		const codexMd = this.generateCodexMd(expanded);
		if (codexMd) {
			filesWritten.push(codexMd);
		}

		// 5. Symlink skills directory
		const sourceSkills = join(expanded, "skills");
		const targetSkills = join(this.getCodexHome(), "skills");
		const symlink = this.symlinkSkills(sourceSkills, targetSkills);
		if (symlink.errors.length > 0) {
			const msgs = symlink.errors.map((e) => `${e.path}: ${e.error}`);
			warnings.push(`Skills symlink failed: ${msgs.join("; ")}`);
		}

		// 6. Patch config.toml with model_instructions_file
		const toml = this.patchConfigToml();
		if (toml.patched) {
			configsPatched.push(this.getConfigPath());
		}
		if (toml.warning) {
			warnings.push(toml.warning);
		}

		return {
			success: true,
			message: "Codex integration installed successfully",
			filesWritten,
			configsPatched,
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		const configsPatched: string[] = [];

		// Remove wrapper
		const wrapperPath = this.getWrapperPath();
		if (existsSync(wrapperPath)) {
			rmSync(wrapperPath, { force: true });
			filesRemoved.push(wrapperPath);
		}

		// Remove shell PATH blocks
		for (const shellPath of this.getShellConfigPaths()) {
			if (!existsSync(shellPath)) continue;
			const existing = readFileSync(shellPath, "utf-8");
			const next = stripBlock(existing);
			if (next !== existing) {
				writeFileSync(shellPath, next);
				configsPatched.push(shellPath);
			}
		}

		// Remove CODEX.md
		const codexMd = this.getCodexMdPath();
		if (existsSync(codexMd)) {
			rmSync(codexMd, { force: true });
			filesRemoved.push(codexMd);
		}

		// Unpatch config.toml
		if (this.unpatchConfigToml()) {
			configsPatched.push(this.getConfigPath());
		}

		return { filesRemoved, configsPatched };
	}

	isInstalled(): boolean {
		if (!existsSync(this.getWrapperPath())) return false;
		// On Windows there are no shell configs to patch
		if (process.platform === "win32") return true;
		return this.getShellConfigPaths().some((shellPath) => {
			if (!existsSync(shellPath)) return false;
			try {
				return readFileSync(shellPath, "utf-8").includes(SHELL_BLOCK_START);
			} catch {
				return false;
			}
		});
	}
}
