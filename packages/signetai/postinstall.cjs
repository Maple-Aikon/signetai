#!/usr/bin/env node

/**
 * postinstall — ensure sharp is resolvable for @huggingface/transformers.
 *
 * Problem:  @huggingface/transformers does `import sharp from 'sharp'` at
 *           the module level.  When installed globally via bun, sharp's
 *           native binary can't find libvips because bun's cache isolates
 *           packages by version.  If sharp isn't installed at all (e.g.
 *           optional dep skipped), the import also fails.
 *
 * Fix:      If sharp doesn't load, create a local shim package inside
 *           THIS package's node_modules (not the shared cache).  Node/bun
 *           resolution checks local node_modules first, so the shim takes
 *           precedence without corrupting the shared cache for other
 *           consumers.
 *
 *           Safe because signet only uses text embeddings — never images.
 */

const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

/** The shim content — exported so tests can validate it. */
const CJS_SHIM =
	"// Auto-generated shim — sharp native bindings unavailable.\n" +
	"// Signet only uses text embeddings; image processing is not needed.\n" +
	"module.exports = null;\n";

const ESM_SHIM =
	"// Auto-generated shim — sharp native bindings unavailable.\n" +
	"export default null;\n";

const SHIM_PACKAGE_JSON = JSON.stringify(
	{
		name: "sharp",
		version: "0.0.0-signet-shim",
		main: "index.js",
		module: "index.mjs",
		exports: {
			".": {
				import: "./index.mjs",
				require: "./index.js",
				default: "./index.js",
			},
		},
	},
	null,
	2,
);

function main() {
	// If sharp loads fine, nothing to do.
	try {
		require("sharp");
		return;
	} catch {
		// sharp is broken or absent — create a local shim.
	}

	// Write the shim into THIS package's node_modules so it takes
	// precedence via Node's resolution algorithm without touching
	// the shared bun/npm cache.
	const shimDir = join(__dirname, "node_modules", "sharp");

	try {
		mkdirSync(shimDir, { recursive: true });
		writeFileSync(join(shimDir, "index.js"), CJS_SHIM, "utf8");
		writeFileSync(join(shimDir, "index.mjs"), ESM_SHIM, "utf8");
		writeFileSync(join(shimDir, "package.json"), SHIM_PACKAGE_JSON + "\n", "utf8");
		console.log("signet: sharp native bindings unavailable — installed local shim");
	} catch (err) {
		// Non-fatal — the daemon will fall back to Ollama for embeddings.
		console.warn(
			`signet: could not create sharp shim (${err.message}) — Ollama fallback will be used`,
		);
	}
}

// Export shim content for tests.
module.exports = { CJS_SHIM, ESM_SHIM, SHIM_PACKAGE_JSON };

// Run when executed directly (postinstall).
if (require.main === module) {
	main();
}
