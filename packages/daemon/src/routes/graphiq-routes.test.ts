import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, "../../../../");
const sourceScript = resolve(repoRoot, "scripts/install-graphiq.sh");
const pkgScript = resolve(repoRoot, "packages/signetai/scripts/install-graphiq.sh");
const pkgJsonPath = resolve(repoRoot, "packages/signetai/package.json");

describe("graphiq install script bundling", () => {
	test("install-graphiq.sh exists in repo root scripts directory", () => {
		expect(existsSync(sourceScript)).toBe(true);
	});

	test("install-graphiq.sh exists in signetai package scripts directory", () => {
		expect(existsSync(pkgScript)).toBe(true);
	});

	test("source and package scripts are identical", () => {
		expect(readFileSync(sourceScript, "utf-8")).toBe(
			readFileSync(pkgScript, "utf-8"),
		);
	});

	test("signetai package.json includes scripts in files array", () => {
		const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
		expect(pkgJson.files).toContain("scripts");
	});

	test("copy:scripts build step copies install-graphiq.sh", () => {
		const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
		expect(pkgJson.scripts["copy:scripts"]).toBeDefined();
		expect(pkgJson.scripts.prebuild).toContain("copy:scripts");
	});

	test("bundled path resolution: ../scripts from dist/daemon.js reaches scripts directory", () => {
		const fakePkg = join(thisDir, "__test_pkg_layout__");
		const fakeDist = join(fakePkg, "dist");
		const fakeScripts = join(fakePkg, "scripts");
		mkdirSync(fakeDist, { recursive: true });
		mkdirSync(fakeScripts, { recursive: true });
		writeFileSync(join(fakeScripts, "install-graphiq.sh"), "#!/bin/sh\n");
		try {
			const resolvedFromBundle = resolve(fakeDist, "../scripts/install-graphiq.sh");
			expect(existsSync(resolvedFromBundle)).toBe(true);
		} finally {
			rmSync(fakePkg, { recursive: true, force: true });
		}
	});
});
