/**
 * OS Chat routes — natural language agent chat for the Signet OS tab.
 *
 * Receives user messages, interprets intent against available MCP tools,
 * and returns agent responses. Currently a stub that acknowledges messages
 * and reports available servers; full LLM routing comes in the next phase.
 */

import type { Hono } from "hono";
import { logger } from "../logger.js";

interface ChatRequest {
	message: string;
}

interface ToolCallResult {
	tool: string;
	server: string;
	result?: unknown;
	error?: string;
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
			// Read installed MCP servers to know what tools are available
			const { readInstalledServersPublic } = await import("./marketplace-helpers.js");
			const servers = readInstalledServersPublic();

			const toolCalls: ToolCallResult[] = [];

			// For now, return a stub response that acknowledges the message.
			// Full LLM integration will use the existing synthesis provider
			// to interpret the message and decide which MCP tools to call.
			return c.json({
				response: `I received your message: "${body.message}". I can see ${servers.length} MCP server${servers.length === 1 ? "" : "s"} available. Full agent routing is coming in the next update — for now, use the widget tools directly.`,
				toolCalls,
				serverCount: servers.length,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.warn("os-chat", `Chat error: ${msg}`);
			return c.json({ error: msg }, 500);
		}
	});
}
