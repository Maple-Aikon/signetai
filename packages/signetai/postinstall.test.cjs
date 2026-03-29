/**
 * Regression test for the postinstall sharp shim.
 *
 * Validates that the shim content exported from the real postinstall
 * script is valid JavaScript and exports falsy values.
 */

const { describe, it, expect } = require("bun:test");
const { CJS_SHIM, ESM_SHIM, SHIM_PACKAGE_JSON } = require("./postinstall.cjs");

describe("postinstall sharp shim", () => {
	it("CJS shim evaluates without throwing", () => {
		const m = { exports: {} };
		new Function("module", "exports", CJS_SHIM)(m, m.exports);
		expect(m.exports).toBeNull();
	});

	it("CJS shim exports a falsy value", () => {
		const m = { exports: {} };
		new Function("module", "exports", CJS_SHIM)(m, m.exports);
		expect(!m.exports).toBe(true);
	});

	it("ESM shim contains export default null", () => {
		expect(ESM_SHIM).toContain("export default null");
	});

	it("shim package.json is valid JSON with correct name", () => {
		const pkg = JSON.parse(SHIM_PACKAGE_JSON);
		expect(pkg.name).toBe("sharp");
		expect(pkg.version).toBe("0.0.0-signet-shim");
		expect(pkg.main).toBe("index.js");
		expect(pkg.exports["."]).toBeDefined();
	});
});
