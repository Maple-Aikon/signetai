import type { ExtractionProviderChoice } from "./setup-shared.js";

export const EXTRACTION_SAFETY_WARNING =
	"Extraction is intended for Claude Code (Haiku), Codex CLI (GPT Mini) on a Pro/Max subscription, or local Ollama models at qwen3:4b or larger. Remote API extraction can rack up extreme usage fees fast. On a VPS, set the provider to none unless you explicitly want background extraction.";

const MODEL_DEFAULTS = {
	none: "",
	"claude-code": "haiku",
	codex: "gpt-5-codex-mini",
	ollama: "qwen3:4b",
	opencode: "anthropic/claude-haiku-4-5-20251001",
	openrouter: "openai/gpt-4o-mini",
} as const satisfies Record<ExtractionProviderChoice, string>;

export interface SetupPipelineConfig {
	readonly enabled: boolean;
	readonly extraction: {
		readonly provider: ExtractionProviderChoice;
		readonly model: string;
	};
	readonly semanticContradictionEnabled?: boolean;
	readonly graph?: {
		readonly enabled: boolean;
	};
	readonly reranker?: {
		readonly enabled: boolean;
	};
	readonly autonomous?: {
		readonly enabled: boolean;
		readonly allowUpdateDelete: boolean;
		readonly maintenanceMode: "execute";
	};
	readonly predictor?: {
		readonly enabled: boolean;
	};
	readonly predictorPipeline?: {
		readonly agentFeedback: boolean;
		readonly trainingTelemetry: boolean;
	};
}

export function defaultExtractionModel(provider: ExtractionProviderChoice): string {
	return MODEL_DEFAULTS[provider];
}

export function buildSetupPipeline(provider: ExtractionProviderChoice, model?: string): SetupPipelineConfig {
	if (provider === "none") {
		return {
			enabled: false,
			extraction: {
				provider: "none",
				model: "",
			},
		};
	}

	return {
		enabled: true,
		extraction: {
			provider,
			model: model?.trim() || defaultExtractionModel(provider),
		},
		semanticContradictionEnabled: true,
		graph: { enabled: true },
		reranker: { enabled: true },
		autonomous: {
			enabled: true,
			allowUpdateDelete: true,
			maintenanceMode: "execute",
		},
		predictor: { enabled: true },
		predictorPipeline: {
			agentFeedback: true,
			trainingTelemetry: false,
		},
	};
}
