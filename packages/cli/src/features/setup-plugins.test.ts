import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SIGNET_SECRETS_PLUGIN_ID } from "@signet/core";
import {
	getSetupPluginRegistryPath,
	readSetupCorePluginEnabled,
	writeSetupCorePluginRegistry,
} from "./setup-plugins.js";

let root = "";

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

function makeRoot(): string {
	root = mkdtempSync(join(tmpdir(), "signet-setup-plugins-"));
	return root;
}

describe("setup core plugin registry", () => {
	test("missing registry means setup should use the default enabled state", () => {
		expect(readSetupCorePluginEnabled(makeRoot())).toBeNull();
	});

	test("writes signet.secrets disabled for new installs that opt out", () => {
		const basePath = makeRoot();
		writeSetupCorePluginRegistry(basePath, { signetSecretsEnabled: false }, new Date("2026-04-17T12:00:00.000Z"));

		expect(readSetupCorePluginEnabled(basePath)).toBe(false);
		const registry = JSON.parse(readFileSync(getSetupPluginRegistryPath(basePath), "utf-8"));
		expect(registry.plugins[SIGNET_SECRETS_PLUGIN_ID]).toEqual({
			enabled: false,
			installedAt: "2026-04-17T12:00:00.000Z",
			updatedAt: "2026-04-17T12:00:00.000Z",
		});
	});

	test("preserves unrelated plugin registry entries", () => {
		const basePath = makeRoot();
		const path = getSetupPluginRegistryPath(basePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				plugins: {
					"local.example": {
						enabled: false,
						grantedCapabilities: ["example:read"],
						installedAt: "2026-04-01T00:00:00.000Z",
						updatedAt: "2026-04-01T00:00:00.000Z",
					},
				},
			}),
		);

		writeSetupCorePluginRegistry(basePath, { signetSecretsEnabled: true }, new Date("2026-04-17T12:00:00.000Z"));
		const registry = JSON.parse(readFileSync(path, "utf-8"));
		expect(registry.plugins["local.example"].grantedCapabilities).toEqual(["example:read"]);
		expect(registry.plugins[SIGNET_SECRETS_PLUGIN_ID].enabled).toBe(true);
	});
});
