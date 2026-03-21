/**
 * OS Chat routes — natural language agent chat for the Signet OS tab.
 *
 * Receives user messages, interprets intent against available MCP tools
 * using the synthesis LLM provider, executes matching tools, and returns
 * agent responses with tool call results.
 */

import type { Hono } from "hono";
import { logger } from "../logger.js";
import { getSynthesisProvider } from "../synthesis-llm.js";
import { getWidgetProvider } from "../widget-llm.js";
import { getSecret } from "../secrets.js";

/** Cached API key */
let cachedApiKey: string | null = null;

/**
 * Call OpenAI API (GPT-4o) for chat routing.
 * Falls back through: OPENAI_API_KEY env → signet secrets.
 */
async function callLlm(systemPrompt: string, userMessage: string, maxTokens = 2048): Promise<string> {
	if (!cachedApiKey) {
		cachedApiKey = process.env.OPENAI_API_KEY || await getSecret("OPENAI_API_KEY").catch(() => "");
	}
	const apiKey = cachedApiKey;
	if (!apiKey) throw new Error("OPENAI_API_KEY not found in env or secrets");

	const res = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: "gpt-4o",
			max_tokens: maxTokens,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userMessage },
			],
		}),
	});

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`OpenAI API ${res.status}: ${errText.slice(0, 200)}`);
	}

	const data = await res.json() as { choices: Array<{ message: { content: string } }> };
	return data.choices?.[0]?.message?.content ?? "";
}
import { loadProbeResult } from "../mcp-probe.js";

interface ChatRequest {
	message: string;
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
	const toolList = tools
		.map((t) => `- ${t.serverId}/${t.toolName}: ${t.description}`)
		.join("\n");

	return `You are the Signet OS agent. The user is chatting with you in the dashboard.
You have access to MCP tools via installed servers. Here are the available tools:

${toolList}

When the user asks a question or makes a request:
1. Determine which tool(s) to call to answer their question
2. Respond in this JSON format:

{"thinking":"brief reasoning about what to do","toolCalls":[{"serverId":"server-id","toolName":"tool_name","args":{}}],"response":"your natural language response to the user"}

If no tools are needed (e.g. casual chat), respond with:
{"thinking":"no tools needed","toolCalls":[],"response":"your response here"}

Important:
- Keep responses concise and conversational
- Only call tools that are relevant to the user's request
- The "response" field should be a natural language answer, not raw data
- If you call tools, the results will be appended — write your response assuming you'll see the results
- Use the tool descriptions to match user intent to the right tools
- For GHL (GoHighLevel) servers: "convos" = conversations, "contacts" = contacts, "deals" = pipeline opportunities

Respond with ONLY the JSON object, no markdown fences.`;
}

/**
 * Parse the LLM response JSON, handling common formatting issues.
 */
function parseLlmResponse(raw: string): {
	thinking?: string;
	toolCalls: Array<{ serverId: string; toolName: string; args: Record<string, unknown> }>;
	response: string;
} {
	// Strip markdown fences if present
	let cleaned = raw.trim();
	if (cleaned.startsWith("```json")) {
		cleaned = cleaned.slice(7);
	} else if (cleaned.startsWith("```")) {
		cleaned = cleaned.slice(3);
	}
	if (cleaned.endsWith("```")) {
		cleaned = cleaned.slice(0, -3);
	}
	cleaned = cleaned.trim();

	try {
		const parsed = JSON.parse(cleaned);
		return {
			thinking: parsed.thinking,
			toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [],
			response: typeof parsed.response === "string" ? parsed.response : cleaned,
		};
	} catch {
		// If JSON parsing fails, treat the whole thing as a plain response
		return { toolCalls: [], response: cleaned };
	}
}

/**
 * Mount OS chat routes on the Hono app.
 */
export function mountOsChatRoutes(app: Hono): void {
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

			// Build prompt and call Anthropic API directly
			const systemPrompt = buildSystemPrompt(tools);

			logger.info("os-chat", `Processing chat message`, {
				message: body.message.slice(0, 100),
				availableTools: tools.length,
			});

			const rawResponse = await callLlm(systemPrompt, body.message);

			const parsed = parseLlmResponse(rawResponse);

			// Execute tool calls if any
			const toolCallResults: ToolCallResult[] = [];

			if (parsed.toolCalls.length > 0) {
				// Dynamic import to avoid circular deps
				const marketplaceModule = await import("./marketplace.js");
				const { readInstalledServersPublic } = await import("./marketplace-helpers.js");

				for (const call of parsed.toolCalls.slice(0, 5)) { // Max 5 tool calls
					try {
						logger.info("os-chat", `Calling tool ${call.serverId}/${call.toolName}`);

						// Call the tool via the marketplace /mcp/call endpoint internally
						const callRes = await fetch(`http://127.0.0.1:${process.env.SIGNET_PORT || 3850}/api/marketplace/mcp/call`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								serverId: call.serverId,
								toolName: call.toolName,
								args: call.args || {},
							}),
						});

						const callData = await callRes.json() as { success?: boolean; result?: unknown; error?: string };

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
							const resultStr = typeof r.result === "string"
								? r.result.slice(0, 2000)
								: JSON.stringify(r.result).slice(0, 2000);
							return `${r.tool}: ${resultStr}`;
						})
						.join("\n\n");

					const followUp = `The user asked: "${body.message}"

You called these tools and got these results:
${resultsText}

Now give a concise, natural language summary of the results for the user. Be specific — mention names, numbers, and key details. No JSON, just a friendly response.`;

					try {
						const summary = await callLlm(
							"You are the Signet OS agent. Summarize tool results concisely and conversationally. Mention specific names, numbers, and details. No JSON.",
							followUp,
							1024,
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
}
