import { readFileSync } from "node:fs";
import {
	findPipelineConfigFile,
	parseSimpleYaml,
	readPipelinePauseState,
	setPipelinePaused,
} from "@signet/core";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_EXTRACTION_MODEL = "qwen3.5:4b";
const DEFAULT_SYNTHESIS_MODEL = "haiku";
const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text-v1.5";

export { readPipelinePauseState, setPipelinePaused };
export type { PipelinePauseState } from "@signet/core";

export interface OllamaReleaseTarget {
	readonly baseUrl: string;
	readonly label: "embedding" | "extraction" | "synthesis";
	readonly model: string;
}

export interface OllamaReleaseResult extends OllamaReleaseTarget {
	readonly error?: string;
	readonly ok: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimText(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const text = raw.trim();
	return text.length > 0 ? text : undefined;
}

function trimSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

function normalizeUrl(raw: unknown, fallback: string): string {
	const text = trimText(raw);
	return trimSlash(text ?? fallback);
}

function isLoopback(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			parsed.hostname === "127.0.0.1" ||
			parsed.hostname === "localhost" ||
			parsed.hostname === "::1" ||
			parsed.hostname === "[::1]" ||
			parsed.hostname === "0.0.0.0" ||
			parsed.hostname === "::"
		);
	} catch {
		return false;
	}
}

function readCfg(dir: string): { readonly cfg: Record<string, unknown> | null; readonly file: string | null } {
	const file = findPipelineConfigFile(dir);
	if (file === null) {
		return { file: null, cfg: null };
	}
	const cfg = parseSimpleYaml(readFileSync(file, "utf-8"));
	return { file, cfg: isRecord(cfg) ? cfg : {} };
}

function readMem(cfg: Record<string, unknown>): Record<string, unknown> | null {
	return isRecord(cfg.memory) ? cfg.memory : null;
}

function readPipeline(cfg: Record<string, unknown>): Record<string, unknown> | null {
	const mem = readMem(cfg);
	return mem && isRecord(mem.pipelineV2) ? mem.pipelineV2 : null;
}

function addTarget(
	list: OllamaReleaseTarget[],
	seen: Set<string>,
	label: OllamaReleaseTarget["label"],
	model: string,
	baseUrl: string,
): void {
	if (!isLoopback(baseUrl)) return;
	const key = [baseUrl, model].join("\u0000");
	if (seen.has(key)) return;
	seen.add(key);
	list.push({ label, model, baseUrl });
}

export function readOllamaReleaseTargets(dir: string): readonly OllamaReleaseTarget[] {
	const { cfg } = readCfg(dir);
	if (cfg === null) return [];

	const out: OllamaReleaseTarget[] = [];
	const seen = new Set<string>();
	const mem = readMem(cfg);
	const p2 = readPipeline(cfg);

	const extraction = p2 && isRecord(p2.extraction) ? p2.extraction : null;
	if (extraction?.provider === "ollama") {
		addTarget(
			out,
			seen,
			"extraction",
			trimText(extraction.model) ?? DEFAULT_EXTRACTION_MODEL,
			normalizeUrl(extraction.endpoint ?? extraction.base_url, DEFAULT_OLLAMA_URL),
		);
	}

	const synthesis = p2 && isRecord(p2.synthesis) ? p2.synthesis : null;
	if (synthesis?.provider === "ollama") {
		addTarget(
			out,
			seen,
			"synthesis",
			trimText(synthesis.model) ?? DEFAULT_SYNTHESIS_MODEL,
			normalizeUrl(synthesis.endpoint ?? synthesis.base_url, DEFAULT_OLLAMA_URL),
		);
	}

	const embedding = isRecord(cfg.embedding)
		? cfg.embedding
		: mem && isRecord(mem.embeddings)
			? mem.embeddings
			: isRecord(cfg.embeddings)
				? cfg.embeddings
				: null;
	if (embedding?.provider === "ollama") {
		addTarget(
			out,
			seen,
			"embedding",
			trimText(embedding.model) ?? DEFAULT_EMBEDDING_MODEL,
			normalizeUrl(embedding.base_url ?? embedding.endpoint ?? embedding.url, DEFAULT_OLLAMA_URL),
		);
	}

	return out;
}

export async function releaseOllamaModels(
	dir: string,
	doFetch: typeof fetch = fetch,
): Promise<readonly OllamaReleaseResult[]> {
	const targets = readOllamaReleaseTargets(dir);
	const out: OllamaReleaseResult[] = [];

	for (const target of targets) {
		try {
			const res = await doFetch(`${target.baseUrl}/api/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: target.model,
					keep_alive: 0,
				}),
			});

			if (!res.ok) {
				const body = await res.text().catch(() => "");
				out.push({
					...target,
					ok: false,
					error: body ? `HTTP ${res.status}: ${body.slice(0, 200)}` : `HTTP ${res.status}`,
				});
				continue;
			}

			out.push({ ...target, ok: true });
		} catch (err) {
			out.push({
				...target,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return out;
}
