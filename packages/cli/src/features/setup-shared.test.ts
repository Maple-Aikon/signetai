import { describe, expect, it } from "bun:test";
import {
	DEPLOYMENT_TYPE_CHOICES,
	defaultEmbeddingProviderForDeployment,
	defaultExtractionProviderForDeployment,
	getDeploymentExtractionGuidance,
} from "./setup-shared.js";

describe("setup deployment defaults", () => {
	it("supports local, vps, and server deployment choices", () => {
		expect(DEPLOYMENT_TYPE_CHOICES).toEqual(["local", "vps", "server"]);
	});

	it("defaults embedding provider to native across deployment types", () => {
		expect(defaultEmbeddingProviderForDeployment("local")).toBe("native");
		expect(defaultEmbeddingProviderForDeployment("vps")).toBe("native");
		expect(defaultEmbeddingProviderForDeployment("server")).toBe("native");
	});

	it("forces claude-code extraction default on vps", () => {
		expect(defaultExtractionProviderForDeployment("vps", "ollama")).toBe("claude-code");
		expect(defaultExtractionProviderForDeployment("vps", "none")).toBe("claude-code");
	});

	it("keeps detected extraction provider for local and server", () => {
		expect(defaultExtractionProviderForDeployment("local", "ollama")).toBe("ollama");
		expect(defaultExtractionProviderForDeployment("server", "codex")).toBe("codex");
	});

	it("returns guidance text for each deployment type", () => {
		expect(getDeploymentExtractionGuidance("local").length).toBeGreaterThan(0);
		expect(getDeploymentExtractionGuidance("vps").join(" ").includes("VPS")).toBe(true);
		expect(getDeploymentExtractionGuidance("server").join(" ").includes("Dedicated")).toBe(true);
	});
});
