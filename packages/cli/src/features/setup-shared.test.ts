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

	it("prefers non-local extraction defaults on vps based on harness availability and detection", () => {
		expect(defaultExtractionProviderForDeployment("vps", "ollama", ["claude-code"])).toBe("claude-code");
		expect(defaultExtractionProviderForDeployment("vps", "none", ["codex"])).toBe("codex");
		expect(defaultExtractionProviderForDeployment("vps", "none", ["opencode"])).toBe("opencode");
		expect(defaultExtractionProviderForDeployment("vps", "codex")).toBe("codex");
		expect(defaultExtractionProviderForDeployment("vps", "none")).toBe("none");
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
