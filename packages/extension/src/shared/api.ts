/**
 * API client for Signet daemon
 * Mirrors the dashboard pattern — simple async functions with fetch()
 */

import { getConfig } from "./config.js";
import type {
	BrowserToolRequest,
	BrowserToolResult,
	DaemonStatus,
	HealthResponse,
	Identity,
	Memory,
	MemoryStats,
	PipelineStatus,
	RecallResult,
	RememberRequest,
} from "./types.js";

async function getBaseUrl(): Promise<string> {
	const config = await getConfig();
	return config.daemonUrl;
}

async function getHeaders(): Promise<Record<string, string>> {
	const config = await getConfig();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (config.authToken) {
		headers["Authorization"] = `Bearer ${config.authToken}`;
	}
	return headers;
}

async function fetchApi<T>(path: string, options?: RequestInit, timeoutMs = 10_000): Promise<T | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const base = await getBaseUrl();
		const headers = await getHeaders();
		const response = await fetch(`${base}${path}`, {
			...options,
			headers: { ...headers, ...options?.headers },
			signal: options?.signal ?? controller.signal,
		});
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

// --- Health & Status ---

export async function checkHealth(): Promise<HealthResponse | null> {
	return fetchApi<HealthResponse>("/health");
}

export async function getStatus(): Promise<DaemonStatus | null> {
	return fetchApi<DaemonStatus>("/api/status");
}

export async function getIdentity(): Promise<Identity | null> {
	return fetchApi<Identity>("/api/identity");
}

export async function getPipelineStatus(): Promise<PipelineStatus | null> {
	return fetchApi<PipelineStatus>("/api/pipeline/status");
}

// --- Memory ---

export async function getMemories(
	limit = 10,
	offset = 0,
): Promise<{ memories: readonly Memory[]; stats: MemoryStats }> {
	const result = await fetchApi<{ memories: Memory[]; stats: MemoryStats }>(
		`/api/memories?limit=${limit}&offset=${offset}`,
	);
	return result ?? { memories: [], stats: { total: 0, withEmbeddings: 0, critical: 0 } };
}

export async function recallMemories(query: string, limit = 10): Promise<RecallResult> {
	const result = await fetchApi<{ memories?: Memory[]; results?: Memory[]; query?: string; count?: number }>(
		"/api/memory/recall",
		{
			method: "POST",
			body: JSON.stringify({ query, limit }),
		},
	);
	const memories = Array.isArray(result?.memories)
		? result.memories
		: Array.isArray(result?.results)
			? result.results
			: [];
	return {
		memories,
		query: result?.query ?? query,
		count: typeof result?.count === "number" ? result.count : memories.length,
	};
}

export async function rememberMemory(request: RememberRequest): Promise<{ success: boolean; id?: string }> {
	const result = await fetchApi<{ success: boolean; id?: string }>("/api/memory/remember", {
		method: "POST",
		body: JSON.stringify(request),
	});
	return result ?? { success: false };
}

export async function dispatchBrowserTool(request: BrowserToolRequest): Promise<BrowserToolResult> {
	const result = await fetchApi<BrowserToolResult>("/api/os/browser-tool", {
		method: "POST",
		body: JSON.stringify(request),
	}, 20_000);

	return (
		result ?? {
			success: false,
			memoryStored: false,
			dispatched: false,
			error: "Browser tool dispatch failed",
		}
	);
}
