/**
 * Regression test for the postinstall sharp shim.
 *
 * Validates that the generated shim content is valid JavaScript
 * and exports a falsy value (so transformers' `else if (sharp)`
 * guard skips image loading).
 */

const { describe, it, expect } = require("bun:test");

// The shim content the postinstall writes into sharp's entry point.
const SHIM_CJS = [
	"// Auto-generated shim — sharp native bindings unavailable.",
	"// Signet only uses text embeddings; image processing is not needed.",
	"// Exports falsy default so transformers' `else if (sharp)` is skipped.",
	"module.exports = null;",
	"",
].join("\n");

const SHIM_ESM =
	"// Auto-generated shim — sharp native bindings unavailable.\nexport default undefined;\n";

describe("postinstall sharp shim", () => {
	it("CJS shim evaluates without throwing", () => {
		const m = { exports: {} };
		// eslint-disable-next-line no-new-func
		new Function("module", "exports", SHIM_CJS)(m, m.exports);
		expect(m.exports).toBeNull();
	});

	it("CJS shim exports a falsy value", () => {
		const m = { exports: {} };
		new Function("module", "exports", SHIM_CJS)(m, m.exports);
		expect(!m.exports).toBe(true);
	});

	it("ESM shim is syntactically valid", () => {
		// Basic structural check — ESM can't be eval'd in CJS context,
		// but we can verify it contains the expected export statement.
		expect(SHIM_ESM).toContain("export default undefined");
	});
});
