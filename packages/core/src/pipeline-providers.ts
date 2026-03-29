export const PIPELINE_PROVIDER_CHOICES = [
	"none",
	"ollama",
	"claude-code",
	"codex",
	"opencode",
	"anthropic",
	"openrouter",
	"command",
] as const;

export type PipelineProviderChoice = (typeof PIPELINE_PROVIDER_CHOICES)[number];

export const DEFAULT_PIPELINE_TIMEOUT_MS = 90000;

/**
 * Extended timeout for local Ollama models on ARM64 (Apple Silicon).
 *
 * Non-thinking models like gemma3:4b generate at ~8 tok/s on M-series
 * chips.  A full extraction response needs ~500-1000 tokens, which
 * takes 60-130s — exceeding the 90s default.  180s gives comfortable
 * headroom for extraction + escalation without hitting the lease cap.
 */
export const ARM64_PIPELINE_TIMEOUT_MS = 180000;

const MODEL_DEFAULTS = {
	none: "",
	ollama: "gemma3:4b",
	"claude-code": "haiku",
	codex: "gpt-5-codex-mini",
	opencode: "anthropic/claude-haiku-4-5-20251001",
	anthropic: "haiku",
	openrouter: "openai/gpt-4o-mini",
	command: "",
} as const satisfies Record<PipelineProviderChoice, string>;

const PIPELINE_PROVIDER_SET = new Set<string>(PIPELINE_PROVIDER_CHOICES);

export function isPipelineProvider(value: unknown): value is PipelineProviderChoice {
	return typeof value === "string" && PIPELINE_PROVIDER_SET.has(value);
}

export function defaultPipelineModel(provider: PipelineProviderChoice): string {
	return MODEL_DEFAULTS[provider];
}
