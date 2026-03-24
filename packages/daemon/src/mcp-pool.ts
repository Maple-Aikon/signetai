/**
 * MCP Server Connection Pool
 *
 * Maintains persistent connections to stdio MCP servers so they aren't
 * respawned on every tool call or cache refresh. Connections are
 * created on first use and kept alive until explicitly released
 * (disable/uninstall) or shutdown.
 *
 * HTTP servers don't need pooling — they're stateless fetch calls.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "./logger.js";
import { getSecret } from "./secrets.js";
import type {
	InstalledMarketplaceMcpServer,
	MarketplaceMcpConfigHttp,
	MarketplaceMcpConfigStdio,
} from "./routes/marketplace.js";

interface PoolEntry {
	client: Client | null;
	server: InstalledMarketplaceMcpServer;
	connected: boolean;
	/** Prevent concurrent connect attempts for the same server */
	connecting: Promise<void> | null;
	lastUsed: number;
	useCount: number;
}

const pool = new Map<string, PoolEntry>();

/** In-flight probe guard — prevents double-probe on install */
const probing = new Set<string>();

async function resolveSecretReferences(
	env: Record<string, string> | undefined,
): Promise<Record<string, string>> {
	if (!env) return {};
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string" && value.startsWith("secret://")) {
			const name = value.slice("secret://".length);
			const secret = await getSecret(name);
			if (secret) {
				resolved[key] = secret;
			} else {
				logger.warn("mcp-pool", `Secret not found for env ${key}, keeping reference`, { secret: name });
				resolved[key] = value;
			}
		} else {
			resolved[key] = value;
		}
	}
	return resolved;
}

async function createClient(
	server: InstalledMarketplaceMcpServer,
): Promise<Client> {
	const client = new Client({
		name: "signet-mcp-pool",
		version: "0.1.0",
	});

	if (server.config.transport === "stdio") {
		const runtimeEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (typeof v === "string") runtimeEnv[k] = v;
		}
		const cfg = server.config as MarketplaceMcpConfigStdio;
		const resolvedEnv = await resolveSecretReferences(cfg.env);
		const transport = new StdioClientTransport({
			command: cfg.command,
			args: [...cfg.args],
			env: { ...runtimeEnv, ...resolvedEnv },
			cwd: cfg.cwd,
		});
		await client.connect(transport);
		return client;
	}

	// HTTP transport — ephemeral, but still pool the Client for consistency
	const cfg = server.config as MarketplaceMcpConfigHttp;
	const resolvedHeaders = await resolveSecretReferences(cfg.headers);
	const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
		requestInit: { headers: resolvedHeaders },
	});
	await client.connect(transport);
	return client;
}

/**
 * Get or create a pooled connection. The client is kept alive for reuse.
 * Callers must NOT close the client — the pool manages lifecycle.
 */
export async function getPooledClient(
	server: InstalledMarketplaceMcpServer,
): Promise<Client> {
	const existing = pool.get(server.id);

	if (existing?.connected && existing.client) {
		existing.lastUsed = Date.now();
		existing.useCount++;
		return existing.client;
	}

	// Wait for in-flight connect if another caller is already connecting
	if (existing?.connecting) {
		await existing.connecting;
		if (existing.connected && existing.client) {
			existing.lastUsed = Date.now();
			existing.useCount++;
			return existing.client;
		}
	}

	// Create new connection
	const entry: PoolEntry = {
		client: null,
		server,
		connected: false,
		connecting: null,
		lastUsed: Date.now(),
		useCount: 0,
	};

	const connectPromise = (async () => {
		try {
			const client = await createClient(server);
			entry.client = client;
			entry.connected = true;
			entry.useCount = 1;
			logger.info("mcp-pool", "Connection established", { server: server.id });
		} catch (err) {
			// Remove poisoned entry so next caller retries fresh
			pool.delete(server.id);
			throw err;
		} finally {
			entry.connecting = null;
		}
	})();

	entry.connecting = connectPromise;
	pool.set(server.id, entry);

	await connectPromise;
	if (!entry.client) throw new Error(`Failed to connect to ${server.id}`);
	return entry.client;
}

/**
 * Execute a function with a pooled MCP client. Unlike withConnectedClient,
 * this does NOT spawn a new process each time.
 */
export async function withPooledClient<T>(
	server: InstalledMarketplaceMcpServer,
	fn: (client: Client) => Promise<T>,
	timeoutMs?: number,
): Promise<T> {
	const client = await getPooledClient(server);
	const timeout = timeoutMs ?? server.config.timeoutMs;

	const work = fn(client);

	if (timeout <= 0) return work;

	let timer: ReturnType<typeof setTimeout> | null = null;
	return Promise.race([
		work,
		new Promise<T>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`MCP call timed out after ${timeout}ms for ${server.id}`)), timeout);
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/** Release a specific server's connection (on disable/uninstall). */
export async function releaseServer(serverId: string): Promise<void> {
	const entry = pool.get(serverId);
	if (!entry) return;
	pool.delete(serverId);
	// Wait for in-flight connect to finish before closing
	if (entry.connecting) {
		try { await entry.connecting; } catch { /* connect failed — nothing to close */ }
	}
	if (entry.connected && entry.client) {
		try {
			await entry.client.close();
		} catch {
			// best-effort
		}
	}
	logger.info("mcp-pool", "Connection released", { server: serverId });
}

/** Check if a server is currently probing (dedup guard). */
export function isProbing(serverId: string): boolean {
	return probing.has(serverId);
}

/** Mark a server as probing. Returns false if already probing. */
export function startProbe(serverId: string): boolean {
	if (probing.has(serverId)) return false;
	probing.add(serverId);
	return true;
}

/** Clear probe guard. */
export function endProbe(serverId: string): void {
	probing.delete(serverId);
}

/** Shut down all pooled connections (for graceful shutdown). */
export async function shutdownPool(): Promise<void> {
	const entries = [...pool.values()];
	pool.clear();
	probing.clear();
	await Promise.allSettled(
		entries.map(async (entry) => {
			if (entry.connected && entry.client) {
				await entry.client.close().catch(() => undefined);
			}
		}),
	);
	logger.info("mcp-pool", "All connections closed", { count: entries.length });
}

/** Get pool stats for diagnostics. */
export function getPoolStats(): {
	active: number;
	servers: Array<{ id: string; useCount: number; lastUsed: number }>;
} {
	const servers = [...pool.entries()].map(([id, entry]) => ({
		id,
		useCount: entry.useCount,
		lastUsed: entry.lastUsed,
	}));
	return { active: pool.size, servers };
}
