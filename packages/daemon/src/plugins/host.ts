import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../logger.js";
import { runtimeSupportedInV1, unsupportedRuntimeReason, validatePluginManifest } from "./manifest.js";
import { EMPTY_PLUGIN_SURFACES } from "./types.js";
import type {
	PluginDiagnosticsV1,
	PluginHealthV1,
	PluginLifecycleStateV1,
	PluginManifestV1,
	PluginPromptContributionV1,
	PluginPromptTargetV1,
	PluginRegistryRecordV1,
	PluginSourceV1,
	PluginSurfaceSummaryV1,
} from "./types.js";

interface PersistedPluginStateV1 {
	readonly enabled?: boolean;
	readonly grantedCapabilities?: readonly string[];
	readonly installedAt?: string;
	readonly updatedAt?: string;
}

interface PluginRegistryStoreV1 {
	readonly version: 1;
	readonly plugins: Record<string, PersistedPluginStateV1>;
}

interface RegisteredPluginV1 {
	readonly manifest: PluginManifestV1;
	readonly source: PluginSourceV1;
	readonly record: PluginRegistryRecordV1;
	readonly validationErrors: readonly string[];
}

export interface PluginHostOptionsV1 {
	readonly storagePath?: string | null;
	readonly now?: () => Date;
	readonly corePluginIds?: readonly string[];
}

export interface DiscoverPluginOptionsV1 {
	readonly source?: PluginSourceV1;
	readonly enabled?: boolean;
	readonly grantedCapabilities?: readonly string[];
	readonly health?: PluginHealthV1;
}

export class PluginHostV1 {
	private readonly storagePath: string | null;
	private readonly now: () => Date;
	private readonly corePluginIds: readonly string[];
	private readonly plugins = new Map<string, RegisteredPluginV1>();
	private store: PluginRegistryStoreV1;

	constructor(opts: PluginHostOptionsV1 = {}) {
		this.storagePath = opts.storagePath === undefined ? getDefaultPluginRegistryPath() : opts.storagePath;
		this.now = opts.now ?? (() => new Date());
		this.corePluginIds = opts.corePluginIds ?? [];
		this.store = this.loadStore();
	}

	discover(manifest: PluginManifestV1, opts: DiscoverPluginOptionsV1 = {}): PluginRegistryRecordV1 {
		const validationErrors = validatePluginManifest(manifest, { corePluginIds: this.corePluginIds });
		const previous = this.store.plugins[manifest.id];
		const timestamp = this.now().toISOString();
		const enabled = previous?.enabled ?? opts.enabled ?? true;
		const requestedCapabilities = previous?.grantedCapabilities ?? opts.grantedCapabilities ?? manifest.capabilities;
		const grantedCapabilities =
			validationErrors.length === 0 && runtimeSupportedInV1(manifest)
				? normalizeCapabilities(
						requestedCapabilities.filter((capability) => manifest.capabilities.includes(capability)),
					)
				: [];
		const installedAt = previous?.installedAt ?? timestamp;
		const updatedAt = timestamp;
		const stateInfo = resolveState(manifest, enabled, opts.health, validationErrors);
		const active = stateInfo.state === "active" || stateInfo.state === "degraded";
		const record: PluginRegistryRecordV1 = {
			id: manifest.id,
			name: manifest.name,
			version: manifest.version,
			publisher: manifest.publisher,
			source: opts.source ?? "bundled",
			trustTier: manifest.trustTier,
			enabled,
			state: stateInfo.state,
			stateReason: stateInfo.stateReason,
			declaredCapabilities: [...manifest.capabilities],
			grantedCapabilities,
			pendingCapabilities: manifest.capabilities.filter((capability) => !grantedCapabilities.includes(capability)),
			surfaces: active ? manifest.surfaces : EMPTY_PLUGIN_SURFACES,
			health: opts.health,
			installedAt,
			updatedAt,
		};

		this.plugins.set(manifest.id, {
			manifest,
			source: opts.source ?? "bundled",
			record,
			validationErrors,
		});
		this.store = {
			version: 1,
			plugins: {
				...this.store.plugins,
				[manifest.id]: {
					enabled,
					grantedCapabilities,
					installedAt,
					updatedAt,
				},
			},
		};
		this.saveStore();
		recordPluginEvent("plugin.discovered", record);
		if (record.state === "blocked") {
			recordPluginEvent("plugin.blocked", record);
		}
		if (opts.health?.status === "unhealthy") {
			recordPluginEvent("plugin.health_failed", record);
		}
		if (record.state === "degraded") {
			recordPluginEvent("plugin.degraded", record);
		}
		if (active) {
			recordPromptContributionEvents("prompt.contribution_added", record, manifest.promptContributions ?? []);
		}
		return record;
	}

	list(): readonly PluginRegistryRecordV1[] {
		return [...this.plugins.values()].map((plugin) => plugin.record).sort((a, b) => a.id.localeCompare(b.id));
	}

	get(id: string): PluginRegistryRecordV1 | undefined {
		return this.plugins.get(id)?.record;
	}

	diagnostics(id: string): PluginDiagnosticsV1 | undefined {
		const plugin = this.plugins.get(id);
		if (!plugin) return undefined;
		return {
			record: plugin.record,
			manifest: plugin.manifest,
			activeSurfaces: plugin.record.surfaces,
			plannedSurfaces: plugin.manifest.surfaces,
			promptContributions: this.promptContributions({ pluginId: id, activeOnly: false }),
			validationErrors: plugin.validationErrors,
		};
	}

	setEnabled(id: string, enabled: boolean): PluginRegistryRecordV1 | undefined {
		const plugin = this.plugins.get(id);
		if (!plugin) return undefined;
		const previous = this.store.plugins[id];
		this.store = {
			version: 1,
			plugins: {
				...this.store.plugins,
				[id]: {
					...previous,
					enabled,
					updatedAt: this.now().toISOString(),
				},
			},
		};
		this.saveStore();
		const record = this.discover(plugin.manifest, {
			source: plugin.source,
			grantedCapabilities: plugin.record.grantedCapabilities,
			health: plugin.record.health,
		});
		recordPluginEvent(enabled ? "plugin.enabled" : "plugin.disabled", record);
		if (!enabled) {
			recordPromptContributionEvents("prompt.contribution_removed", record, plugin.manifest.promptContributions ?? []);
		}
		return record;
	}

	promptContributions(
		opts: {
			readonly target?: PluginPromptTargetV1;
			readonly pluginId?: string;
			readonly activeOnly?: boolean;
		} = {},
	): readonly PluginPromptContributionV1[] {
		const activeOnly = opts.activeOnly ?? true;
		const contributions: PluginPromptContributionV1[] = [];
		for (const plugin of this.plugins.values()) {
			if (opts.pluginId && plugin.record.id !== opts.pluginId) continue;
			const active = plugin.record.state === "active" || plugin.record.state === "degraded";
			if (activeOnly && !active) continue;
			for (const contribution of plugin.manifest.promptContributions ?? []) {
				if (opts.target && contribution.target !== opts.target) continue;
				contributions.push(clipPromptContribution(contribution));
			}
		}
		return contributions.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
	}

	private loadStore(): PluginRegistryStoreV1 {
		if (!this.storagePath || !existsSync(this.storagePath)) {
			return { version: 1, plugins: {} };
		}
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.storagePath, "utf-8"));
			return parseStore(parsed);
		} catch {
			return { version: 1, plugins: {} };
		}
	}

	private saveStore(): void {
		if (!this.storagePath) return;
		mkdirSync(dirname(this.storagePath), { recursive: true });
		writeFileSync(this.storagePath, `${JSON.stringify(this.store, null, 2)}\n`, { mode: 0o600 });
	}
}

export function getDefaultPluginRegistryPath(): string {
	return join(process.env.SIGNET_PATH || join(homedir(), ".agents"), ".daemon", "plugins", "registry-v1.json");
}

function resolveState(
	manifest: PluginManifestV1,
	enabled: boolean,
	health: PluginHealthV1 | undefined,
	validationErrors: readonly string[],
): { readonly state: PluginLifecycleStateV1; readonly stateReason?: string } {
	if (validationErrors.length > 0) {
		return { state: "blocked", stateReason: validationErrors.join("; ") };
	}
	const unsupported = unsupportedRuntimeReason(manifest);
	if (unsupported) {
		return { state: "blocked", stateReason: unsupported };
	}
	if (!enabled) {
		return { state: "disabled", stateReason: "disabled by host policy" };
	}
	if (health?.status === "unhealthy") {
		return { state: "degraded", stateReason: health.message ?? "plugin health check failed" };
	}
	if (health?.status === "degraded") {
		return { state: "degraded", stateReason: health.message ?? "plugin health degraded" };
	}
	return { state: "active" };
}

function normalizeCapabilities(capabilities: readonly string[]): readonly string[] {
	return [...new Set(capabilities)].sort();
}

function parseStore(value: unknown): PluginRegistryStoreV1 {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.plugins)) {
		return { version: 1, plugins: {} };
	}
	const plugins: Record<string, PersistedPluginStateV1> = {};
	for (const [id, raw] of Object.entries(value.plugins)) {
		if (!isRecord(raw)) continue;
		plugins[id] = {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
			grantedCapabilities: parseStringArray(raw.grantedCapabilities),
			installedAt: typeof raw.installedAt === "string" ? raw.installedAt : undefined,
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
		};
	}
	return { version: 1, plugins };
}

function parseStringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = value.filter((entry): entry is string => typeof entry === "string");
	return values.length > 0 ? values : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clipPromptContribution(contribution: PluginPromptContributionV1): PluginPromptContributionV1 {
	const maxChars = Math.max(1, contribution.maxTokens) * 4;
	if (contribution.content.length <= maxChars) return contribution;
	return {
		...contribution,
		content: contribution.content.slice(0, Math.max(0, maxChars - 1)).trimEnd(),
	};
}

function recordPluginEvent(event: string, record: PluginRegistryRecordV1): void {
	logger.info("plugins", event, {
		pluginId: record.id,
		state: record.state,
		enabled: record.enabled,
		timestamp: new Date().toISOString(),
		...(record.stateReason ? { stateReason: record.stateReason } : {}),
	});
}

function recordPromptContributionEvents(
	event: string,
	record: PluginRegistryRecordV1,
	contributions: readonly PluginPromptContributionV1[],
): void {
	for (const contribution of contributions) {
		logger.info("plugins", event, {
			pluginId: record.id,
			contributionId: contribution.id,
			target: contribution.target,
			mode: contribution.mode,
			timestamp: new Date().toISOString(),
		});
	}
}
