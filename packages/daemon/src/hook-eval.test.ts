import { describe, expect, it } from "bun:test";
import { MAX_HOOK_EVAL_PROMPT_CHARS, parseEvalResult, truncatePrompt } from "./hook-eval";

describe("parseEvalResult", () => {
	it("parses ok:true response", () => {
		const result = parseEvalResult('{"ok": true}');
		expect(result.ok).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	it("parses ok:false with reason", () => {
		const result = parseEvalResult('{"ok": false, "reason": "denied by policy"}');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("denied by policy");
	});

	it("strips markdown code fences", () => {
		const result = parseEvalResult("```json\n{\"ok\": true}\n```");
		expect(result.ok).toBe(true);
	});

	it("strips markdown fences without language tag", () => {
		const result = parseEvalResult("```\n{\"ok\": false, \"reason\": \"blocked\"}\n```");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("blocked");
	});

	it("handles leading/trailing whitespace", () => {
		const result = parseEvalResult("  \n  {\"ok\": true}  \n  ");
		expect(result.ok).toBe(true);
	});

	it("coerces reason to undefined when not a string", () => {
		const result = parseEvalResult('{"ok": false, "reason": 42}');
		expect(result.ok).toBe(false);
		expect(result.reason).toBeUndefined();
	});

	it("coerces ok to boolean", () => {
		// LLM may return truthy values
		const result = parseEvalResult('{"ok": 1}');
		expect(result.ok).toBe(true);
	});

	it("throws on non-object JSON", () => {
		expect(() => parseEvalResult('"just a string"')).toThrow();
	});

	it("throws on invalid JSON", () => {
		expect(() => parseEvalResult("not json at all")).toThrow();
	});

	it("coerces JSON array to ok:false (no ok field)", () => {
		// Object.assign({}, [true]) gives {0: true} — no "ok" key, coerces to false
		const result = parseEvalResult("[true]");
		expect(result.ok).toBe(false);
	});
});

describe("truncatePrompt", () => {
	it("returns original prompt when within limit", () => {
		const { prompt, truncated } = truncatePrompt("short prompt");
		expect(prompt).toBe("short prompt");
		expect(truncated).toBe(false);
	});

	it("truncates at MAX_HOOK_EVAL_PROMPT_CHARS", () => {
		const long = "x".repeat(MAX_HOOK_EVAL_PROMPT_CHARS + 500);
		const { prompt, truncated } = truncatePrompt(long);
		expect(prompt.length).toBe(MAX_HOOK_EVAL_PROMPT_CHARS);
		expect(truncated).toBe(true);
	});

	it("returns truncated:false at exactly the limit", () => {
		const exact = "x".repeat(MAX_HOOK_EVAL_PROMPT_CHARS);
		const { prompt, truncated } = truncatePrompt(exact);
		expect(prompt.length).toBe(MAX_HOOK_EVAL_PROMPT_CHARS);
		expect(truncated).toBe(false);
	});

	it("preserves content up to limit", () => {
		const content = "abc".repeat(MAX_HOOK_EVAL_PROMPT_CHARS);
		const { prompt } = truncatePrompt(content);
		expect(prompt).toBe(content.slice(0, MAX_HOOK_EVAL_PROMPT_CHARS));
	});
});
