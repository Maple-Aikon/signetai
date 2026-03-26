import { describe, expect, it } from "bun:test";
import { resolveRuntimeModel } from "./provider-resolution";

describe("resolveRuntimeModel", () => {
	it("drops the configured model when a non-ollama provider falls back to ollama", () => {
		expect(resolveRuntimeModel("ollama", "codex", "gpt-5-codex-mini")).toBeUndefined();
	});

	it("keeps the model when ollama was explicitly configured", () => {
		expect(resolveRuntimeModel("ollama", "ollama", "qwen3.5:4b")).toBe("qwen3.5:4b");
	});

	it("keeps the model when the effective provider still matches the configured provider", () => {
		expect(resolveRuntimeModel("codex", "codex", "gpt-5-codex-mini")).toBe("gpt-5-codex-mini");
	});
});
