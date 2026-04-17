import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { SIGNET_SECRETS_PLUGIN_ID, signetSecretsManifest } from "../plugins/bundled/secrets.js";
import { PluginHostV1 } from "../plugins/host.js";
import { registerPluginRoutes } from "./plugins-routes.js";

function makeApp(): Hono {
	const app = new Hono();
	const host = new PluginHostV1({
		storagePath: null,
		corePluginIds: [SIGNET_SECRETS_PLUGIN_ID],
		now: () => new Date("2026-04-16T12:00:00.000Z"),
	});
	host.discover(signetSecretsManifest, { grantedCapabilities: signetSecretsManifest.capabilities });
	registerPluginRoutes(app, host);
	return app;
}

describe("plugin routes", () => {
	test("GET /api/plugins lists signet.secrets diagnostics metadata", async () => {
		const res = await makeApp().request("/api/plugins");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			plugins: Array<{ id: string; state: string; surfaces: { sdkClients: Array<{ name: string }> } }>;
		};
		expect(body.plugins[0]?.id).toBe(SIGNET_SECRETS_PLUGIN_ID);
		expect(body.plugins[0]?.state).toBe("active");
		expect(body.plugins[0]?.surfaces.sdkClients.map((client) => client.name)).toContain("listSecrets");
	});

	test("GET /api/plugins/:id/diagnostics returns active and planned surfaces", async () => {
		const res = await makeApp().request(`/api/plugins/${SIGNET_SECRETS_PLUGIN_ID}/diagnostics`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			plugin: {
				record: { id: string };
				activeSurfaces: { mcpTools: Array<{ name: string }> };
				plannedSurfaces: { daemonRoutes: Array<{ path: string }> };
				promptContributionDiagnostics: Array<{ included: boolean }>;
			};
		};
		expect(body.plugin.record.id).toBe(SIGNET_SECRETS_PLUGIN_ID);
		expect(body.plugin.activeSurfaces.mcpTools.map((tool) => tool.name)).toContain("secret_list");
		expect(body.plugin.plannedSurfaces.daemonRoutes.map((route) => route.path)).toContain("/api/secrets");
		expect(body.plugin.promptContributionDiagnostics[0]?.included).toBe(true);
	});

	test("GET /api/plugins/prompt-contributions returns active contributions only", async () => {
		const app = makeApp();
		const first = await app.request("/api/plugins/prompt-contributions");
		expect(first.status).toBe(200);
		const active = (await first.json()) as { activeCount: number; contributions: Array<{ pluginId: string }> };
		expect(active.activeCount).toBe(1);
		expect(active.contributions[0]?.pluginId).toBe(SIGNET_SECRETS_PLUGIN_ID);

		const patch = await app.request(`/api/plugins/${SIGNET_SECRETS_PLUGIN_ID}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		});
		expect(patch.status).toBe(200);

		const second = await app.request("/api/plugins/prompt-contributions");
		const inactive = (await second.json()) as { activeCount: number; contributions: unknown[] };
		expect(inactive.activeCount).toBe(0);
		expect(inactive.contributions).toEqual([]);
	});
});
