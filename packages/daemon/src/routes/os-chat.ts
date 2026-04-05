/**
 * OS Chat routes — natural language agent chat for the Signet OS tab.
 *
 * Receives user messages, interprets intent against available MCP tools
 * using the synthesis LLM provider, executes matching tools, and returns
 * agent responses with tool call results.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { logger } from "../logger.js";
import { loadProbeResult } from "../mcp-probe.js";
import { getModelsByProvider } from "../pipeline/model-registry.js";
import {
	createClaudeCodeProvider,
	createCodexProvider,
	createOllamaProvider,
} from "../pipeline/provider.js";
import { getSynthesisProvider } from "../synthesis-llm.js";
import { getWidgetProvider } from "../widget-llm.js";

interface ChatModelOption {
	id: string;
	label: string;
	description: string;
	provider: string;
}

const CHAT_MODEL_CACHE_TTL_MS = 20_000;
let chatModelOptionsCache:
	| {
			expiresAt: number;
			value: { options: ChatModelOption[]; defaultModelId: string };
	  }
	| null = null;

const CLI_FALLBACK_BIN_DIRS = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	join(homedir(), ".bun", "bin"),
	join(homedir(), ".local", "bin"),
];

function hasCliBinary(commandNames: string[]): boolean {
	for (const commandName of commandNames) {
		if (Bun.which(commandName) !== null) return true;
		for (const dir of CLI_FALLBACK_BIN_DIRS) {
			if (existsSync(join(dir, commandName))) return true;
		}
	}
	return false;
}

function hasOpenCodeCliInstalled(): boolean {
	return hasCliBinary(["opencode"]) || existsSync(join(homedir(), ".opencode", "bin", "opencode"));
}

function resolveOpenCodeCliPath(): string | null {
	const fromPath = Bun.which("opencode");
	if (fromPath) return fromPath;
	const fallback = join(homedir(), ".opencode", "bin", "opencode");
	return existsSync(fallback) ? fallback : null;
}

async function runOpenCodeCli(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
	const bin = resolveOpenCodeCliPath();
	if (!bin) {
		throw new Error("OpenCode CLI not found on PATH or ~/.opencode/bin/opencode");
	}

	const proc = Bun.spawn([bin, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);

	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		if (timedOut) {
			throw new Error(`OpenCode CLI timed out after ${timeoutMs}ms`);
		}
		if (exitCode !== 0) {
			const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
			throw new Error(`OpenCode CLI failed: ${detail.slice(0, 400)}`);
		}

		return { stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}

async function discoverOpenCodeModelIds(): Promise<string[]> {
	try {
		const { stdout } = await runOpenCodeCli(["models"], 12_000);
		const seen = new Set<string>();
		const models: string[] = [];
		for (const line of stdout.split(/\r?\n/)) {
			const modelId = line.trim();
			if (!modelId || !modelId.includes("/") || seen.has(modelId)) continue;
			seen.add(modelId);
			models.push(modelId);
		}
		return models;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.warn("os-chat", `OpenCode model discovery failed: ${msg}`);
		return [];
	}
}

async function callOpenCodeCliPrompt(model: string, prompt: string, timeoutMs = 90_000): Promise<string> {
	const { stdout } = await runOpenCodeCli(["run", "--format", "json", "--model", model, "--", prompt], timeoutMs);
	const textParts: string[] = [];
	let lastError: string | null = null;

	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const event = JSON.parse(trimmed) as {
				type?: string;
				part?: { text?: string };
				error?: { name?: string; data?: { message?: string }; message?: string };
			};
			if (event.type === "text" && typeof event.part?.text === "string" && event.part.text.trim().length > 0) {
				textParts.push(event.part.text.trim());
			}
			if (event.type === "error") {
				lastError =
					event.error?.data?.message ?? event.error?.message ?? event.error?.name ?? "OpenCode returned an error";
			}
		} catch {
			// Ignore non-JSON lines to remain forward-compatible with CLI output changes.
		}
	}

	if (lastError) {
		throw new Error(lastError);
	}
	if (textParts.length > 0) {
		return textParts.join("\n");
	}

	throw new Error("OpenCode produced no text response");
}

async function canUseProvider(check: () => { available: () => Promise<boolean> }): Promise<boolean> {
	try {
		return await check().available();
	} catch {
		return false;
	}
}

const FALLBACK_CHAT_MODELS: Record<"claude-code" | "codex" | "opencode" | "ollama", string> = {
	"claude-code": "haiku",
	codex: "gpt-5-codex-mini",
	opencode: "opencode/gpt-5-nano",
	ollama: "llama3",
};

function appendProviderModels(
	options: ChatModelOption[],
	providerId: "claude-code" | "codex" | "opencode" | "ollama",
	providerLabel: string,
	description: string,
	maxCount = 10,
): void {
	const models = getModelsByProvider()[providerId] ?? [];
	const source = models.length > 0 ? models : [{ id: FALLBACK_CHAT_MODELS[providerId], label: "Default" }];

	for (const model of source.slice(0, maxCount)) {
		const modelLabel = typeof model.label === "string" && model.label.trim().length > 0 ? model.label : model.id;
		options.push({
			id: `${providerId}:${model.id}`,
			label: `${providerLabel} (${modelLabel})`,
			description,
			provider: providerId,
		});
	}
}

function appendExplicitProviderModels(
	options: ChatModelOption[],
	providerId: "ollama" | "opencode",
	providerLabel: string,
	description: string,
	modelIds: string[],
	maxCount = 12,
): void {
	for (const modelId of modelIds.slice(0, maxCount)) {
		const trimmed = modelId.trim();
		if (!trimmed) continue;
		options.push({
			id: `${providerId}:${trimmed}`,
			label: `${providerLabel} (${trimmed})`,
			description,
			provider: providerId,
		});
	}
}

async function discoverOllamaModelIds(): Promise<string[]> {
	const configuredBase = process.env.OLLAMA_BASE_URL?.trim() || process.env.OLLAMA_HOST?.trim() || "http://127.0.0.1:11434";
	const baseUrl = configuredBase.replace(/\/+$/, "");
	try {
		const res = await fetch(`${baseUrl}/api/tags`, {
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) return [];
		const data = (await res.json()) as { models?: Array<{ name?: string }> };
		if (!Array.isArray(data.models)) return [];
		const seen = new Set<string>();
		const out: string[] = [];
		for (const model of data.models) {
			const name = typeof model?.name === "string" ? model.name.trim() : "";
			if (!name || seen.has(name)) continue;
			if (/embed|embedding/i.test(name)) continue;
			seen.add(name);
			out.push(name);
		}
		return out;
	} catch {
		return [];
	}
}

async function getChatModelOptions(forceRefresh = false): Promise<{ options: ChatModelOption[]; defaultModelId: string }> {
	const now = Date.now();
	if (!forceRefresh && chatModelOptionsCache && chatModelOptionsCache.expiresAt > now) {
		return chatModelOptionsCache.value;
	}

	const options: ChatModelOption[] = [];

	if (hasCliBinary(["claude", "claude-code"]) && (await canUseProvider(() => createClaudeCodeProvider({ model: "haiku" })))) {
		appendProviderModels(options, "claude-code", "Claude Code", "Local Claude Code CLI harness");
	}

	if (hasCliBinary(["codex"]) && (await canUseProvider(() => createCodexProvider({ model: "gpt-5-codex-mini" })))) {
		appendProviderModels(options, "codex", "Codex CLI", "Local Codex CLI harness");
	}

	if (hasOpenCodeCliInstalled()) {
		const openCodeModels = await discoverOpenCodeModelIds();
		if (openCodeModels.length > 0) {
			appendExplicitProviderModels(options, "opencode", "OpenCode", "Local OpenCode CLI harness", openCodeModels, 40);
		} else {
			appendProviderModels(options, "opencode", "OpenCode", "Local OpenCode CLI harness", 10);
		}
	}

	try {
		const ollamaProvider = createOllamaProvider();
		if (await ollamaProvider.available()) {
			const liveOllamaModels = await discoverOllamaModelIds();
			if (liveOllamaModels.length > 0) {
				appendExplicitProviderModels(
					options,
					"ollama",
					"Ollama",
					"Local Ollama model",
					liveOllamaModels,
				);
			}
		}
	} catch {
		// Ignore Ollama availability errors
	}

	try {
		const synthesis = getSynthesisProvider();
		if (await synthesis.available()) {
			options.push({
				id: "synthesis",
				label: `Synthesis (${synthesis.name})`,
				description: "Configured Signet synthesis provider",
				provider: "synthesis",
			});
		}
	} catch {
		// Synthesis provider unavailable
	}

	try {
		const widget = getWidgetProvider();
		if (await widget.available()) {
			options.push({
				id: "widget",
				label: `Widget (${widget.name})`,
				description: "Configured widget-generation provider",
				provider: "widget",
			});
		}
	} catch {
		// Widget provider unavailable
	}

	const deduped = new Map<string, ChatModelOption>();
	for (const option of options) {
		if (!deduped.has(option.id)) deduped.set(option.id, option);
	}
	const finalOptions = [...deduped.values()];

	if (finalOptions.length === 0) {
		throw new Error("No chat-capable providers discovered. Install Claude Code, Codex, OpenCode, or Ollama.");
	}

	const preferenceOrder = ["claude-code:", "codex:", "opencode:", "ollama:", "synthesis", "widget"];
	const defaultOption =
		preferenceOrder
			.map((prefix) => finalOptions.find((option) => option.id === prefix || option.id.startsWith(prefix)))
			.find((option) => Boolean(option)) ?? finalOptions[0];

	const result = { options: finalOptions, defaultModelId: defaultOption!.id };
	chatModelOptionsCache = {
		expiresAt: now + CHAT_MODEL_CACHE_TTL_MS,
		value: result,
	};
	return result;
}

async function resolveChatProvider(modelId?: string, strictModelSelection = false) {
	const { options, defaultModelId } = await getChatModelOptions();
	const requested = typeof modelId === "string" && modelId.trim().length > 0 ? modelId.trim() : defaultModelId;
	const requestedExists = options.some((option) => option.id === requested);
	if (strictModelSelection && !requestedExists) {
		throw new Error(`Requested model is not available: ${requested}`);
	}
	const target = requestedExists ? requested : defaultModelId;

	if (target.startsWith("claude-code:")) {
		const model = target.slice("claude-code:".length).trim() || "haiku";
		return createClaudeCodeProvider({ model });
	}

	if (target.startsWith("codex:")) {
		const model = target.slice("codex:".length).trim() || "gpt-5-codex-mini";
		return createCodexProvider({ model });
	}

	if (target.startsWith("opencode:")) {
		const model = target.slice("opencode:".length).trim() || "opencode/gpt-5-nano";
		return {
			name: `opencode:${model}`,
			async generate(prompt: string, opts?: { timeoutMs?: number; maxTokens?: number }): Promise<string> {
				const timeoutMs = Math.max(5_000, Math.min(opts?.timeoutMs ?? 90_000, 180_000));
				return callOpenCodeCliPrompt(model, prompt, timeoutMs);
			},
			async available(): Promise<boolean> {
				return hasOpenCodeCliInstalled();
			},
		};
	}

	if (target.startsWith("ollama:")) {
		const model = target.slice("ollama:".length).trim();
		if (model.length > 0) {
			return createOllamaProvider({ model });
		}
	}

	if (target === "widget") {
		try {
			return getWidgetProvider();
		} catch {
			return getSynthesisProvider();
		}
	}

	try {
		return getSynthesisProvider();
	} catch {
		return getWidgetProvider();
	}
}

async function callLlm(systemPrompt: string, userMessage: string, maxTokens = 2048, modelId?: string): Promise<string> {
	const prompt = [
		"SYSTEM INSTRUCTIONS:",
		systemPrompt,
		"",
		"USER MESSAGE:",
		userMessage,
		"",
		"Respond now.",
	].join("\n");

	const { options, defaultModelId } = await getChatModelOptions();
	const hasExplicitSelection = typeof modelId === "string" && modelId.trim().length > 0;
	const requested = hasExplicitSelection && typeof modelId === "string" ? modelId.trim() : defaultModelId;
	const orderedModelIds = hasExplicitSelection
		? [requested]
		: [requested, ...options.map((option) => option.id).filter((id) => id !== requested)];

	let lastError: unknown;
	for (const candidateModelId of orderedModelIds) {
		try {
			const provider = await resolveChatProvider(candidateModelId, hasExplicitSelection);
			return await provider.generate(prompt, { maxTokens });
		} catch (error) {
			lastError = error;
			const msg = error instanceof Error ? error.message : String(error);
			logger.warn("os-chat", `Chat provider ${candidateModelId} failed: ${msg}`);
			if (hasExplicitSelection) break;
		}
	}

	if (hasExplicitSelection) {
		const msg = lastError instanceof Error ? lastError.message : "Unknown provider error";
		throw new Error(`Selected model failed (${requested}): ${msg}`);
	}

	throw lastError instanceof Error ? lastError : new Error("All chat providers failed");
}


interface ChatRequest {
	message: string;
	modelId?: string;
}

interface ToolCallResult {
	tool: string;
	server: string;
	result?: unknown;
	error?: string;
}

interface ToolSpec {
	serverId: string;
	serverName: string;
	toolName: string;
	description: string;
	inputSchema?: unknown;
}

interface BrowserToolRequest {
	action?: string;
	payload?: string;
	pageTitle?: string;
	pageUrl?: string;
	note?: string;
	selectedText?: string;
	links?: string[];
	images?: string[];
	videos?: string[];
	audio?: string[];
	files?: Array<{ name?: string; type?: string; size?: number }>;
	dispatchToHarness?: boolean;
}

interface BrowserToolRouteResult {
	success: boolean;
	memoryStored: boolean;
	dispatched: boolean;
	memoryId?: string;
	response?: string;
	error?: string;
	toolCalls?: ToolCallResult[];
}

function getLocalDaemonBaseUrl(): string {
	return `http://127.0.0.1:${process.env.SIGNET_PORT || 3850}`;
}

function formatBrowserToolMessage(request: BrowserToolRequest): string {
	const title = request.pageTitle?.trim() || "Untitled page";
	const url = request.pageUrl?.trim() || "unknown";
	const action = request.action?.trim() || "browser-submission";
	const note = request.note?.trim() || "(none)";
	const selected = request.selectedText?.trim() || "(none)";

	return [
		"Browser extension submission from Signet.",
		`Action: ${action}`,
		`Page: ${title}`,
		`URL: ${url}`,
		`Note: ${note}`,
		"",
		"Selection:",
		selected,
		"",
		"Payload:",
		request.payload?.slice(0, 20_000) || "",
		"",
		"Please process this like a live browser handoff: extract key facts, continue workflow context, and run tools only when clearly needed.",
	].join("\n");
}

/**
 * Gather all available tools from all installed MCP servers using probe results.
 */
function gatherAvailableTools(): ToolSpec[] {
	const { readInstalledServersPublic } = require("./marketplace-helpers.js");
	const servers = readInstalledServersPublic();
	const tools: ToolSpec[] = [];

	for (const server of servers) {
		if (!server.enabled) continue;
		const probe = loadProbeResult(server.id);
		if (!probe?.ok || !probe.autoCard?.tools) continue;

		for (const tool of probe.autoCard.tools) {
			tools.push({
				serverId: server.id,
				serverName: probe.autoCard.name || server.name,
				toolName: tool.name,
				description: tool.description || "",
				inputSchema: tool.inputSchema,
			});
		}
	}

	return tools;
}

/**
 * Build a system prompt that tells the LLM what tools are available
 * and how to respond.
 */
function buildSystemPrompt(tools: ToolSpec[]): string {
	// Filter out view_* tools — they return HTML widgets, not data.
	// The chat should use fetch_* tools for data retrieval.
	const dataTools = tools.filter((t) => !t.toolName.startsWith("view_") && !t.toolName.startsWith("check_"));
	const toolList = dataTools
		.map((t) => {
			const schemaStr = t.inputSchema ? ` Args: ${JSON.stringify(t.inputSchema).slice(0, 200)}` : "";
			return `- ${t.serverId}/${t.toolName}: ${t.description}${schemaStr}`;
		})
		.join("\n");

	return `You are the Signet OS assistant. Be direct, clear, and helpful.
Do not use fixed personas, nicknames, or decorative emoticons.

You have access to MCP tools via installed servers. Here are the available tools:

${toolList}

When the user asks a question or makes a request:
1. Figure out which tool(s) to call.
2. Decide if this should use VISUAL AGENT mode or DIRECT mode.

**VISUAL AGENT MODE** — use when the user wants to CREATE, UPDATE, DELETE, or MODIFY something in a widget. The visual agent shows an AI cursor clicking through the widget UI in real-time. Set "useAgent": true and "agentServerId" to the server that owns the widget. Do NOT include toolCalls when using agent mode.

**DIRECT MODE** — use for READ operations (fetching data, searching, listing). Set "useAgent": false and include toolCalls as normal.

Respond in this JSON format:

{"thinking":"brief reasoning","useAgent":false,"agentServerId":null,"toolCalls":[{"serverId":"server-id","toolName":"tool_name","args":{}}],"response":"your response to the user"}

For agent mode (mutations):
{"thinking":"this needs visual agent","useAgent":true,"agentServerId":"server-id","toolCalls":[],"response":"On it — I'll handle this in the widget."}

If no tools are needed (casual chat), respond with:
{"thinking":"no tools needed","useAgent":false,"agentServerId":null,"toolCalls":[],"response":"your response"}

Rules:
- Be concise. No walls of text.
- Only call tools that actually match the request.
- For GHL servers: "convos" = conversations, "contacts" = contacts, "deals" = pipeline opportunities.
- Use fetch_* tools for data retrieval. view_* tools return HTML widgets (prefer fetch_*).
- If something fails, state what failed and provide the next best step.
- When creating contacts: split full names into firstName + lastName. MUST include email (generate one like firstname.lastname@example.com if not provided). GHL requires email or phone.
- Tool args must match the schema exactly — use camelCase field names (firstName, lastName, companyName, etc.).
- USE AGENT MODE for: create, update, delete, add, remove, merge, edit, change, modify actions.
- USE DIRECT MODE for: fetch, get, list, search, find, show, count, lookup actions.

Respond with ONLY the JSON object, no markdown fences.`;
}

/**
 * Parse the LLM response JSON, handling common formatting issues.
 */
function parseLlmResponse(raw: string): {
	thinking?: string;
	useAgent?: boolean;
	agentServerId?: string | null;
	toolCalls: Array<{ serverId: string; toolName: string; args: Record<string, unknown> }>;
	response: string;
} {
	let cleaned = raw.trim();

	// Strip markdown fences
	if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
	else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
	if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
	cleaned = cleaned.trim();

	// Try direct JSON parse
	try {
		const parsed = JSON.parse(cleaned);
		return {
			thinking: parsed.thinking,
			useAgent: parsed.useAgent === true,
			agentServerId: typeof parsed.agentServerId === "string" ? parsed.agentServerId : null,
			toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [],
			response: typeof parsed.response === "string" ? parsed.response : cleaned,
		};
	} catch {
		// Try to extract JSON from within the text (LLM might wrap it in explanation)
		const jsonMatch = cleaned.match(/\{[\s\S]*"(?:toolCalls|useAgent)"[\s\S]*\}/);
		if (jsonMatch) {
			try {
				const parsed = JSON.parse(jsonMatch[0]);
				return {
					thinking: parsed.thinking,
					useAgent: parsed.useAgent === true,
					agentServerId: typeof parsed.agentServerId === "string" ? parsed.agentServerId : null,
					toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [],
					response: typeof parsed.response === "string" ? parsed.response : jsonMatch[0],
				};
			} catch {
				// Fall through
			}
		}
		// Last resort — treat entire response as plain text
		return { toolCalls: [], response: cleaned };
	}
}

/**
 * Mount OS chat routes on the Hono app.
 */
export function mountOsChatRoutes(app: Hono): void {
	app.get("/api/os/chat/models", async (c) => {
		try {
			const { options, defaultModelId } = await getChatModelOptions(true);
			return c.json({ options, defaultModelId });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.warn("os-chat", `Chat model listing failed: ${msg}`);
			return c.json({ options: [], defaultModelId: "synthesis", error: msg }, 500);
		}
	});

	app.post("/api/os/chat", async (c) => {
		let body: ChatRequest;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON" }, 400);
		}

		if (!body.message?.trim()) {
			return c.json({ error: "Message is required" }, 400);
		}

		try {
			// Gather available tools from all MCP servers
			const tools = gatherAvailableTools();

			if (tools.length === 0) {
				return c.json({
					response: "No MCP servers are installed yet. Add some from the dock to get started.",
					toolCalls: [],
				});
			}

			// Build prompt and call selected chat model
			const systemPrompt = buildSystemPrompt(tools);

			logger.info("os-chat", `Processing chat message`, {
				message: body.message.slice(0, 100),
				availableTools: tools.length,
			});

			const rawResponse = await callLlm(systemPrompt, body.message, 2048, body.modelId);

			const parsed = parseLlmResponse(rawResponse);

			// If LLM decided this needs the visual agent, return immediately
			// (no tool execution — the dashboard will handle it via agent executor)
			if (parsed.useAgent && parsed.agentServerId) {
				logger.info("os-chat", `Routing to visual agent`, {
					serverId: parsed.agentServerId,
					task: body.message.slice(0, 100),
				});
				return c.json({
					response: parsed.response,
					toolCalls: [],
					useAgent: true,
					agentServerId: parsed.agentServerId,
					agentTask: body.message,
				});
			}

			// Execute tool calls if any
			const toolCallResults: ToolCallResult[] = [];

			if (parsed.toolCalls.length > 0) {
				for (const call of parsed.toolCalls.slice(0, 5)) {
					// Max 5 tool calls
					try {
						logger.info("os-chat", `Calling tool ${call.serverId}/${call.toolName}`, {
							args: JSON.stringify(call.args || {}).slice(0, 500),
						});

						// Call the tool via the marketplace /mcp/call endpoint internally
						const callRes = await fetch(`${getLocalDaemonBaseUrl()}/api/marketplace/mcp/call`, {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									serverId: call.serverId,
									toolName: call.toolName,
									args: call.args || {},
								}),
							},
						);

						const callData = (await callRes.json()) as { success?: boolean; result?: unknown; error?: string };

						if (callData.success) {
							toolCallResults.push({
								tool: call.toolName,
								server: call.serverId,
								result: callData.result,
							});
						} else {
							toolCallResults.push({
								tool: call.toolName,
								server: call.serverId,
								error: callData.error || "Tool call failed",
							});
						}
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						toolCallResults.push({
							tool: call.toolName,
							server: call.serverId,
							error: msg,
						});
					}
				}

				// If we got results, send them back to the LLM for a natural response
				if (toolCallResults.some((r) => r.result)) {
					const resultsText = toolCallResults
						.map((r) => {
							if (r.error) return `${r.tool}: ERROR — ${r.error}`;
							const resultStr =
								typeof r.result === "string" ? r.result.slice(0, 2000) : JSON.stringify(r.result).slice(0, 2000);
							return `${r.tool}: ${resultStr}`;
						})
						.join("\n\n");

					const followUp = `The user asked: "${body.message}"

You called these tools and got these results:
${resultsText}

Now give a concise, natural language summary of the results for the user. Be specific — mention names, numbers, and key details. No JSON, just a friendly response.`;

					try {
						const summary = await callLlm(
							"You are the Signet OS assistant. Summarize tool results clearly and concisely. Mention specific names, numbers, and key details. No JSON.",
							followUp,
							1024,
							body.modelId,
						);
						return c.json({
							response: summary.trim(),
							toolCalls: toolCallResults,
						});
					} catch {
						// If summary fails, return raw response + results
						return c.json({
							response: parsed.response,
							toolCalls: toolCallResults,
						});
					}
				}
			}

			return c.json({
				response: parsed.response,
				toolCalls: toolCallResults,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.warn("os-chat", `Chat error: ${msg}`);
			return c.json({
				response: `Something went wrong: ${msg}`,
				toolCalls: [],
			});
		}
	});

	app.post("/api/os/browser-tool", async (c) => {
		let body: BrowserToolRequest;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON" }, 400);
		}

		const payload = body.payload?.trim();
		if (!payload) {
			return c.json({ error: "Payload is required" }, 400);
		}

		const action = body.action?.trim() || "browser-submission";
		const baseUrl = getLocalDaemonBaseUrl();
		let memoryStored = false;
		let memoryId: string | undefined;
		let dispatched = false;
		let responseText: string | undefined;
		let dispatchError: string | undefined;
		let memoryError: string | undefined;
		let toolCalls: ToolCallResult[] | undefined;

		const links = Array.isArray(body.links) ? body.links.slice(0, 20) : [];
		const images = Array.isArray(body.images) ? body.images.slice(0, 20) : [];
		const videos = Array.isArray(body.videos) ? body.videos.slice(0, 20) : [];
		const audio = Array.isArray(body.audio) ? body.audio.slice(0, 20) : [];
		const files = Array.isArray(body.files) ? body.files.slice(0, 20) : [];

		try {
			const memoryRes = await fetch(`${baseUrl}/api/memory/remember`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: [
						"[Signet Browser Tool]",
						`Action: ${action}`,
						`Title: ${body.pageTitle || "Untitled"}`,
						`URL: ${body.pageUrl || "unknown"}`,
						`Captured At: ${new Date().toISOString()}`,
						"",
						`Selection: ${body.selectedText?.trim() || "(none)"}`,
						`Note: ${body.note?.trim() || "(none)"}`,
						`Links: ${links.length}`,
						`Images: ${images.length}`,
						`Videos: ${videos.length}`,
						`Audio: ${audio.length}`,
						`Files: ${files.length}`,
						"",
						payload.slice(0, 20_000),
					].join("\n"),
					tags: `browser-tool,${action},browser-extension`,
					importance: 0.72,
					type: "note",
					source_type: "browser-extension",
				}),
			});

			if (memoryRes.ok) {
				const memoryData = (await memoryRes.json()) as { success?: boolean; id?: string };
				memoryStored = memoryData.success === true;
				memoryId = memoryData.id;
			} else {
				memoryError = `Memory save failed (${memoryRes.status})`;
			}
		} catch (error) {
			memoryError = error instanceof Error ? error.message : String(error);
		}

		if (body.dispatchToHarness !== false) {
			try {
				const chatRes = await fetch(`${baseUrl}/api/os/chat`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ message: formatBrowserToolMessage({ ...body, payload, action }) }),
				});

				if (chatRes.ok) {
					const chatData = (await chatRes.json()) as {
						response?: string;
						toolCalls?: ToolCallResult[];
					};
					dispatched = true;
					responseText = chatData.response;
					toolCalls = chatData.toolCalls;
				} else {
					dispatchError = `Dispatch failed (${chatRes.status})`;
				}
			} catch (error) {
				dispatchError = error instanceof Error ? error.message : String(error);
			}
		}

		const result: BrowserToolRouteResult = {
			success: memoryStored || dispatched,
			memoryStored,
			dispatched,
			memoryId,
			response: responseText,
			error: memoryStored || dispatched ? undefined : dispatchError || memoryError || "Browser tool failed",
			toolCalls,
		};

		return c.json(result, result.success ? 200 : 500);
	});
}
