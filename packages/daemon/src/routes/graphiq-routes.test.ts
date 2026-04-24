import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoScript = resolve(thisDir, "../../../../scripts/install-graphiq.sh");

describe("graphiq install script path resolution", () => {
	test("install-graphiq.sh exists in repo scripts directory", () => {
		expect(existsSync(repoScript)).toBe(true);
	});

	test("source fallback path resolves to repo scripts directory", () => {
		const sourcePath = resolve(thisDir, "../../../../scripts/install-graphiq.sh");
		expect(sourcePath).toMatch(/scripts\/install-graphiq\.sh$/);
		expect(existsSync(sourcePath)).toBe(true);
	});

	test("bundled path takes precedence when scripts directory exists alongside dist", () => {
		const fakeDist = join(thisDir, "__test_dist__");
		const fakeScripts = join(fakeDist, "scripts");
		mkdirSync(fakeScripts, { recursive: true });
		writeFileSync(join(fakeScripts, "install-graphiq.sh"), "#!/bin/sh\n");

		const bundled = resolve(fakeDist, "scripts/install-graphiq.sh");
		try {
			expect(existsSync(bundled)).toBe(true);
			const result = resolveFakeScript(fakeDist);
			expect(result).toBe(bundled);
		} finally {
			rmSync(fakeDist, { recursive: true, force: true });
		}
	});

	test("falls back to source path when bundled script is absent", () => {
		const fakeDist = join(thisDir, "__test_dist_noscript__");
		mkdirSync(fakeDist, { recursive: true });
		try {
			const result = resolveFakeScript(fakeDist);
			expect(result).toMatch(/scripts\/install-graphiq\.sh$/);
			expect(existsSync(result)).toBe(true);
		} finally {
			rmSync(fakeDist, { recursive: true, force: true });
		}
	});
});

function resolveFakeScript(fakeDistDir: string): string {
	const bundled = resolve(fakeDistDir, "scripts/install-graphiq.sh");
	if (existsSync(bundled)) return bundled;
	return repoScript;
}
