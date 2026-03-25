/**
 * OS Chat routes — natural language agent chat for the Signet OS tab.
 *
 * Routes user messages through the synthesis LlmProvider, interprets
 * intent against installed MCP tools, executes matching tools, and
 * returns agent responses. Uses the same provider abstraction as
 * synthesis-worker and widget-gen.
 */

import type { Hono } from "hono";
import { logger } from "../logger.js";
import { getSynthesisProvider } from "../synthesis-llm.js";
import { loadProbeResult } from "../mcp-probe.js";
import { generateWithTracking } from "../pipeline/provider.js";
import { readInstalledServersPublic } from "./marketplace-helpers.js";

// ---------------------------------------------------------------------------
// Fast LLM path — direct OpenAI API for low-latency chat
// Falls back to synthesis provider if no API key available
// ---------------------------------------------------------------------------

async function chatLlm(prompt: string, maxTokens = 2048): Promise<string> {
	const key = process.env.OPENAI_API_KEY;
	if (key) {
		const res = await fetch("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
			body: JSON.stringify({
				model: "gpt-4o",
				max_tokens: maxTokens,
				messages: [{ role: "user", content: prompt }],
			}),
		});
		if (res.ok) {
			const data: unknown = await res.json();
			if (isRecord(data) && Array.isArray(data.choices)) {
				const first = data.choices[0];
				if (isRecord(first) && isRecord(first.message) && typeof first.message.content === "string") {
					return first.message.content;
				}
			}
		}
		// If 429 or other error, fall through to synthesis provider
		logger.warn("os-chat", `OpenAI fast path failed (${res.status}), falling back to synthesis`);
	}
	// Fallback: synthesis provider (claude-code, slower but always works)
	const provider = getSynthesisProvider();
	const result = await generateWithTracking(provider, prompt, { maxTokens, timeoutMs: 30000 });
	return result.text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** JSON.parse that returns null on failure instead of throwing. */
function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

interface ToolCallResult {
	readonly ok: boolean;
	readonly tool: string;
	readonly server: string;
	readonly result?: unknown;
	readonly error?: string;
}

interface CursorStep {
	action: "move" | "type" | "wait";
	target?: string;
	click?: boolean;
	text?: string;
	ms?: number;
}

/**
 * Generate visual cursor automation steps for mutation tool calls.
 * These steps drive an animated cursor inside the widget iframe,
 * showing the user what the agent "did" visually.
 */
function generateCursorSteps(
	results: readonly ToolResult[],
	toolCalls: ReadonlyArray<{ serverId: string; toolName: string; args: Record<string, unknown> }>,
): CursorStep[] {
	const steps: CursorStep[] = [];

	for (let i = 0; i < toolCalls.length; i++) {
		const call = toolCalls[i];
		if (!call) continue;
		const args = call.args || {};

		if (call.toolName.startsWith("create_")) {
			const entity = call.toolName.replace("create_", "");
			const firstName = String(args.firstName || args.first_name || "");
			const lastName = String(args.lastName || args.last_name || "");
			const email = String(args.email || "");
			const company = String(args.companyName || args.company || "");
			const name = String(args.name || args.title || args.dealName || "");

			// Click the "+ New" button
			steps.push({ action: "move", target: `new ${entity}`, click: true });
			steps.push({ action: "wait", ms: 800 });

			// Fill in fields
			if (firstName) {
				steps.push({ action: "move", target: "first name", click: true });
				steps.push({ action: "type", text: firstName });
			}
			if (lastName) {
				steps.push({ action: "move", target: "last name", click: true });
				steps.push({ action: "type", text: lastName });
			}
			if (email) {
				steps.push({ action: "move", target: "email", click: true });
				steps.push({ action: "type", text: email });
			}
			if (company) {
				steps.push({ action: "move", target: "company", click: true });
				steps.push({ action: "type", text: company });
			}
			if (name && !firstName) {
				steps.push({ action: "move", target: "name", click: true });
				steps.push({ action: "type", text: name });
			}

			// Click save/create button
			steps.push({ action: "wait", ms: 300 });
			steps.push({ action: "move", target: `create ${entity}`, click: true });
		} else if (call.toolName.startsWith("update_")) {
			const target = String(args.firstName || args.name || args.title || "");
			if (target) {
				steps.push({ action: "move", target, click: true });
				steps.push({ action: "wait", ms: 600 });
			}
			steps.push({ action: "move", target: "edit", click: true });
			steps.push({ action: "wait", ms: 500 });
			for (const [key, val] of Object.entries(args)) {
				if (["id", "contactId", "dealId"].includes(key) || val == null) continue;
				steps.push({ action: "move", target: key.replace(/([A-Z])/g, " $1").toLowerCase(), click: true });
				steps.push({ action: "type", text: String(val) });
			}
			steps.push({ action: "move", target: "save", click: true });
		} else if (call.toolName.startsWith("delete_")) {
			const name = String(args.name || args.firstName || args.title || "");
			if (name) {
				steps.push({ action: "move", target: name, click: true });
				steps.push({ action: "wait", ms: 400 });
			}
			steps.push({ action: "move", target: "delete", click: true });
			steps.push({ action: "wait", ms: 300 });
		}
	}

	return steps;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolSpec {
	readonly server: string;
	readonly name: string;
	readonly desc: string;
	readonly schema?: unknown;
}

interface ParsedResponse {
	readonly thinking?: string;
	readonly useAgent?: boolean;
	readonly agentServerId?: string;
	readonly agentTask?: string;
	readonly toolCalls: ReadonlyArray<{ serverId: string; toolName: string; args: Record<string, unknown> }>;
	readonly response: string;
}

interface ToolResult {
	readonly tool: string;
	readonly server: string;
	readonly result?: unknown;
	readonly error?: string;
}

// ---------------------------------------------------------------------------
// Tool discovery
// ---------------------------------------------------------------------------

function gatherTools(): ToolSpec[] {
	const servers = readInstalledServersPublic();
	const out: ToolSpec[] = [];

	for (const srv of servers) {
		if (!srv.enabled) continue;
		const probe = loadProbeResult(srv.id);
		if (!probe?.ok || !probe.autoCard?.tools) continue;

		for (const t of probe.autoCard.tools) {
			// Skip view_* / check_* tools — they return HTML widgets, not data
			if (t.name.startsWith("view_") || t.name.startsWith("check_")) continue;
			out.push({
				server: srv.id,
				name: t.name,
				desc: t.description || "",
				schema: t.inputSchema,
			});
		}
	}

	return out;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(tools: readonly ToolSpec[], message: string): string {
	// Group tools by server and keep descriptions short to minimize prompt size
	const byServer = new Map<string, string[]>();
	for (const t of tools) {
		const srv = t.server;
		if (!byServer.has(srv)) byServer.set(srv, []);
		const desc = t.desc.length > 60 ? t.desc.slice(0, 57) + "..." : t.desc;
		byServer.get(srv)?.push(`  ${t.name}: ${desc}`);
	}
	const list = [...byServer.entries()]
		.map(([srv, items]) => `[${srv}]\n${items.join("\n")}`)
		.join("\n");

	return `You are Oogie — a direct, dorky, helpful AI assistant. Keep it casual. Use keyboard emojis like (╯°□°)╯ occasionally. Never use unicode emojis.

Available MCP tools:
${list}

IMPORTANT: There are TWO modes:

**READ MODE** — for fetching/searching/listing data. Use toolCalls:
{"thinking":"...","useAgent":false,"toolCalls":[{"serverId":"id","toolName":"name","args":{}}],"response":"..."}

**AGENT MODE** — for creating/updating/deleting/modifying data. An AI cursor will visually perform the action in the app UI. Do NOT include toolCalls — the agent handles everything:
{"thinking":"needs visual agent","useAgent":true,"agentServerId":"ghl-contacts-hub","agentTask":"Create a contact named John Smith with email john@example.com","toolCalls":[],"response":"watch the contacts app — cursor is on it"}

Use AGENT MODE for: create, add, update, edit, delete, remove, merge, change, modify, send, book, schedule
Use READ MODE for: fetch, get, list, search, find, show, count, lookup, check

Rules:
- concise, no walls of text
- "convos" = conversations, "contacts" = contacts, "deals" = pipeline
- split names into firstName + lastName in the agentTask description
- always include email when creating contacts (generate firstname.lastname@example.com if not given)
- JSON only, no markdown fences

User: ${message}`;
}

function buildSummary(message: string, results: string): string {
	return `Summarize these tool results casually. Mention specific names, numbers, details. No JSON. Use keyboard emojis sparingly.

User asked: "${message}"

Results:
${results}`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function extractParsed(d: unknown, fallback: string): ParsedResponse {
	if (!isRecord(d)) return { toolCalls: [], response: fallback };
	return {
		thinking: typeof d.thinking === "string" ? d.thinking : undefined,
		useAgent: d.useAgent === true,
		agentServerId: typeof d.agentServerId === "string" ? d.agentServerId : undefined,
		agentTask: typeof d.agentTask === "string" ? d.agentTask : undefined,
		toolCalls: Array.isArray(d.toolCalls) ? d.toolCalls : [],
		response: typeof d.response === "string" ? d.response : fallback,
	};
}

function parse(raw: string): ParsedResponse {
	let text = raw.trim();
	if (text.startsWith("```json")) text = text.slice(7);
	if (text.startsWith("```")) text = text.slice(3);
	if (text.endsWith("```")) text = text.slice(0, -3);
	text = text.trim();

	const d = safeJsonParse(text);
	if (d !== null) return extractParsed(d, text);

	// Try extracting JSON from surrounding text
	const m = text.match(/\{[\s\S]*"toolCalls"[\s\S]*\}/);
	if (m) {
		const nested = safeJsonParse(m[0]);
		if (nested !== null) return extractParsed(nested, m[0]);
	}
	return { toolCalls: [], response: text };
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeToolCall(
	call: { serverId: string; toolName: string; args?: Record<string, unknown> },
	validTools: Set<string>,
	port: string | number,
): Promise<ToolResult> {
	const key = `${call.serverId}/${call.toolName}`;
	if (!validTools.has(key)) {
		return { tool: call.toolName, server: call.serverId, error: "unknown tool" };
	}

	logger.info("os-chat", `Calling ${key}`, {
		args: JSON.stringify(call.args || {}).slice(0, 500),
	});

	const res = await fetch(`http://127.0.0.1:${port}/api/marketplace/mcp/call`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			serverId: call.serverId,
			toolName: call.toolName,
			args: call.args || {},
		}),
	}).catch((err: unknown) => {
		return err instanceof Error ? err : new Error(String(err));
	});

	if (res instanceof Error) {
		return { tool: call.toolName, server: call.serverId, error: res.message };
	}

	const raw: unknown = await res.json().catch(() => null);
	if (isRecord(raw) && raw.success) {
		return { tool: call.toolName, server: call.serverId, result: raw.result };
	}
	const errMsg = isRecord(raw) ? String(raw.error || "failed") : "failed";
	return { tool: call.toolName, server: call.serverId, error: errMsg };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function mountOsChatRoutes(app: Hono): void {
	app.post("/api/os/chat", async (c) => {
		let body: Record<string, unknown>;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON" }, 400);
		}

		const message = typeof body.message === "string" ? body.message.trim() : "";
		if (!message) return c.json({ error: "Message is required" }, 400);

		try {
			const tools = gatherTools();
			if (tools.length === 0) {
				return c.json({
					response: "No MCP servers installed yet. Add some from the dock to get started.",
					toolCalls: [],
				});
			}

			const prompt = buildPrompt(tools, message);

			logger.info("os-chat", "Processing message", {
				message: message.slice(0, 100),
				tools: tools.length,
			});

			const raw = await chatLlm(prompt);
			const parsed = parse(raw);

			// If LLM decided this needs the visual agent, return immediately.
			// The dashboard will use POST /api/os/agent-execute for real
			// observe→think→act loop with PageController cursor.
			if (parsed.useAgent && parsed.agentServerId) {
				logger.info("os-chat", "Routing to visual agent", {
					server: parsed.agentServerId,
					task: (parsed.agentTask || message).slice(0, 100),
				});
				return c.json({
					response: parsed.response,
					toolCalls: [],
					useAgent: true,
					agentServerId: parsed.agentServerId,
					agentTask: parsed.agentTask || message,
				});
			}

			const results: ToolResult[] = [];

			// Build set of valid tool keys for validation
			const validTools = new Set(tools.map((t) => `${t.server}/${t.name}`));

			// Split tool calls: mutations go through visual cursor, reads go through API
			const mutations: typeof parsed.toolCalls[number][] = [];
			const reads: typeof parsed.toolCalls[number][] = [];
			for (const call of parsed.toolCalls.slice(0, 5)) {
				const t = call.toolName;
				if (t.startsWith("create_") || t.startsWith("update_") || t.startsWith("delete_") || t.startsWith("add_") || t.startsWith("remove_") || t.startsWith("merge_")) {
					mutations.push(call);
				} else {
					reads.push(call);
				}
			}

			// Execute read-only calls via API
			const port = process.env.SIGNET_PORT || 3850;
			for (const call of reads) {
				const result = await executeToolCall(call, validTools, port);
				results.push(result);
			}

			// Mutations: don't call API — generate cursor steps for visual automation
			// The cursor will drive the widget UI which handles the actual creation
			for (const call of mutations) {
				results.push({ tool: call.toolName, server: call.serverId, result: { visualCursor: true } });
			}

			// Generate cursor steps from the mutation calls
			const cursorSteps = generateCursorSteps(results, [...reads, ...mutations]);

			// Summarize results through the provider
			if (results.some((r) => r.result)) {
				const text = results
					.map((r) => {
						if (r.error) return `${r.tool}: ERROR — ${r.error}`;
						const s = typeof r.result === "string" ? r.result : JSON.stringify(r.result);
						return `${r.tool}: ${s.slice(0, 2000)}`;
					})
					.join("\n\n");

				try {
					const summary = await chatLlm(buildSummary(message, text), 1024);
					return c.json({ response: summary.trim(), toolCalls: results, cursorSteps });
				} catch {
					return c.json({ response: parsed.response, toolCalls: results, cursorSteps });
				}
			}

			return c.json({ response: parsed.response, toolCalls: results, cursorSteps });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn("os-chat", `Chat error: ${msg}`);
			return c.json({ response: `Something went wrong: ${msg}`, toolCalls: [] });
		}
	});
}
