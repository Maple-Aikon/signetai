import { describe, expect, it } from "bun:test";
import { normalizeCodexTranscript } from "./hooks";

describe("normalizeCodexTranscript", () => {
	it("includes assistant turns from top-level item.completed events", () => {
		const raw = [
			'{"type":"session_meta","payload":{"cwd":"/tmp/project","model":"gpt-5.3-codex"}}',
			'{"type":"event_msg","payload":{"type":"user_message","message":"Summarize the plan"}}',
			'{"type":"item.completed","item":{"type":"agent_message","text":"Here is the plan."}}',
		].join("\n");

		expect(normalizeCodexTranscript(raw)).toContain("Assistant: Here is the plan.");
	});
});
