import {
	type PluginAuditEvent,
	type PluginDiagnostics,
	type PluginRegistryRecord,
	getPluginDiagnostics,
	listPluginAuditEvents,
	listPlugins,
	setPluginEnabled,
} from "$lib/api";
import { toast } from "$lib/stores/toast.svelte";

const AUDIT_LIMIT = 50;
export const SIGNET_SECRETS_PLUGIN_ID = "signet.secrets";

export const pluginsStore = $state({
	plugins: [] as PluginRegistryRecord[],
	selectedId: null as string | null,
	diagnostics: null as PluginDiagnostics | null,
	auditEvents: [] as PluginAuditEvent[],
	loading: false,
	diagnosticsLoading: false,
	auditLoading: false,
	togglingId: null as string | null,
	error: null as string | null,
	diagnosticsError: null as string | null,
	auditError: null as string | null,
});

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

export function getSelectedPlugin(): PluginRegistryRecord | null {
	if (!pluginsStore.selectedId) return pluginsStore.plugins[0] ?? null;
	return (
		pluginsStore.plugins.find((plugin) => plugin.id === pluginsStore.selectedId) ?? pluginsStore.plugins[0] ?? null
	);
}

export function countPluginSurfaces(plugin: PluginRegistryRecord): number {
	return (
		plugin.surfaces.daemonRoutes.length +
		plugin.surfaces.cliCommands.length +
		plugin.surfaces.mcpTools.length +
		plugin.surfaces.dashboardPanels.length +
		plugin.surfaces.sdkClients.length +
		plugin.surfaces.connectorCapabilities.length +
		plugin.surfaces.promptContributions.length
	);
}

export function formatPluginState(plugin: PluginRegistryRecord): string {
	if (!plugin.enabled) return "disabled";
	if (plugin.health?.status === "unhealthy") return "unhealthy";
	if (plugin.health?.status === "degraded" || plugin.state === "degraded") return "degraded";
	return plugin.state;
}

export async function loadPlugins(): Promise<void> {
	pluginsStore.loading = true;
	pluginsStore.error = null;
	try {
		const data = await listPlugins();
		pluginsStore.plugins = [...data.plugins].sort((a, b) => {
			if (a.trustTier === "core" && b.trustTier !== "core") return -1;
			if (a.trustTier !== "core" && b.trustTier === "core") return 1;
			return a.name.localeCompare(b.name);
		});
		if (!pluginsStore.selectedId || !pluginsStore.plugins.some((plugin) => plugin.id === pluginsStore.selectedId)) {
			pluginsStore.selectedId = pluginsStore.plugins[0]?.id ?? null;
		}
	} catch (error) {
		pluginsStore.plugins = [];
		pluginsStore.selectedId = null;
		pluginsStore.error = toErrorMessage(error);
	} finally {
		pluginsStore.loading = false;
	}
}

export async function selectPlugin(id: string): Promise<void> {
	pluginsStore.selectedId = id;
	await Promise.all([loadPluginDiagnostics(id), loadPluginAuditEvents(id)]);
}

export async function loadSelectedPluginDetails(): Promise<void> {
	const selected = getSelectedPlugin();
	if (!selected) return;
	await Promise.all([loadPluginDiagnostics(selected.id), loadPluginAuditEvents(selected.id)]);
}

export async function loadPluginDiagnostics(id: string): Promise<void> {
	pluginsStore.diagnosticsLoading = true;
	pluginsStore.diagnosticsError = null;
	try {
		const data = await getPluginDiagnostics(id);
		pluginsStore.diagnostics = data.plugin;
	} catch (error) {
		pluginsStore.diagnostics = null;
		pluginsStore.diagnosticsError = toErrorMessage(error);
	} finally {
		pluginsStore.diagnosticsLoading = false;
	}
}

export async function loadPluginAuditEvents(id: string): Promise<void> {
	pluginsStore.auditLoading = true;
	pluginsStore.auditError = null;
	try {
		const data = await listPluginAuditEvents({ pluginId: id, limit: AUDIT_LIMIT });
		pluginsStore.auditEvents = [...data.events];
	} catch (error) {
		pluginsStore.auditEvents = [];
		pluginsStore.auditError = toErrorMessage(error);
	} finally {
		pluginsStore.auditLoading = false;
	}
}

export async function togglePlugin(id: string, enabled: boolean): Promise<void> {
	pluginsStore.togglingId = id;
	try {
		const data = await setPluginEnabled(id, enabled);
		pluginsStore.plugins = pluginsStore.plugins.map((plugin) => (plugin.id === id ? data.plugin : plugin));
		await Promise.all([loadPluginDiagnostics(id), loadPluginAuditEvents(id)]);
		toast(`${data.plugin.name} ${enabled ? "enabled" : "disabled"}`, "success");
	} catch (error) {
		toast(toErrorMessage(error), "error");
	} finally {
		pluginsStore.togglingId = null;
	}
}
