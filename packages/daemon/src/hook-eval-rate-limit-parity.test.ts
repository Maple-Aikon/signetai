/**
 * Asserts that the hook-eval rate limit constants in daemon.ts and
 * packages/daemon-rs match. Catches silent drift between the TS and Rust
 * daemons — both must enforce the same limit or the shadow-proxy divergence
 * log will fill with false positives.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const ROOT = join(import.meta.dir, "..", "..", "..");

function readFile(rel: string): string {
	return readFileSync(join(ROOT, rel), "utf8");
}

describe("hook-eval rate limit parity (daemon.ts ↔ daemon-rs)", () => {
	it("daemon.ts defines authHookEvalLimiter(60_000, 30)", () => {
		const ts = readFile("packages/daemon/src/daemon.ts");
		expect(ts).toContain("authHookEvalLimiter = new AuthRateLimiter(60_000, 30)");
	});

	it("daemon-rs defines HOOK_EVAL_WINDOW_MS = 60_000", () => {
		const rs = readFile("packages/daemon-rs/crates/signet-daemon/src/main.rs");
		expect(rs).toContain("HOOK_EVAL_WINDOW_MS: u64 = 60_000");
	});

	it("daemon-rs defines HOOK_EVAL_MAX = 30", () => {
		const rs = readFile("packages/daemon-rs/crates/signet-daemon/src/main.rs");
		expect(rs).toContain("HOOK_EVAL_MAX: u64 = 30");
	});
});
