import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIGNET_SECRETS_PLUGIN_ID, getDefaultPluginHost, resetDefaultPluginHostForTests } from "./plugins/index.js";
import { deleteSecret, getSecret, hasSecret, listSecrets, localSecretProvider, putSecret } from "./secrets.js";

const originalSignetPath = process.env.SIGNET_PATH;
let agentsDir = "";

function secretsFile(): string {
	return join(agentsDir, ".secrets", "secrets.enc");
}

describe("local secrets provider", () => {
	beforeEach(() => {
		agentsDir = join(tmpdir(), `signet-secrets-provider-${process.pid}-${Date.now()}`);
		process.env.SIGNET_PATH = agentsDir;
		mkdirSync(agentsDir, { recursive: true });
	});

	afterEach(() => {
		resetDefaultPluginHostForTests();
		if (originalSignetPath === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = originalSignetPath;
		}
		if (agentsDir && existsSync(agentsDir)) {
			rmSync(agentsDir, { recursive: true, force: true });
		}
	});

	test("bare names and local:// references resolve through the same local store", async () => {
		await putSecret("OPENAI_API_KEY", "sk-test-local");

		expect(listSecrets()).toEqual(["OPENAI_API_KEY"]);
		expect(hasSecret("local://OPENAI_API_KEY")).toBe(true);
		expect(await getSecret("local://OPENAI_API_KEY")).toBe("sk-test-local");

		const resolved = await localSecretProvider.resolve("OPENAI_API_KEY", {});
		expect(resolved.ref).toBe("local://OPENAI_API_KEY");
		expect(resolved.value).toBe("sk-test-local");

		const descriptors = await localSecretProvider.list({});
		expect(descriptors[0]?.ref).toBe("local://OPENAI_API_KEY");
	});

	test("corrupt stores fail clearly and are not overwritten by list or health checks", async () => {
		mkdirSync(join(agentsDir, ".secrets"), { recursive: true });
		writeFileSync(secretsFile(), "not-json", { mode: 0o600 });

		expect(() => listSecrets()).toThrow("Failed to read secrets store");
		const health = await localSecretProvider.health({});
		expect(health.status).toBe("unhealthy");
		expect(readFileSync(secretsFile(), "utf-8")).toBe("not-json");
	});

	test("default signet.secrets plugin degrades when the local provider is unhealthy", () => {
		mkdirSync(join(agentsDir, ".secrets"), { recursive: true });
		writeFileSync(secretsFile(), "not-json", { mode: 0o600 });
		resetDefaultPluginHostForTests();

		const plugin = getDefaultPluginHost().get(SIGNET_SECRETS_PLUGIN_ID);

		expect(plugin?.state).toBe("degraded");
		expect(plugin?.health?.status).toBe("unhealthy");
		expect(plugin?.stateReason).toContain("Failed to read secrets store");
	});

	test("delete accepts local:// compatibility references", async () => {
		await putSecret("GITHUB_TOKEN", "ghp_test");
		expect(deleteSecret("local://GITHUB_TOKEN")).toBe(true);
		expect(listSecrets()).toEqual([]);
	});
});
