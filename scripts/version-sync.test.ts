import { describe, expect, test } from "bun:test";

import { VERSION_SYNC_PACKAGE_GLOBS } from "./version-sync";

describe("version-sync", () => {
	test("keeps web workspace manifests out of Signet release version sync", () => {
		expect(VERSION_SYNC_PACKAGE_GLOBS).not.toContain("web/**/package.json");
	});
});
