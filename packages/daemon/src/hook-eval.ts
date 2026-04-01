/**
 * Hook LLM evaluation logic — prompt-eval and agent-eval endpoints.
 *
 * Extracted from daemon.ts to keep the logic unit-testable.
 * The daemon registers the HTTP routes; this module provides the core logic.
 */

// Maximum prompt length forwarded to the LLM.
// Oversized prompts are silently truncated (fail-open, not rejected) to
// bound per-request cost while preserving hook semantics.
export const MAX_HOOK_EVAL_PROMPT_CHARS = 16_000;

export const EVAL_SYSTEM = [
	"You are evaluating a hook condition.",
	'Respond with a JSON object: {"ok": true} if the condition passes,',
	'or {"ok": false, "reason": "explanation"} if it fails.',
	"Only return the JSON, nothing else.",
].join(" ");

/**
 * Parse a JSON eval result from raw LLM text, tolerating markdown
 * fences and leading/trailing whitespace.
 */
export function parseEvalResult(raw: string): { ok: boolean; reason?: string } {
	const trimmed = raw
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```\s*$/, "")
		.trim();
	const parsed: unknown = JSON.parse(trimmed);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("LLM returned non-object JSON");
	}
	const obj: Record<string, unknown> = Object.assign({}, parsed);
	return {
		ok: Boolean(obj.ok),
		reason: typeof obj.reason === "string" ? obj.reason : undefined,
	};
}

/**
 * Truncate a prompt to the eval character limit.
 * Returns the original string if within bounds.
 */
export function truncatePrompt(prompt: string): { prompt: string; truncated: boolean } {
	if (prompt.length <= MAX_HOOK_EVAL_PROMPT_CHARS) return { prompt, truncated: false };
	return { prompt: prompt.slice(0, MAX_HOOK_EVAL_PROMPT_CHARS), truncated: true };
}
