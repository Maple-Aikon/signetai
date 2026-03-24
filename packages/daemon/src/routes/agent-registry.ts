import type { Hono } from "hono";
import { logger } from "../logger.js";

export function mountAgentRegistryRoutes(app: Hono): void {
	// POST /api/room/agents/spawn — spawn a new coding agent
	app.post("/api/room/agents/spawn", async (c) => {
		let body: Record<string, unknown>;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON" }, 400);
		}

		const task = typeof body.task === "string" ? body.task.trim() : "";
		const model = typeof body.model === "string" ? body.model : "sonnet";

		if (!task) return c.json({ error: "Task is required" }, 400);

		try {
			const { spawn } = await import("node:child_process");
			const proc = spawn("claude", ["-p", task, "--model", model, "--no-session-persistence"], {
				detached: true,
				stdio: "ignore",
				env: { ...process.env, SIGNET_NO_HOOKS: "1" },
			});
			proc.unref();

			logger.info(`[agent-registry] spawned claude PID=${proc.pid} model=${model}`);

			return c.json({
				ok: true,
				pid: proc.pid,
				model,
				task: task.slice(0, 100),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return c.json({ error: msg }, 500);
		}
	});

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
			toolCount?: number;
		}> = [];

		// Source 1: Read installed MCP servers as tool agents
		try {
			const { readInstalledServersPublic } = await import("./marketplace-helpers.js");
			const servers = readInstalledServersPublic();
			for (const srv of servers) {
				if (!srv.enabled) continue;
				// Try to get tool count from server metadata
				let toolCount: number | undefined;
				try {
					if (srv.tools && Array.isArray(srv.tools)) {
						toolCount = srv.tools.length;
					} else if (typeof srv.toolCount === "number") {
						toolCount = srv.toolCount;
					}
				} catch { /* ignore */ }
				agents.push({
					id: `mcp-${srv.id}`,
					name: srv.name,
					role: "mcp server",
					status: "active",
					source: { type: "mcp", serverId: srv.id },
					lastActivity: `${srv.id} — ${toolCount ? `${toolCount} tools` : "tools available"}`,
					model: null,
					toolCount,
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
