/**
 * @signet/connector-gemini
 *
 * Signet connector for Gemini CLI - installs hooks, MCP server,
 * and generates context files during 'signet install'.
 *
 * This connector:
 *   - Writes GEMINI.md to ~/.gemini/ with composed identity
 *   - Registers Signet hooks in ~/.gemini/settings.json
 *   - Registers Signet MCP server in ~/.gemini/settings.json
 *   - Configures context.fileName to include AGENTS.md
 *   - Symlinks skills directory to ~/.gemini/skills/
 *
 * @example
 * ```typescript
 * import { GeminiConnector } from '@signet/connector-gemini'
 *
 * const connector = new GeminiConnector()
 * await connector.install('/home/user/.agents')
 * ```
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseConnector, type InstallResult, type UninstallResult, atomicWriteJson } from "@signet/connector-base";
import { expandHome, hasValidIdentity } from "@signet/core";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SIGNET_MARKER = "signet-managed";

export class GeminiConnector extends BaseConnector {
	readonly name = "Gemini CLI";
	readonly harnessId = "gemini";

	private readonly geminiPathOverride: string | undefined;

	constructor(geminiPath?: string) {
		super();
		this.geminiPathOverride = geminiPath;
	}

	private getGeminiPath(): string {
		return this.geminiPathOverride ?? join(homedir(), ".gemini");
	}

	getConfigPath(): string {
		return join(this.getGeminiPath(), "settings.json");
	}

	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const expandedBasePath = expandHome(basePath || join(homedir(), ".agents"));

		if (!hasValidIdentity(expandedBasePath)) {
			return {
				success: false,
				message: `No valid Signet identity found at ${expandedBasePath}`,
				filesWritten,
			};
		}

		const strippedAgentsPath = this.stripLegacySignetBlock(expandedBasePath);
		if (strippedAgentsPath !== null) {
			filesWritten.push(strippedAgentsPath);
		}

		const geminiPath = this.getGeminiPath();

		if (!existsSync(geminiPath)) {
			mkdirSync(geminiPath, { recursive: true });
		}

		const geminiMdPath = await this.generateGeminiMd(expandedBasePath);
		if (geminiMdPath) {
			filesWritten.push(geminiMdPath);
		}

		this.configureHooks(geminiPath);
		this.registerMcpServer(geminiPath);
		this.configureContextFileName(geminiPath);

		const skillsSource = join(expandedBasePath, "skills");
		const skillsDest = join(geminiPath, "skills");
		if (existsSync(skillsSource)) {
			this.symlinkSkills(skillsSource, skillsDest);
		}

		this.recordSkillsSource(geminiPath, skillsSource);

		return {
			success: true,
			message: "Gemini CLI integration installed successfully",
			filesWritten,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const geminiPath = this.getGeminiPath();
		const filesRemoved: string[] = [];

		const geminiMdPath = join(geminiPath, "GEMINI.md");
		if (existsSync(geminiMdPath)) {
			const content = readFileSync(geminiMdPath, "utf-8");
			if (content.includes(SIGNET_MARKER)) {
				rmSync(geminiMdPath);
				filesRemoved.push(geminiMdPath);
			}
		}

		this.removeHooks(geminiPath);
		this.removeMcpServer(geminiPath);
		this.removeContextFileNameConfig(geminiPath);

		const skillsDir = join(geminiPath, "skills");
		const signetSkillsSource = this.readSkillsSource(geminiPath);
		if (signetSkillsSource && existsSync(skillsDir) && lstatSync(skillsDir).isDirectory()) {
			let removedAny = false;
			for (const entry of readdirSync(skillsDir)) {
				const entryPath = join(skillsDir, entry);
				try {
					if (lstatSync(entryPath).isSymbolicLink()) {
						let target = readlinkSync(entryPath);
						if (!target.startsWith("/")) {
							target = join(skillsDir, target);
						}
						if (target === signetSkillsSource || target.startsWith(signetSkillsSource + "/") || target.startsWith(signetSkillsSource + "\\")) {
							unlinkSync(entryPath);
							removedAny = true;
						}
					}
				} catch {
					// skip entries that can't be stat'd or read
				}
			}
			if (removedAny) {
				const remaining = readdirSync(skillsDir);
				if (remaining.length === 0) {
					rmSync(skillsDir, { recursive: true, force: true });
				}
				filesRemoved.push(skillsDir);
			}
			this.removeSkillsSource(geminiPath);
		}

		return { filesRemoved };
	}

	isInstalled(): boolean {
		const settingsPath = this.getConfigPath();
		if (!existsSync(settingsPath)) return false;
		try {
			const config = JSON.parse(readFileSync(settingsPath, "utf-8"));
			const hooks = isJsonObject(config.hooks) ? config.hooks : {};
			const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
			return sessionStart.some(
				(group: unknown) =>
					isJsonObject(group) &&
					Array.isArray((group as JsonObject).hooks) &&
					((group as JsonObject).hooks as unknown[]).some(
						(h: unknown) =>
							isJsonObject(h) &&
							typeof (h as JsonObject).command === "string" &&
							((h as JsonObject).command as string).includes("signet"),
					),
			);
		} catch {
			return false;
		}
	}

	static isHarnessInstalled(): boolean {
		return existsSync(join(homedir(), ".gemini", "settings.json"));
	}

	private async generateGeminiMd(basePath: string): Promise<string | null> {
		const sourcePath = join(basePath, "AGENTS.md");

		if (!existsSync(sourcePath)) {
			return null;
		}

		const raw = readFileSync(sourcePath, "utf-8");
		const userContent = this.stripSignetBlock(raw);
		const header = this.generateHeader(sourcePath);
		const extras = this.composeIdentityExtras(basePath);

		const destPath = join(this.getGeminiPath(), "GEMINI.md");
		writeFileSync(destPath, `<!-- ${SIGNET_MARKER} -->\n${header}${userContent}${extras}`);

		return destPath;
	}

	private configureHooks(geminiPath: string): void {
		const settingsPath = join(geminiPath, "settings.json");

		let config: JsonObject = {};
		if (existsSync(settingsPath)) {
			try {
				config = JSON.parse(readFileSync(settingsPath, "utf-8"));
			} catch {
				config = {};
			}
		}

		let signetCmd = "signet";
		if (process.platform === "win32") {
			const cliEntry = process.argv[1] || "";
			const signetJs = join(cliEntry, "..", "..", "bin", "signet.js");
			if (existsSync(signetJs)) {
				signetCmd = `"${process.execPath}" "${signetJs}"`;
			}
		}

		const pwdExpr = process.platform === "win32" ? "%CD%" : "$(pwd)";

		const hooks = isJsonObject(config.hooks) ? (config.hooks as JsonObject) : {};

		const signetHooks = {
			SessionStart: [
				{
					hooks: [
						{
							type: "command",
							command: `${signetCmd} hook session-start -H gemini --project "${pwdExpr}"`,
							timeout: 30000,
							name: "signet-session-start",
						},
					],
				},
			],
			SessionEnd: [
				{
					hooks: [
						{
							type: "command",
							command: `${signetCmd} hook session-end -H gemini`,
							timeout: 15000,
							name: "signet-session-end",
						},
					],
				},
			],
			BeforeAgent: [
				{
					hooks: [
						{
							type: "command",
							command: `${signetCmd} hook user-prompt-submit -H gemini --project "${pwdExpr}"`,
							timeout: 30000,
							name: "signet-before-agent",
						},
					],
				},
			],
			PreCompress: [
				{
					hooks: [
						{
							type: "command",
							command: `${signetCmd} hook pre-compaction -H gemini --project "${pwdExpr}"`,
							timeout: 3000,
							name: "signet-pre-compress",
						},
					],
				},
			],
		};

		for (const [event, definition] of Object.entries(signetHooks)) {
			const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
			const cleaned = existing.map((group: unknown) => {
				if (!isJsonObject(group)) return group;
				const groupHooks = (group as JsonObject).hooks;
				if (!Array.isArray(groupHooks)) return group;
				const remaining = (groupHooks as unknown[]).filter(
					(h: unknown) =>
						!(isJsonObject(h) && typeof (h as JsonObject).name === "string" && ((h as JsonObject).name as string).startsWith("signet-")),
				);
				return { ...(group as JsonObject), hooks: remaining };
			});
			hooks[event] = [...cleaned, ...definition];
		}

		config.hooks = hooks;

		if (!isJsonObject(config.hooksConfig)) {
			config.hooksConfig = {};
		}
		(config.hooksConfig as JsonObject).enabled = true;

		atomicWriteJson(settingsPath, config);
	}

	private removeHooks(geminiPath: string): void {
		const settingsPath = join(geminiPath, "settings.json");
		if (!existsSync(settingsPath)) return;

		let config: JsonObject;
		try {
			config = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {
			return;
		}

		if (!isJsonObject(config.hooks)) return;

		const hooks = config.hooks as JsonObject;
		let modified = false;

		for (const event of Object.keys(hooks)) {
			const entries = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
			const cleaned = entries
				.map((group: unknown) => {
					if (!isJsonObject(group)) return group;
					const groupHooks = (group as JsonObject).hooks;
					if (!Array.isArray(groupHooks)) return group;
					const remaining = (groupHooks as unknown[]).filter(
						(h: unknown) =>
							!(isJsonObject(h) && typeof (h as JsonObject).name === "string" && ((h as JsonObject).name as string).startsWith("signet-")),
					);
					return { ...(group as JsonObject), hooks: remaining };
				})
				.filter((group: unknown) => {
					if (!isJsonObject(group)) return true;
					const groupHooks = (group as JsonObject).hooks;
					if (!Array.isArray(groupHooks)) return true;
					return groupHooks.length > 0;
				});
			if (cleaned.length !== entries.length || cleaned.some((g, i) => g !== entries[i])) {
				if (cleaned.length === 0) {
					delete hooks[event];
				} else {
					hooks[event] = cleaned;
				}
				modified = true;
			}
		}

		if (Object.keys(hooks).length === 0) {
			// biome-ignore lint/performance/noDelete: intentional for clean JSON serialization
			delete config.hooks;
			modified = true;
		}

		if (modified) {
			atomicWriteJson(settingsPath, config);
		}
	}

	private registerMcpServer(geminiPath: string): void {
		const settingsPath = join(geminiPath, "settings.json");

		let config: JsonObject = {};
		if (existsSync(settingsPath)) {
			try {
				config = JSON.parse(readFileSync(settingsPath, "utf-8"));
			} catch {
				config = {};
			}
		}

		let mcpCommand: string[] = ["signet-mcp"];
		if (process.platform === "win32") {
			const cliEntry = process.argv[1] || "";
			const mcpJs = join(cliEntry, "..", "..", "dist", "mcp-stdio.js");
			if (existsSync(mcpJs)) {
				mcpCommand = [process.execPath, mcpJs];
			}
		}

		const existingServers = isJsonObject(config.mcpServers) ? (config.mcpServers as JsonObject) : {};
		config.mcpServers = {
			...existingServers,
			signet: {
				command: mcpCommand.length === 1 ? mcpCommand[0] : mcpCommand[0],
				args: mcpCommand.length > 1 ? mcpCommand.slice(1) : undefined,
				type: "stdio",
				description: "Signet memory and identity server",
			},
		};

		const serverConfig = (config.mcpServers as JsonObject).signet as JsonObject;
		if (serverConfig.args === undefined) {
			// biome-ignore lint/performance/noDelete: intentional for clean JSON serialization
			delete serverConfig.args;
		}

		atomicWriteJson(settingsPath, config);
	}

	private removeMcpServer(geminiPath: string): void {
		const settingsPath = join(geminiPath, "settings.json");
		if (!existsSync(settingsPath)) return;

		let config: JsonObject;
		try {
			config = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {
			return;
		}

		if (isJsonObject(config.mcpServers)) {
			// biome-ignore lint/performance/noDelete: intentional for clean JSON serialization
			delete (config.mcpServers as JsonObject).signet;
			if (Object.keys(config.mcpServers as JsonObject).length === 0) {
				// biome-ignore lint/performance/noDelete: intentional for clean JSON serialization
				delete config.mcpServers;
			}
			atomicWriteJson(settingsPath, config);
		}
	}

	private configureContextFileName(geminiPath: string): void {
		const settingsPath = join(geminiPath, "settings.json");

		let config: JsonObject = {};
		if (existsSync(settingsPath)) {
			try {
				config = JSON.parse(readFileSync(settingsPath, "utf-8"));
			} catch {
				config = {};
			}
		}

		const contextConfig = isJsonObject(config.context) ? (config.context as JsonObject) : {};

		const existingFiles = Array.isArray(contextConfig.fileName)
			? (contextConfig.fileName as unknown[]).map(String)
			: typeof contextConfig.fileName === "string"
				? [contextConfig.fileName as string]
				: ["GEMINI.md"];

		const desired = ["GEMINI.md", "AGENTS.md"];
		const merged = [...new Set([...existingFiles, ...desired])];

		contextConfig.fileName = merged;
		config.context = contextConfig;

		atomicWriteJson(settingsPath, config);
	}

	private removeContextFileNameConfig(geminiPath: string): void {
		const settingsPath = join(geminiPath, "settings.json");
		if (!existsSync(settingsPath)) return;

		let config: JsonObject;
		try {
			config = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {
			return;
		}

		if (!isJsonObject(config.context)) return;
		const context = config.context as JsonObject;

		if (Array.isArray(context.fileName)) {
			const filtered = (context.fileName as unknown[]).filter((f) => f !== "AGENTS.md");
			if (filtered.length === 0) {
				// biome-ignore lint/performance/noDelete: intentional for clean JSON serialization
				delete context.fileName;
			} else {
				context.fileName = filtered;
			}

			if (Object.keys(context).length === 0) {
				// biome-ignore lint/performance/noDelete: intentional for clean JSON serialization
				delete config.context;
			}

			atomicWriteJson(settingsPath, config);
		}
	}

	private recordSkillsSource(geminiPath: string, sourcePath: string): void {
		const settingsPath = join(geminiPath, "settings.json");

		let config: JsonObject = {};
		if (existsSync(settingsPath)) {
			try {
				config = JSON.parse(readFileSync(settingsPath, "utf-8"));
			} catch {
				config = {};
			}
		}

		if (!isJsonObject(config.signet)) {
			config.signet = {};
		}
		(config.signet as JsonObject).skillsSource = sourcePath;

		atomicWriteJson(settingsPath, config);
	}

	private readSkillsSource(geminiPath: string): string | null {
		const settingsPath = join(geminiPath, "settings.json");
		if (!existsSync(settingsPath)) return null;
		try {
			const config = JSON.parse(readFileSync(settingsPath, "utf-8"));
			if (isJsonObject(config.signet) && typeof (config.signet as JsonObject).skillsSource === "string") {
				return (config.signet as JsonObject).skillsSource as string;
			}
		} catch {
			// not parseable
		}
		return null;
	}

	private removeSkillsSource(geminiPath: string): void {
		const settingsPath = join(geminiPath, "settings.json");
		if (!existsSync(settingsPath)) return;

		let config: JsonObject;
		try {
			config = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {
			return;
		}

		if (isJsonObject(config.signet)) {
			// biome-ignore lint/performance/noDelete: intentional for clean JSON serialization
			delete (config.signet as JsonObject).skillsSource;
			if (Object.keys(config.signet as JsonObject).length === 0) {
				// biome-ignore lint/performance/noDelete: intentional for clean JSON serialization
				delete config.signet;
			}
			atomicWriteJson(settingsPath, config);
		}
	}
}

export const geminiConnector = new GeminiConnector();
export default GeminiConnector;
