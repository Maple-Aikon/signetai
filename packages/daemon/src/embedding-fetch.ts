import { logger } from "./logger";
import type { EmbeddingConfig } from "./memory-config";
import { DEFAULT_LLAMACPP_BASE_URL, DEFAULT_OLLAMA_BASE_URL, DEFAULT_OPENAI_BASE_URL } from "./memory-config";
import { getSecret } from "./secrets.js";

export function resolveOllamaUrl(): string {
	const raw = process.env.OLLAMA_HOST;
	if (!raw) return DEFAULT_OLLAMA_BASE_URL;
	try {
		new URL(raw);
		return raw;
	} catch {
		logger.warn("embedding", `OLLAMA_HOST is not a valid URL ("${raw}"), falling back to default`);
		return DEFAULT_OLLAMA_BASE_URL;
	}
}

let cachedNativeEmbed: ((text: string) => Promise<number[]>) | null = null;
let nativeFallbackProvider: "llama-cpp" | "ollama" | null = null;

export function setNativeFallbackProvider(provider: "llama-cpp" | "ollama" | null): void {
	nativeFallbackProvider = provider;
}

async function fetchOllamaEmbedding(text: string, baseUrl: string, model: string): Promise<number[] | null> {
	const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/embeddings`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model, prompt: text }),
		signal: AbortSignal.timeout(30000),
	});
	if (!res.ok) {
		logger.warn("embedding", "Ollama embedding request failed", {
			status: res.status,
			model,
		});
		return null;
	}
	const data = (await res.json()) as { embedding: number[] };
	return data.embedding ?? null;
}

export function resolveEmbeddingBaseUrl(cfg: EmbeddingConfig): string {
	if (cfg.provider === "openai") {
		return cfg.base_url.trim() || DEFAULT_OPENAI_BASE_URL;
	}
	if (cfg.provider === "llama-cpp") {
		return cfg.base_url.trim() || DEFAULT_LLAMACPP_BASE_URL;
	}
	return cfg.base_url;
}

export function requiresOpenAiApiKey(baseUrl: string): boolean {
	try {
		const parsed = new URL(baseUrl.trim());
		return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname === "api.openai.com";
	} catch {
		return false;
	}
}

export async function resolveEmbeddingApiKey(rawApiKey: string | undefined): Promise<string> {
	const configured = rawApiKey?.trim() ?? "";
	if (configured.startsWith("$secret:")) {
		const secretName = configured.slice("$secret:".length).trim();
		return secretName ? getSecret(secretName) : "";
	}
	if (configured.startsWith("op://")) {
		return getSecret(configured);
	}
	return configured || process.env.OPENAI_API_KEY || "";
}

export async function fetchEmbedding(text: string, cfg: EmbeddingConfig): Promise<number[] | null> {
	if (cfg.provider === "none") return null;
	try {
		if (cfg.provider === "native") {
			if (nativeFallbackProvider === "ollama") {
				return await fetchOllamaEmbedding(text, resolveOllamaUrl(), "nomic-embed-text");
			}
			if (nativeFallbackProvider === "llama-cpp") {
				const llamaCppRes = await fetch(`${DEFAULT_LLAMACPP_BASE_URL.replace(/\/$/, "")}/v1/embeddings`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ input: text, model: "nomic-embed-text" }),
					signal: AbortSignal.timeout(5000),
				});
				if (llamaCppRes.ok) {
					const data = (await llamaCppRes.json()) as { data?: Array<{ embedding: number[] }> };
					if (data.data?.[0]?.embedding) return data.data[0].embedding;
				}
				return null;
			}
			try {
				if (!cachedNativeEmbed) {
					const mod = await import("./native-embedding");
					cachedNativeEmbed = mod.nativeEmbed;
				}
				return await cachedNativeEmbed(text);
			} catch (nativeErr) {
				logger.warn(
					"embedding",
					`Native embedding failed, attempting local fallback: ${
						nativeErr instanceof Error ? nativeErr.message : String(nativeErr)
					}`,
				);
				try {
					const llamaCppRes = await fetch(`${DEFAULT_LLAMACPP_BASE_URL.replace(/\/$/, "")}/v1/embeddings`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ input: text, model: "nomic-embed-text" }),
						signal: AbortSignal.timeout(5000),
					});
					if (llamaCppRes.ok) {
						nativeFallbackProvider = "llama-cpp";
						const data = (await llamaCppRes.json()) as { data?: Array<{ embedding: number[] }> };
						if (data.data?.[0]?.embedding) {
							logger.info(
								"embedding",
								"llama.cpp fallback succeeded — will use llama.cpp for remaining embeddings this session",
							);
							return data.data[0].embedding;
						}
					}
				} catch {
					logger.warn("embedding", "llama.cpp fallback not reachable");
				}
				try {
					const result = await fetchOllamaEmbedding(text, resolveOllamaUrl(), "nomic-embed-text");
					if (result !== null) {
						nativeFallbackProvider = "ollama";
						logger.info(
							"embedding",
							"Ollama fallback succeeded — will use ollama for remaining embeddings this session",
						);
						return result;
					}
					logger.warn("embedding", "Ollama fallback also failed");
				} catch {
					logger.warn("embedding", "Ollama fallback not reachable");
				}
				return null;
			}
		}
		if (cfg.provider === "ollama") {
			return await fetchOllamaEmbedding(text, cfg.base_url, cfg.model);
		}

		if (cfg.provider === "llama-cpp") {
			const baseUrl = cfg.base_url.trim() || DEFAULT_LLAMACPP_BASE_URL;
			const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/embeddings`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: cfg.model, input: text }),
				signal: AbortSignal.timeout(30000),
			});
			if (!res.ok) {
				logger.warn("embedding", "llama.cpp embedding request failed", {
					status: res.status,
					model: cfg.model,
				});
				return null;
			}
			const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
			return data.data?.[0]?.embedding ?? null;
		}

		const apiKey = await resolveEmbeddingApiKey(cfg.api_key);
		const baseUrl = resolveEmbeddingBaseUrl(cfg);
		if (!apiKey && requiresOpenAiApiKey(baseUrl)) {
			logger.warn("embedding", "No API key configured for OpenAI embeddings, skipping request to api.openai.com");
			return null;
		}
		const res = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({ model: cfg.model, input: text }),
			signal: AbortSignal.timeout(30000),
		});
		if (!res.ok) {
			logger.warn("embedding", "Embedding API request failed", {
				status: res.status,
				provider: cfg.provider,
				model: cfg.model,
			});
			return null;
		}
		const data = (await res.json()) as {
			data: Array<{ embedding: number[] }>;
		};
		return data.data?.[0]?.embedding ?? null;
	} catch (e) {
		logger.warn("embedding", "Embedding fetch error", {
			provider: cfg.provider,
			model: cfg.model,
			error: e instanceof Error ? e.message : String(e),
		});
		return null;
	}
}
