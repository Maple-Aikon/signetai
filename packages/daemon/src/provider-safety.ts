import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type PipelineProviderChoice, isPipelineProvider } from "@signet/core";
import { parse, stringify } from "yaml";
import { logger } from "./logger.js";

export class RollbackError extends Error {
	constructor(
		message: string,
		readonly status: 404 | 400 | 409,
	) {
		super(message);
		this.name = "RollbackError";
	}
}

export type ProviderSafetyRole = "extraction" | "synthesis";

export interface ProviderTransitionAuditEntry {
	readonly role: ProviderSafetyRole;
	readonly from: string | null;
	readonly to: string;
	readonly timestamp: string;
	readonly source: string;
	readonly actor?: string;
	readonly risky: boolean;
	readonly rolledBack?: boolean;
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

export function tryReadProviderSafetySnapshot(content: string): ProviderSafetySnapshot | undefined {
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
	].filter(([, provider]) => isRemotePipelineProvider(provider));
	if (blocked.length === 0) return { ok: true };
	const parts = blocked.map(([role, provider]) => `${role} provider '${provider}'`);
	return {
		ok: false,
		error: `memory.pipelineV2.allowRemoteProviders is false; refusing: ${parts.join(", ")}. Set allowRemoteProviders: true before enabling paid or remote providers.`,
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

function isValidTransitionEntry(raw: unknown): raw is ProviderTransitionAuditEntry {
	if (typeof raw !== "object" || raw === null) return false;
	const rec = raw as Record<string, unknown>;
	return (
		typeof rec.role === "string" &&
		(rec.role === "extraction" || rec.role === "synthesis") &&
		typeof rec.to === "string" &&
		isPipelineProvider(rec.to) &&
		(rec.from === null || (typeof rec.from === "string" && isPipelineProvider(rec.from))) &&
		typeof rec.timestamp === "string" &&
		rec.timestamp.length > 0 &&
		typeof rec.source === "string" &&
		rec.source.length > 0 &&
		typeof rec.risky === "boolean" &&
		(rec.rolledBack === undefined || typeof rec.rolledBack === "boolean") &&
		(rec.actor === undefined || typeof rec.actor === "string")
	);
}

export function readProviderTransitions(agentsDir: string): ProviderTransitionAuditEntry[] {
	const path = providerAuditPath(agentsDir);
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isValidTransitionEntry) as ProviderTransitionAuditEntry[];
	} catch {
		return [];
	}
}

function atomicWriteJson(targetPath: string, data: string): void {
	const tmpPath = join(dirname(targetPath), `.audit-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
	try {
		writeFileSync(tmpPath, data, "utf-8");
		renameSync(tmpPath, targetPath);
	} catch (e) {
		try {
			unlinkSync(tmpPath);
		} catch {}
		throw e;
	}
}

export function appendProviderTransitions(agentsDir: string, entries: readonly ProviderTransitionAuditEntry[]): void {
	if (entries.length === 0) return;
	const path = providerAuditPath(agentsDir);
	mkdirSync(dirname(path), { recursive: true });
	const next = [...readProviderTransitions(agentsDir), ...entries].slice(-100);
	atomicWriteJson(path, `${JSON.stringify(next, null, 2)}\n`);
}

export const CONFIG_FILE_CANDIDATES = ["agent.yaml", "AGENT.yaml", "config.yaml"] as const;

export function resolveRollbackFilePath(
	agentsDir: string,
	requestedRole?: ProviderSafetyRole,
): { filePath: string; transitions: ProviderTransitionAuditEntry[] } {
	const transitions = readProviderTransitions(agentsDir);
	const reversed = [...transitions].reverse();
	const match = reversed.find(
		(candidate) => candidate.from && !candidate.rolledBack && (!requestedRole || candidate.role === requestedRole),
	);
	if (match) {
		const fromSource = CONFIG_FILE_CANDIDATES.find((c) => match.source.endsWith(c));
		if (fromSource) {
			const resolved = join(agentsDir, fromSource);
			if (existsSync(resolved)) return { filePath: resolved, transitions };
		}
	}
	const fallback = CONFIG_FILE_CANDIDATES.find((name) => existsSync(join(agentsDir, name))) ?? "agent.yaml";
	return { filePath: join(agentsDir, fallback), transitions };
}

export function executeProviderRollback(
	agentsDir: string,
	filePath: string,
	requestedRole?: ProviderSafetyRole,
	actor?: string,
	priorTransitions?: ProviderTransitionAuditEntry[],
): {
	success: true;
	file: string;
	rolledBack: ProviderTransitionAuditEntry;
	providerTransitions: ProviderTransitionAuditEntry[];
} {
	const transitions = [...(priorTransitions ?? readProviderTransitions(agentsDir))];
	const reversed = [...transitions].reverse();
	const matchIdx = reversed.findIndex(
		(candidate) => candidate.from && !candidate.rolledBack && (!requestedRole || candidate.role === requestedRole),
	);
	if (matchIdx < 0) throw new RollbackError("No provider transition with rollback target found", 404);
	const entry = reversed[matchIdx];
	const originalIndex = transitions.length - 1 - matchIdx;
	const beforeContent = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
	const nextContent = applyProviderRollback(beforeContent, entry);
	const safety = validateProviderSafety(nextContent);
	if (!safety.ok) throw new RollbackError(safety.error, 400);
	function markRolledBack(entry: ProviderTransitionAuditEntry): ProviderTransitionAuditEntry {
		return {
			role: entry.role,
			from: entry.from,
			to: entry.to,
			timestamp: entry.timestamp,
			source: entry.source,
			actor: entry.actor,
			risky: entry.risky,
			rolledBack: true,
		};
	}

	const rollbackEntries = detectProviderTransitions(
		beforeContent,
		nextContent,
		"api/config/provider-safety/rollback",
		actor,
	);
	transitions[originalIndex] = markRolledBack(transitions[originalIndex]);
	const merged = [...transitions, ...rollbackEntries].slice(-100);
	const auditPath = providerAuditPath(agentsDir);
	mkdirSync(dirname(auditPath), { recursive: true });
	// Config-first: if audit write fails after config, the entry is
	// unconsumed. On retry, applyProviderRollback re-serializes and
	// rewrites agent.yaml (provider is already correct but YAML comments
	// added since the failed rollback are stripped), then marks consumed.
	// Duplicate audit entries may accumulate on repeated failures.
	writeFileSync(filePath, nextContent, "utf-8");
	try {
		atomicWriteJson(auditPath, `${JSON.stringify(merged, null, 2)}\n`);
	} catch (e) {
		// Config is correct but audit is stale — on retry, the same entry
		// is found again; applyProviderRollback is effectively a no-op but
		// rewrites agent.yaml (stripping comments), then marks consumed.
		logger.error("provider-safety", "Audit write failed after config rollback", {
			error: e instanceof Error ? e.message : String(e),
		});
	}
	return { success: true, file: basename(filePath), rolledBack: entry, providerTransitions: rollbackEntries };
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
