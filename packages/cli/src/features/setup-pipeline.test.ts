import { describe, expect, it } from "bun:test";
import { buildSetupPipeline, defaultExtractionModel } from "./setup-pipeline";

describe("defaultExtractionModel", () => {
	it("prefers the cheap codex mini model", () => {
		expect(defaultExtractionModel("codex")).toBe("gpt-5-codex-mini");
	});

	it("uses gemma3:4b as the ollama default", () => {
		expect(defaultExtractionModel("ollama")).toBe("gemma3:4b");
	});
});

describe("buildSetupPipeline", () => {
	it("writes an explicit disabled pipeline when extraction is turned off", () => {
		expect(buildSetupPipeline("none")).toEqual({
			enabled: false,
			extraction: {
				provider: "none",
				model: "",
			},
			synthesis: {
				enabled: false,
				provider: "none",
				model: "",
				timeout: 120000,
			},
		});
	});

	it("fills in safe defaults for enabled providers", () => {
		expect(buildSetupPipeline("claude-code")).toEqual({
			enabled: true,
			extraction: {
				provider: "claude-code",
				model: "haiku",
			},
			synthesis: {
				enabled: true,
				provider: "claude-code",
				model: "haiku",
				timeout: 120000,
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
		});
	});

	it("ollama synthesis uses qwen3:4b regardless of extraction model", () => {
		expect(buildSetupPipeline("ollama", "gemma3:4b").synthesis).toEqual({
			enabled: true,
			provider: "ollama",
			model: "qwen3:4b",
			timeout: 120000,
		});
	});

	it("non-ollama providers mirror extraction model into synthesis", () => {
		expect(buildSetupPipeline("codex", "gpt-5-codex-mini").synthesis).toEqual({
			enabled: true,
			provider: "codex",
			model: "gpt-5-codex-mini",
			timeout: 120000,
		});
	});
});
