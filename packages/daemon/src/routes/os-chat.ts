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
	const { readInstalledServersPublic } = require("./marketplace-helpers.js");
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

function parse(raw: string): ParsedResponse {
	let text = raw.trim();
	if (text.startsWith("```json")) text = text.slice(7);
	if (text.startsWith("```")) text = text.slice(3);
	if (text.endsWith("```")) text = text.slice(0, -3);
	text = text.trim();

	try {
		const d = JSON.parse(text);
		return {
			thinking: d.thinking,
			toolCalls: Array.isArray(d.toolCalls) ? d.toolCalls : [],
			response: typeof d.response === "string" ? d.response : text,
		};
	} catch {
		// Try extracting JSON from surrounding text
		const m = text.match(/\{[\s\S]*"toolCalls"[\s\S]*\}/);
		if (m) {
			try {
				const d = JSON.parse(m[0]);
				return {
					thinking: d.thinking,
					toolCalls: Array.isArray(d.toolCalls) ? d.toolCalls : [],
					response: typeof d.response === "string" ? d.response : m[0],
				};
			} catch { /* fall through */ }
		}
		return { toolCalls: [], response: text };
	}
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

			// Execute tool calls (max 5)
			for (const call of parsed.toolCalls.slice(0, 5)) {
				try {
					logger.info("os-chat", `Calling ${call.serverId}/${call.toolName}`, {
						args: JSON.stringify(call.args || {}).slice(0, 500),
					});

					const port = process.env.SIGNET_PORT || 3850;
					const res = await fetch(`http://127.0.0.1:${port}/api/marketplace/mcp/call`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							serverId: call.serverId,
							toolName: call.toolName,
							args: call.args || {},
						}),
					});

					const data = await res.json() as Record<string, unknown>;
					if (data.success) {
						results.push({ tool: call.toolName, server: call.serverId, result: data.result });
					} else {
						results.push({ tool: call.toolName, server: call.serverId, error: String(data.error || "failed") });
					}
				} catch (err) {
					results.push({
						tool: call.toolName,
						server: call.serverId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
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
