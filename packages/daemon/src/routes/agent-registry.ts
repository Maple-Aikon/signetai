import type { Hono } from "hono";
import { logger } from "../logger.js";

export function mountAgentRegistryRoutes(app: Hono): void {
	// GET /api/room/agents — list all discovered agents
	app.get("/api/room/agents", async (c) => {
		const agents: Array<{
			id: string;
			name: string;
			role: string;
			status: string;
			source: { type: string; [key: string]: unknown };
			lastActivity: string;
			model: string | null;
		}> = [];

		// Source 1: Read installed MCP servers as tool agents
		try {
			const { readInstalledServersPublic } = await import("./marketplace-helpers.js");
			const servers = readInstalledServersPublic();
			for (const srv of servers) {
				if (!srv.enabled) continue;
				agents.push({
					id: `mcp-${srv.id}`,
					name: srv.name,
					role: "mcp server",
					status: "active",
					source: { type: "mcp", serverId: srv.id },
					lastActivity: `${srv.id} — tools available`,
					model: null,
				});
			}
		} catch {
			/* no marketplace helpers available */
		}

		// Source 2: Check for running coding agent processes
		try {
			const { execSync } = await import("node:child_process");
			const ps = execSync("ps aux", { encoding: "utf-8" });
			const lines = ps.split("\n");

			for (const line of lines) {
				if (line.includes("claude") && !line.includes("grep") && !line.includes("daemon.ts")) {
					const parts = line.trim().split(/\s+/);
					const pid = parseInt(parts[1] || "0", 10);
					if (pid > 0) {
						agents.push({
							id: `proc-claude-${pid}`,
							name: "Claude Code",
							role: "coding agent",
							status: "active",
							source: { type: "process", pid, name: "claude" },
							lastActivity: `PID ${pid}`,
							model: null,
						});
					}
				}
				if (line.includes("codex") && !line.includes("grep")) {
					const parts = line.trim().split(/\s+/);
					const pid = parseInt(parts[1] || "0", 10);
					if (pid > 0) {
						agents.push({
							id: `proc-codex-${pid}`,
							name: "Codex",
							role: "coding agent",
							status: "active",
							source: { type: "process", pid, name: "codex" },
							lastActivity: `PID ${pid}`,
							model: null,
						});
					}
				}
			}
		} catch {
			/* ps failed */
		}

		return c.json({ agents });
	});
}
