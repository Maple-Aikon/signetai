/**
 * Multi-agent support utilities for Signet.
 *
 * Handles agent discovery, scaffolding, identity file resolution,
 * and per-agent skill filtering.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition, ReadPolicy } from "./types";

export type AgentRosterReadPolicy = "isolated" | "shared" | "group";

export interface NormalizedAgentRosterEntry {
	readonly name: string;
	readonly readPolicy: AgentRosterReadPolicy;
	readonly policyGroup: string | null;
}

/** Identity files that inherit from agent subdir (fall back to root). */
const AGENT_SPECIFIC = new Set(["SOUL.md", "IDENTITY.md"]);

/** All recognized shared identity files. */
const SHARED_FILES = ["AGENTS.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md", "BOOTSTRAP.md"];

/**
 * Scans {agentsDir}/agents/* subdirectories and returns a minimal
 * AgentDefinition for each one found. Returns [] when agents/ is absent.
 */
export function discoverAgents(agentsDir: string): AgentDefinition[] {
	const root = join(agentsDir, "agents");
	if (!existsSync(root)) return [];

	return readdirSync(root, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => ({ name: d.name }));
}

/**
 * Creates {agentsDir}/agents/{name}/ and writes stub identity files
 * (SOUL.md, IDENTITY.md) if they don't already exist.
 */
export function scaffoldAgent(name: string, agentsDir: string): void {
	const dir = join(agentsDir, "agents", name);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const soul = join(dir, "SOUL.md");
	if (!existsSync(soul)) writeFileSync(soul, `# Soul\n\nAdd ${name}'s personality here.\n`);

	const identity = join(dir, "IDENTITY.md");
	if (!existsSync(identity)) writeFileSync(identity, `# Identity\n\nname: ${name}\n`);
}

/**
 * Returns a map of filename → absolute path for each identity file that
 * exists on disk for the given agent.
 *
 * Inheritance rules:
 * - `SOUL.md` and `IDENTITY.md`: agent subdir first, fall back to root.
 * - All other files (`AGENTS.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`,
 *   `MEMORY.md`, `BOOTSTRAP.md`): always use root (shared by all agents).
 */
export function getAgentIdentityFiles(name: string, agentsDir: string): Record<string, string> {
	const result: Record<string, string> = {};
	const agentDir = join(agentsDir, "agents", name);

	for (const file of AGENT_SPECIFIC) {
		const specific = join(agentDir, file);
		const fallback = join(agentsDir, file);
		if (existsSync(specific)) result[file] = specific;
		else if (existsSync(fallback)) result[file] = fallback;
	}

	for (const file of SHARED_FILES) {
		const path = join(agentsDir, file);
		if (existsSync(path)) result[file] = path;
	}

	return result;
}

function normalizeReadPolicy(
	readPolicy: unknown,
	policyGroup: unknown,
): {
	readonly readPolicy: AgentRosterReadPolicy;
	readonly policyGroup: string | null;
} {
	if (readPolicy === "shared") return { readPolicy: "shared", policyGroup: null };
	if (readPolicy === "isolated") return { readPolicy: "isolated", policyGroup: null };
	if (
		typeof readPolicy === "object" &&
		readPolicy !== null &&
		(readPolicy as { type?: unknown }).type === "group" &&
		typeof (readPolicy as { group?: unknown }).group === "string"
	) {
		return {
			readPolicy: "group",
			policyGroup: (readPolicy as { group: string }).group,
		};
	}
	if (readPolicy === "group" && typeof policyGroup === "string") {
		return { readPolicy: "group", policyGroup };
	}
	return { readPolicy: "isolated", policyGroup: null };
}

export function normalizeAgentRosterEntry(entry: unknown): NormalizedAgentRosterEntry | null {
	if (typeof entry !== "object" || entry === null) return null;
	const record = entry as Record<string, unknown>;
	if (typeof record.name !== "string" || record.name.length === 0) return null;
	const memory =
		typeof record.memory === "object" && record.memory !== null ? (record.memory as Record<string, unknown>) : null;
	const policy = normalizeReadPolicy(memory?.read_policy ?? record.read_policy, record.policy_group);
	return {
		name: record.name,
		readPolicy: policy.readPolicy,
		policyGroup: policy.policyGroup,
	};
}

export function buildAgentMemoryConfig(
	readPolicy: AgentRosterReadPolicy,
	policyGroup: string | null,
): { readonly read_policy: ReadPolicy } {
	if (readPolicy === "shared") return { read_policy: "shared" };
	if (readPolicy === "group" && typeof policyGroup === "string" && policyGroup.length > 0) {
		return { read_policy: { type: "group", group: policyGroup } };
	}
	return { read_policy: "isolated" };
}

/**
 * Returns the subset of `allSkills` available to the given agent.
 *
 * - `undefined` / `null` skills → all skills pass through.
 * - Empty array → no skills.
 * - Non-empty array → intersection with `allSkills`.
 */
export function resolveAgentSkills(agentDef: AgentDefinition, allSkills: readonly string[]): string[] {
	if (agentDef.skills == null) return [...allSkills];
	if (agentDef.skills.length === 0) return [];
	const allowed = new Set(agentDef.skills);
	return allSkills.filter((s) => allowed.has(s));
}
