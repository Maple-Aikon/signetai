#!/usr/bin/env node

/**
 * postinstall — ensure sharp's native bindings are loadable.
 *
 * Problem:  @huggingface/transformers does `import sharp from 'sharp'` at
 *           the module level.  When installed globally via bun, sharp's
 *           native binary (@img/sharp-darwin-arm64) can't find the
 *           libvips dylib because bun's cache isolates each package by
 *           version and the .node binary's @rpath expects the libvips
 *           package as a sibling — which bun never creates.
 *
 *           This causes the entire native embedding provider to fail with
 *           "Unable to get model file path or buffer", falling back to
 *           Ollama (if available) or no embeddings at all.
 *
 * Fix:      Try to require('sharp').  If it throws, write a minimal shim
 *           into node_modules/sharp/lib/index.js that exports undefined
 *           so transformers' `else if (sharp)` guard skips image loading
 *           cleanly.  This is safe because signet only uses text embeddings.
 */

const { existsSync, mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

function findSharpDir() {
	try {
		// resolve from the installed signetai package context
		const sharpMain = require.resolve("sharp");
		return dirname(dirname(sharpMain));
	} catch {
		return null;
	}
}

function main() {
	// First, check if sharp works fine as-is
	try {
		require("sharp");
		// sharp loads — no action needed
		return;
	} catch {
		// sharp is broken — continue to shim it
	}

	const sharpDir = findSharpDir();
	if (!sharpDir) {
		// sharp isn't installed at all — transformers will handle the
		// missing module gracefully (import returns undefined for
		// optional deps in some runtimes).  Nothing to do.
		return;
	}

	const shimContent = [
		"// Auto-generated shim — sharp native bindings unavailable.",
		"// Signet only uses text embeddings; image processing is not needed.",
		"// Exports falsy default so transformers' `else if (sharp)` is skipped.",
		"module.exports = null;",
		"",
	].join("\n");

	const libDir = join(sharpDir, "lib");
	const indexPath = join(libDir, "index.js");

	try {
		mkdirSync(libDir, { recursive: true });
		writeFileSync(indexPath, shimContent, "utf8");

		// Also patch the ESM entry if present
		const esmPath = join(libDir, "index.mjs");
		const esmShim = "// Auto-generated shim — sharp native bindings unavailable.\nexport default undefined;\n";
		writeFileSync(esmPath, esmShim, "utf8");

		// Update package.json main/exports if needed
		const pkgPath = join(sharpDir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
				pkg.main = "lib/index.js";
				// Remove or simplify exports so the shim is used
				if (pkg.exports) {
					pkg.exports = {
						".": {
							import: "./lib/index.mjs",
							require: "./lib/index.js",
							default: "./lib/index.js",
						},
					};
				}
				writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
			} catch {
				// Best-effort — the lib/index.js shim may still work
			}
		}

		console.log("signet: sharp native bindings unavailable — installed text-only shim");
	} catch (err) {
		// Non-fatal — the daemon will fall back to Ollama
		console.warn(`signet: could not shim sharp (${err.message}) — Ollama fallback will be used`);
	}
}

main();
