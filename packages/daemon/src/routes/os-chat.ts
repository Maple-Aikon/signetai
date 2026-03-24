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
	const list = tools
		.map((t) => {
			const s = t.schema ? ` Args: ${JSON.stringify(t.schema).slice(0, 200)}` : "";
			return `- ${t.server}/${t.name}: ${t.desc}${s}`;
		})
		.join("\n");

	return `You are Oogie — a direct, dorky, helpful AI assistant. Keep it casual. Use keyboard emojis like (╯°□°)╯ occasionally. Never use unicode emojis.

Available MCP tools:
${list}

Respond in JSON only:
{"thinking":"...","toolCalls":[{"serverId":"id","toolName":"name","args":{}}],"response":"..."}

No tools needed? Use empty toolCalls array.

Rules:
- concise, no walls of text
- "convos" = conversations, "contacts" = contacts, "deals" = pipeline
- split names into firstName + lastName for contacts
- always include email when creating contacts (generate firstname.lastname@example.com if not given)
- args must use camelCase (firstName, lastName, companyName)
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

			const provider = getSynthesisProvider();
			const prompt = buildPrompt(tools, message);

			logger.info("os-chat", "Processing message", {
				message: message.slice(0, 100),
				tools: tools.length,
				provider: provider.name,
			});

			const raw = await generateWithTracking(provider, prompt, {
				maxTokens: 2048,
				timeoutMs: 30000,
			});

			const parsed = parse(raw.text);
			const results: ToolResult[] = [];

			// Build set of valid tool keys for validation
			const validTools = new Set(tools.map((t) => `${t.server}/${t.name}`));

			// Execute tool calls (max 5)
			const port = process.env.SIGNET_PORT || 3850;
			for (const call of parsed.toolCalls.slice(0, 5)) {
				const result = await executeToolCall(call, validTools, port);
				results.push(result);
			}

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
					const summary = await generateWithTracking(provider, buildSummary(message, text), {
						maxTokens: 1024,
						timeoutMs: 20000,
					});
					return c.json({ response: summary.text.trim(), toolCalls: results });
				} catch {
					return c.json({ response: parsed.response, toolCalls: results });
				}
			}

			return c.json({ response: parsed.response, toolCalls: results });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn("os-chat", `Chat error: ${msg}`);
			return c.json({ response: `Something went wrong: ${msg}`, toolCalls: [] });
		}
	});
}
