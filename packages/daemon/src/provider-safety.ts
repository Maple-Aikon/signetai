import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type PipelineProviderChoice, isPipelineProvider } from "@signet/core";
import { parse, stringify } from "yaml";

export type ProviderSafetyRole = "extraction" | "synthesis";

export interface ProviderTransitionAuditEntry {
	readonly role: ProviderSafetyRole;
	readonly from: string | null;
	readonly to: string;
	readonly timestamp: string;
	readonly source: string;
	readonly actor?: string;
	readonly risky: boolean;
}

export interface ProviderSafetySnapshot {
	readonly extractionProvider?: string;
	readonly synthesisProvider?: string;
	readonly allowRemoteProviders: boolean;
}

const REMOTE_PROVIDERS = new Set(["claude-code", "codex", "opencode", "anthropic", "openrouter"]);
const LOCAL_PROVIDERS = new Set(["none", "ollama"]);
const AUDIT_FILE = ".daemon/provider-transitions.json";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readProvider(value: unknown): PipelineProviderChoice | undefined {
	return isPipelineProvider(value) ? value : undefined;
}

function tryReadProviderSafetySnapshot(content: string): ProviderSafetySnapshot | undefined {
	try {
		return readProviderSafetySnapshot(content);
	} catch {
		return undefined;
	}
}

export function isRemotePipelineProvider(provider: string | undefined | null): boolean {
	return provider !== undefined && provider !== null && REMOTE_PROVIDERS.has(provider);
}

export function providerFallbackForLock(
	provider: PipelineProviderChoice,
	fallback: "ollama" | "none" | undefined,
): PipelineProviderChoice {
	return isRemotePipelineProvider(provider) ? (fallback ?? "none") : provider;
}

export function readProviderSafetySnapshot(content: string): ProviderSafetySnapshot {
	const root = asRecord(parse(content)) ?? {};
	const memory = asRecord(root.memory);
	const pipeline = asRecord(memory?.pipelineV2);
	const extraction = asRecord(pipeline?.extraction);
	const synthesis = asRecord(pipeline?.synthesis);
	const flatExtraction = readProvider(pipeline?.extractionProvider);
	const nestedExtraction = readProvider(extraction?.provider);
	const synthesisProvider = readProvider(synthesis?.provider);
	const allowRemoteProviders =
		typeof pipeline?.allowRemoteProviders === "boolean"
			? pipeline.allowRemoteProviders
			: typeof extraction?.allowRemoteProviders === "boolean"
				? extraction.allowRemoteProviders
				: true;
	return {
		extractionProvider: flatExtraction ?? nestedExtraction,
		synthesisProvider,
		allowRemoteProviders,
	};
}

export function validateProviderSafety(content: string): { ok: true } | { ok: false; error: string } {
	const snapshot = tryReadProviderSafetySnapshot(content);
	if (!snapshot) return { ok: false, error: "Invalid YAML config" };
	if (snapshot.allowRemoteProviders) return { ok: true };
	const blocked = [
		["extraction", snapshot.extractionProvider],
		["synthesis", snapshot.synthesisProvider],
	].find(([, provider]) => isRemotePipelineProvider(provider));
	if (!blocked) return { ok: true };
	return {
		ok: false,
		error: `memory.pipelineV2.allowRemoteProviders is false; refusing ${blocked[0]} provider '${blocked[1]}'. Set allowRemoteProviders: true before enabling paid or remote providers.`,
	};
}

export function detectProviderTransitions(
	beforeContent: string | undefined,
	afterContent: string,
	source: string,
	actor?: string,
	now = new Date(),
): ProviderTransitionAuditEntry[] {
	const before = beforeContent === undefined ? undefined : tryReadProviderSafetySnapshot(beforeContent);
	const after = tryReadProviderSafetySnapshot(afterContent);
	if (!after) return [];
	const timestamp = now.toISOString();
	const entries: ProviderTransitionAuditEntry[] = [];
	const pairs: Array<[ProviderSafetyRole, string | undefined, string | undefined]> = [
		["extraction", before?.extractionProvider, after.extractionProvider],
		["synthesis", before?.synthesisProvider, after.synthesisProvider],
	];
	for (const [role, from, to] of pairs) {
		if (!to || from === to) continue;
		entries.push({
			role,
			from: from ?? null,
			to,
			timestamp,
			source,
			actor,
			risky: (from === undefined || LOCAL_PROVIDERS.has(from)) && isRemotePipelineProvider(to),
		});
	}
	return entries;
}

export function providerAuditPath(agentsDir: string): string {
	return join(agentsDir, AUDIT_FILE);
}

export function readProviderTransitions(agentsDir: string): ProviderTransitionAuditEntry[] {
	const path = providerAuditPath(agentsDir);
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		return Array.isArray(parsed) ? (parsed as ProviderTransitionAuditEntry[]) : [];
	} catch {
		return [];
	}
}

export function appendProviderTransitions(agentsDir: string, entries: readonly ProviderTransitionAuditEntry[]): void {
	if (entries.length === 0) return;
	const path = providerAuditPath(agentsDir);
	mkdirSync(dirname(path), { recursive: true });
	const next = [...readProviderTransitions(agentsDir), ...entries].slice(-100);
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
	const current = asRecord(parent[key]);
	if (current) return current;
	const next: Record<string, unknown> = {};
	parent[key] = next;
	return next;
}

export function applyProviderRollback(content: string, entry: ProviderTransitionAuditEntry): string {
	const previous = readString(entry.from);
	if (!previous) throw new Error("No previous provider recorded for rollback");
	const root = asRecord(parse(content)) ?? {};
	const memory = ensureRecord(root, "memory");
	const pipeline = ensureRecord(memory, "pipelineV2");
	if (entry.role === "extraction") {
		if (readString(pipeline.extractionProvider)) {
			pipeline.extractionProvider = previous;
		} else {
			ensureRecord(pipeline, "extraction").provider = previous;
		}
	} else {
		ensureRecord(pipeline, "synthesis").provider = previous;
	}
	return stringify(root);
}
