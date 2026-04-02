/**
 * Dreaming agent — periodic smart-model consolidation of the knowledge graph.
 *
 * Reads accumulated session summaries and the current entity graph,
 * produces structured graph mutations (create, merge, update, delete,
 * supersede), and applies them transactionally.
 *
 * See docs/specs/approved/dreaming-memory-consolidation.md
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DreamingConfig } from "@signet/core";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DreamingMode = "incremental" | "compact";

type DreamingMutation =
	| {
			readonly op: "create_entity";
			readonly name: string;
			readonly type?: string;
			readonly aspects?: ReadonlyArray<{
				readonly name: string;
				readonly attributes?: readonly string[];
			}>;
	  }
	| {
			readonly op: "merge_entities";
			readonly source: readonly string[];
			readonly target: string;
			readonly reason?: string;
	  }
	| {
			readonly op: "delete_entity";
			readonly name: string;
			readonly reason?: string;
	  }
	| {
			readonly op: "update_aspect";
			readonly entity: string;
			readonly aspect: string;
			readonly attributes: readonly string[];
	  }
	| {
			readonly op: "delete_aspect";
			readonly entity: string;
			readonly aspect: string;
			readonly reason?: string;
	  }
	| {
			readonly op: "supersede_attribute";
			readonly entity: string;
			readonly aspect: string;
			readonly old: string;
			readonly new: string;
	  }
	| {
			readonly op: "create_attribute";
			readonly entity: string;
			readonly aspect: string;
			readonly content: string;
	  }
	| {
			readonly op: "delete_attribute";
			readonly entity: string;
			readonly aspect: string;
			readonly content: string;
			readonly reason?: string;
	  };

export interface DreamingResult {
	readonly mutations: readonly DreamingMutation[];
	readonly summary: string;
	readonly tokensConsumed: number;
}

export interface DreamingState {
	readonly tokensSinceLastPass: number;
	readonly consecutiveFailures: number;
	readonly lastPassAt: string | null;
	readonly lastPassId: string | null;
	readonly lastPassMode: string | null;
}

interface DreamingPassRow {
	readonly id: string;
	readonly mode: string;
	readonly status: string;
	readonly startedAt: string;
	readonly completedAt: string | null;
	readonly tokensConsumed: number | null;
	readonly mutationsApplied: number | null;
	readonly mutationsSkipped: number | null;
	readonly mutationsFailed: number | null;
	readonly summary: string | null;
	readonly error: string | null;
}

interface SessionSummaryRow {
	readonly id: string;
	readonly content: string;
	readonly tokenCount: number;
	readonly sessionKey: string | null;
	readonly project: string | null;
	readonly latestAt: string;
}

interface EntityRow {
	readonly id: string;
	readonly name: string;
	readonly entityType: string;
	readonly description: string | null;
}

interface AspectRow {
	readonly id: string;
	readonly entityId: string;
	readonly name: string;
	readonly weight: number;
}

interface AttributeRow {
	readonly id: string;
	readonly aspectId: string;
	readonly kind: string;
	readonly content: string;
	readonly status: string;
	readonly importance: number;
}

interface DependencyRow {
	readonly id: string;
	readonly sourceEntityId: string;
	readonly targetEntityId: string;
	readonly dependencyType: string;
	readonly strength: number;
	readonly confidence: number;
	readonly reason: string | null;
}

export type LlmGenerateFn = (prompt: string, opts?: { timeoutMs?: number; maxTokens?: number }) => Promise<string>;

// ---------------------------------------------------------------------------
// Dreaming state DB helpers
// ---------------------------------------------------------------------------

export function getDreamingState(accessor: DbAccessor, agentId: string): DreamingState {
	return accessor.withReadDb((db) => {
		const row = db
			.prepare(
				`SELECT tokens_since_last_pass, consecutive_failures,
				        last_pass_at, last_pass_id, last_pass_mode
				 FROM dreaming_state WHERE agent_id = ?`,
			)
			.get(agentId) as
			| {
					tokens_since_last_pass: number;
					consecutive_failures: number;
					last_pass_at: string | null;
					last_pass_id: string | null;
					last_pass_mode: string | null;
			  }
			| undefined;
		if (!row) {
			return { tokensSinceLastPass: 0, consecutiveFailures: 0, lastPassAt: null, lastPassId: null, lastPassMode: null };
		}
		return {
			tokensSinceLastPass: row.tokens_since_last_pass,
			consecutiveFailures: row.consecutive_failures,
			lastPassAt: row.last_pass_at,
			lastPassId: row.last_pass_id,
			lastPassMode: row.last_pass_mode,
		};
	});
}

export function addDreamingTokens(accessor: DbAccessor, agentId: string, tokens: number): void {
	accessor.withWriteTx((db) => {
		const exists = db.prepare("SELECT 1 FROM dreaming_state WHERE agent_id = ?").get(agentId);
		if (exists) {
			db.prepare(
				`UPDATE dreaming_state
				 SET tokens_since_last_pass = tokens_since_last_pass + ?,
				     updated_at = datetime('now')
				 WHERE agent_id = ?`,
			).run(tokens, agentId);
		} else {
			db.prepare(
				`INSERT INTO dreaming_state (agent_id, tokens_since_last_pass)
				 VALUES (?, ?)`,
			).run(agentId, tokens);
		}
	});
}

function resetDreamingTokens(db: WriteDb, agentId: string, passId: string, mode: string): void {
	const exists = db.prepare("SELECT 1 FROM dreaming_state WHERE agent_id = ?").get(agentId);
	if (exists) {
		db.prepare(
			`UPDATE dreaming_state
			 SET tokens_since_last_pass = 0,
			     consecutive_failures = 0,
			     last_pass_at = datetime('now'),
			     last_pass_id = ?,
			     last_pass_mode = ?,
			     updated_at = datetime('now')
			 WHERE agent_id = ?`,
		).run(passId, mode, agentId);
	} else {
		db.prepare(
			`INSERT INTO dreaming_state (agent_id, tokens_since_last_pass, consecutive_failures, last_pass_at, last_pass_id, last_pass_mode)
			 VALUES (?, 0, 0, datetime('now'), ?, ?)`,
		).run(agentId, passId, mode);
	}
}

export function recordDreamingFailure(accessor: DbAccessor, agentId: string): void {
	accessor.withWriteTx((db) => {
		const exists = db.prepare("SELECT 1 FROM dreaming_state WHERE agent_id = ?").get(agentId);
		if (exists) {
			db.prepare(
				`UPDATE dreaming_state
				 SET consecutive_failures = consecutive_failures + 1,
				     updated_at = datetime('now')
				 WHERE agent_id = ?`,
			).run(agentId);
		} else {
			db.prepare(
				`INSERT INTO dreaming_state (agent_id, tokens_since_last_pass, consecutive_failures)
				 VALUES (?, 0, 1)`,
			).run(agentId);
		}
	});
}

// ---------------------------------------------------------------------------
// Dreaming pass records
// ---------------------------------------------------------------------------

function createDreamingPass(accessor: DbAccessor, agentId: string, mode: DreamingMode): string {
	const id = randomUUID();
	accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO dreaming_passes (id, agent_id, mode, status, started_at, created_at)
			 VALUES (?, ?, ?, 'running', datetime('now'), datetime('now'))`,
		).run(id, agentId, mode);
	});
	return id;
}

function failDreamingPass(accessor: DbAccessor, passId: string, error: string): void {
	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE dreaming_passes
			 SET status = 'failed',
			     completed_at = datetime('now'),
			     error = ?
			 WHERE id = ?`,
		).run(error, passId);
	});
}

export function getDreamingPasses(accessor: DbAccessor, agentId: string, limit = 10): readonly DreamingPassRow[] {
	return accessor.withReadDb((db) => {
		return db
			.prepare(
				`SELECT id, mode, status, started_at AS startedAt,
				        completed_at AS completedAt, tokens_consumed AS tokensConsumed,
				        mutations_applied AS mutationsApplied,
				        mutations_skipped AS mutationsSkipped,
				        mutations_failed AS mutationsFailed,
				        summary, error
				 FROM dreaming_passes
				 WHERE agent_id = ?
				 ORDER BY created_at DESC
				 LIMIT ?`,
			)
			.all(agentId, limit) as DreamingPassRow[];
	});
}

// ---------------------------------------------------------------------------
// Data fetching for prompt assembly
// ---------------------------------------------------------------------------

function fetchUnprocessedSummaries(
	db: ReadDb,
	agentId: string,
	since: string | null,
	limit: number,
): readonly SessionSummaryRow[] {
	const query = since
		? `SELECT id, content, token_count AS tokenCount,
		          session_key AS sessionKey, project,
		          latest_at AS latestAt
		   FROM session_summaries
		   WHERE agent_id = ? AND depth = 0
		     AND COALESCE(source_type, 'summary') = 'summary'
		     AND latest_at > ?
		   ORDER BY latest_at ASC
		   LIMIT ?`
		: `SELECT id, content, token_count AS tokenCount,
		          session_key AS sessionKey, project,
		          latest_at AS latestAt
		   FROM session_summaries
		   WHERE agent_id = ? AND depth = 0
		     AND COALESCE(source_type, 'summary') = 'summary'
		   ORDER BY latest_at ASC
		   LIMIT ?`;
	const args = since ? [agentId, since, limit] : [agentId, limit];
	return db.prepare(query).all(...args) as SessionSummaryRow[];
}

function fetchEntityGraph(
	db: ReadDb,
	agentId: string,
	limits?: { entities?: number; aspects?: number; attributes?: number; dependencies?: number },
): {
	entities: readonly EntityRow[];
	aspects: readonly AspectRow[];
	attributes: readonly AttributeRow[];
	dependencies: readonly DependencyRow[];
} {
	const maxEntities = limits?.entities ?? 2000;
	const maxAspects = limits?.aspects ?? 10_000;
	const maxAttrs = limits?.attributes ?? 50_000;
	const maxDeps = limits?.dependencies ?? 10_000;

	const entities = db
		.prepare(
			`SELECT id, name, entity_type AS entityType, description
			 FROM entities WHERE agent_id = ?
			 ORDER BY mentions DESC, updated_at DESC
			 LIMIT ?`,
		)
		.all(agentId, maxEntities) as EntityRow[];

	const aspects = db
		.prepare(
			`SELECT ea.id, ea.entity_id AS entityId, ea.name, ea.weight
			 FROM entity_aspects ea
			 WHERE ea.agent_id = ?
			 ORDER BY ea.weight DESC
			 LIMIT ?`,
		)
		.all(agentId, maxAspects) as AspectRow[];

	const attributes = db
		.prepare(
			`SELECT ea.id, ea.aspect_id AS aspectId, ea.kind, ea.content,
			        ea.status, ea.importance
			 FROM entity_attributes ea
			 WHERE ea.agent_id = ? AND ea.status = 'active'
			 ORDER BY ea.importance DESC
			 LIMIT ?`,
		)
		.all(agentId, maxAttrs) as AttributeRow[];

	const dependencies = db
		.prepare(
			`SELECT id, source_entity_id AS sourceEntityId,
			        target_entity_id AS targetEntityId,
			        dependency_type AS dependencyType,
			        strength, confidence, reason
			 FROM entity_dependencies
			 WHERE agent_id = ?
			 LIMIT ?`,
		)
		.all(agentId, maxDeps) as DependencyRow[];

	return { entities, aspects, attributes, dependencies };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function readIdentityFile(dir: string, name: string): string {
	try {
		return readFileSync(join(dir, name), "utf-8").trim();
	} catch {
		return "";
	}
}

function buildDreamingPrompt(
	mode: DreamingMode,
	summaries: readonly SessionSummaryRow[],
	graph: ReturnType<typeof fetchEntityGraph>,
	agentsDir: string,
	maxTokens: number,
): string {
	const identity = [
		readIdentityFile(agentsDir, "AGENTS.md"),
		readIdentityFile(agentsDir, "SOUL.md"),
		readIdentityFile(agentsDir, "IDENTITY.md"),
		readIdentityFile(agentsDir, "USER.md"),
	]
		.filter((s) => s.length > 0)
		.join("\n\n---\n\n");

	const memoryMd = readIdentityFile(agentsDir, "MEMORY.md");

	// Build graph snapshot
	const entityMap = new Map(graph.entities.map((e) => [e.id, e]));
	const aspectsByEntity = new Map<string, AspectRow[]>();
	for (const a of graph.aspects) {
		const list = aspectsByEntity.get(a.entityId) ?? [];
		list.push(a);
		aspectsByEntity.set(a.entityId, list);
	}
	const attrsByAspect = new Map<string, AttributeRow[]>();
	for (const a of graph.attributes) {
		const list = attrsByAspect.get(a.aspectId) ?? [];
		list.push(a);
		attrsByAspect.set(a.aspectId, list);
	}

	let graphText = "";
	// Character budget for graph section: ~30% of token budget (~4 chars/token)
	const graphBudget = Math.floor(maxTokens * 0.3 * 4);
	for (const entity of graph.entities) {
		const entityHeader = `\n## ${entity.name} (${entity.entityType})${entity.description ? `\n${entity.description}` : ""}`;
		if (graphText.length + entityHeader.length > graphBudget) break;
		graphText += entityHeader;
		const aspects = aspectsByEntity.get(entity.id) ?? [];
		for (const aspect of aspects) {
			const aspectLine = `\n### ${aspect.name} (weight: ${aspect.weight.toFixed(2)})`;
			if (graphText.length + aspectLine.length > graphBudget) break;
			graphText += aspectLine;
			const attrs = attrsByAspect.get(aspect.id) ?? [];
			for (const attr of attrs) {
				const tag = attr.kind === "constraint" ? " [CONSTRAINT]" : "";
				const attrLine = `\n- ${attr.content}${tag}`;
				if (graphText.length + attrLine.length > graphBudget) break;
				graphText += attrLine;
			}
		}
		graphText += "\n";
	}

	let depText = "";
	const depBudget = Math.floor(maxTokens * 0.05 * 4); // ~5% for dependencies
	for (const dep of graph.dependencies) {
		const src = entityMap.get(dep.sourceEntityId)?.name ?? dep.sourceEntityId;
		const tgt = entityMap.get(dep.targetEntityId)?.name ?? dep.targetEntityId;
		const line = `\n- ${src} --[${dep.dependencyType}]--> ${tgt} (strength: ${dep.strength.toFixed(2)}, confidence: ${dep.confidence.toFixed(2)})`;
		if (depText.length + line.length > depBudget) break;
		depText += line;
	}

	let summaryText = "";
	// Rough token budget: reserve ~30% for graph, ~10% for identity/instructions
	const summaryBudget = Math.floor(maxTokens * 0.6 * 4); // chars (~4 chars/token)
	let usedChars = 0;
	for (const s of summaries) {
		if (usedChars + s.content.length > summaryBudget) break;
		summaryText += `\n### Session (${s.latestAt})${s.project ? ` — ${s.project}` : ""}\n${s.content}\n`;
		usedChars += s.content.length;
	}

	const modeInstructions =
		mode === "compact"
			? `You are running in COMPACTION mode. Focus on cleaning up the existing graph:
- Merge duplicate and near-duplicate entities (possessive forms, markdown artifacts, abbreviations of the same thing)
- Delete junk entities (fragments, markdown artifacts, truncated names)
- Prune meaningless or broken attributes
- Collapse redundant aspects
- Strengthen the graph structure by consolidating where possible`
			: `You are running in INCREMENTAL mode. Focus on integrating new session learnings:
- Create new entities for significant concepts, people, or projects mentioned in the sessions
- Update existing entity attributes with new information
- Merge any duplicates you notice
- Supersede outdated attributes with newer facts
- Delete attributes that are clearly wrong or outdated
- Add meaningful relationships between entities`;

	return `<identity>
${identity}
</identity>

<working_memory>
${memoryMd}
</working_memory>

<task>
You are taking time to reflect on ${mode === "compact" ? "your knowledge graph" : "your recent sessions"} and consolidate your memory.

${modeInstructions}

Guidelines:
- Constraints (attributes marked [CONSTRAINT]) are important decisions — do NOT delete them unless they are genuinely wrong
- Prefer merging over deleting when entities represent the same concept
- Keep entity names clean and consistent (no markdown formatting, no possessive forms as separate entities)
- When merging, pick the best canonical name as the target
- Provide clear reasons for all deletions and merges
- Be conservative — only change what you're confident about
</task>

${summaryText ? `<recent_sessions>\n${summaryText}\n</recent_sessions>` : ""}

<knowledge_graph>
${graphText}

### Entity Relationships
${depText || "(no relationships yet)"}
</knowledge_graph>

Respond with ONLY a JSON object in this exact format (no markdown code fences, no other text):

{
  "mutations": [
    { "op": "create_entity", "name": "...", "type": "person|project|system|tool|concept|skill|task", "aspects": [{"name": "...", "attributes": ["..."]}] },
    { "op": "merge_entities", "source": ["entity name 1", "entity name 2"], "target": "canonical name", "reason": "..." },
    { "op": "delete_entity", "name": "...", "reason": "..." },
    { "op": "update_aspect", "entity": "...", "aspect": "...", "attributes": ["new attribute 1", "new attribute 2"] },
    { "op": "delete_aspect", "entity": "...", "aspect": "...", "reason": "..." },
    { "op": "supersede_attribute", "entity": "...", "aspect": "...", "old": "old content", "new": "new content" },
    { "op": "create_attribute", "entity": "...", "aspect": "...", "content": "..." },
    { "op": "delete_attribute", "entity": "...", "aspect": "...", "content": "...", "reason": "..." }
  ],
  "summary": "Brief description of what you changed and why"
}`;
}

// ---------------------------------------------------------------------------
// Mutation validation — narrows unknown LLM output to typed DreamingMutation
// ---------------------------------------------------------------------------

const MUTATION_OPS = new Set([
	"create_entity",
	"merge_entities",
	"delete_entity",
	"update_aspect",
	"delete_aspect",
	"supersede_attribute",
	"create_attribute",
	"delete_attribute",
] as const);

function isValidMutation(v: unknown): v is DreamingMutation {
	if (typeof v !== "object" || v === null) return false;
	const obj = v as Record<string, unknown>;
	if (typeof obj.op !== "string" || !MUTATION_OPS.has(obj.op as DreamingMutation["op"])) return false;
	switch (obj.op) {
		case "create_entity":
			return typeof obj.name === "string";
		case "merge_entities":
			return Array.isArray(obj.source) && typeof obj.target === "string";
		case "delete_entity":
			return typeof obj.name === "string";
		case "update_aspect":
			return typeof obj.entity === "string" && typeof obj.aspect === "string" && Array.isArray(obj.attributes);
		case "delete_aspect":
			return typeof obj.entity === "string" && typeof obj.aspect === "string";
		case "supersede_attribute":
			return (
				typeof obj.entity === "string" &&
				typeof obj.aspect === "string" &&
				typeof obj.old === "string" &&
				typeof obj.new === "string"
			);
		case "create_attribute":
			return typeof obj.entity === "string" && typeof obj.aspect === "string" && typeof obj.content === "string";
		case "delete_attribute":
			return typeof obj.entity === "string" && typeof obj.aspect === "string" && typeof obj.content === "string";
		default:
			return false;
	}
}

// ---------------------------------------------------------------------------
// Mutation execution
// ---------------------------------------------------------------------------

function parseDreamingResult(raw: string): DreamingResult {
	// Strip markdown code fences if present
	let cleaned = raw.trim();
	if (cleaned.startsWith("```")) {
		const first = cleaned.indexOf("\n");
		const last = cleaned.lastIndexOf("```");
		if (first > 0 && last > first) {
			cleaned = cleaned.slice(first + 1, last).trim();
		}
	}

	const parsed = JSON.parse(cleaned) as {
		mutations?: unknown[];
		summary?: string;
	};
	const mutations = Array.isArray(parsed.mutations) ? parsed.mutations.filter(isValidMutation) : [];
	return {
		mutations,
		summary: typeof parsed.summary === "string" ? parsed.summary : "No summary provided",
		tokensConsumed: Math.ceil(raw.length / 4), // rough estimate
	};
}

function applyMutations(
	db: WriteDb,
	agentId: string,
	mutations: readonly DreamingMutation[],
): { applied: number; skipped: number; failed: number; errors: readonly string[] } {
	let applied = 0;
	let skipped = 0;
	let failed = 0;
	const errors: string[] = [];

	for (const mut of mutations) {
		try {
			const result = (() => {
				switch (mut.op) {
					case "create_entity":
						return applyCreateEntity(db, agentId, mut);
					case "merge_entities":
						return applyMergeEntities(db, agentId, mut);
					case "delete_entity":
						return applyDeleteEntity(db, agentId, mut);
					case "update_aspect":
						return applyUpdateAspect(db, agentId, mut);
					case "delete_aspect":
						return applyDeleteAspect(db, agentId, mut);
					case "supersede_attribute":
						return applySupersede(db, agentId, mut);
					case "create_attribute":
						return applyCreateAttribute(db, agentId, mut);
					case "delete_attribute":
						return applyDeleteAttribute(db, agentId, mut);
					default: {
						const _exhaustive: never = mut;
						void _exhaustive;
						errors.push("Unknown mutation op");
						failed++;
						return undefined;
					}
				}
			})();
			if (result === undefined) continue;
			if (result === "skipped") {
				skipped++;
			} else {
				applied++;
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			errors.push(`${mut.op} failed: ${msg}`);
			failed++;
		}
	}

	return { applied, skipped, failed, errors };
}

function resolveEntity(db: WriteDb | ReadDb, agentId: string, name: string): string | null {
	const canonical = name.trim().toLowerCase().replace(/\s+/g, " ");
	const row = db
		.prepare(
			`SELECT id FROM entities
			 WHERE agent_id = ?
			   AND (COALESCE(canonical_name, LOWER(name)) = ? OR LOWER(name) = ?)
			 LIMIT 1`,
		)
		.get(agentId, canonical, canonical) as { id: string } | undefined;
	return row?.id ?? null;
}

function resolveOrCreateEntity(db: WriteDb, agentId: string, name: string, type = "unknown"): string {
	const existing = resolveEntity(db, agentId, name);
	if (existing) return existing;
	const id = randomUUID();
	const canonical = name.trim().toLowerCase().replace(/\s+/g, " ");
	db.prepare(
		`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`,
	).run(id, name.trim(), canonical, type, agentId);
	return id;
}

function resolveAspect(db: WriteDb | ReadDb, entityId: string, agentId: string, name: string): string | null {
	const canonical = name.trim().toLowerCase().replace(/\s+/g, " ");
	const row = db
		.prepare(
			`SELECT id FROM entity_aspects
			 WHERE entity_id = ? AND agent_id = ? AND canonical_name = ?
			 LIMIT 1`,
		)
		.get(entityId, agentId, canonical) as { id: string } | undefined;
	return row?.id ?? null;
}

function resolveOrCreateAspect(db: WriteDb, entityId: string, agentId: string, name: string): string {
	const existing = resolveAspect(db, entityId, agentId, name);
	if (existing) return existing;
	const id = randomUUID();
	const canonical = name.trim().toLowerCase().replace(/\s+/g, " ");
	db.prepare(
		`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 0.5, datetime('now'), datetime('now'))`,
	).run(id, entityId, agentId, name.trim(), canonical);
	return id;
}

function applyCreateEntity(
	db: WriteDb,
	agentId: string,
	mut: DreamingMutation & { op: "create_entity" },
): "applied" | "skipped" {
	if (!mut.name) return "skipped";
	const entityId = resolveOrCreateEntity(db, agentId, mut.name, mut.type ?? "unknown");
	if (!mut.aspects) return "applied";
	for (const aspect of mut.aspects) {
		const aspectId = resolveOrCreateAspect(db, entityId, agentId, aspect.name);
		for (const content of aspect.attributes ?? []) {
			if (!content || content.trim().length < 5) continue;
			const normalized = content.trim().toLowerCase();
			const exists = db
				.prepare(
					`SELECT 1 FROM entity_attributes
					 WHERE aspect_id = ? AND agent_id = ? AND normalized_content = ?`,
				)
				.get(aspectId, agentId, normalized);
			if (!exists) {
				db.prepare(
					`INSERT INTO entity_attributes
					 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
					 VALUES (?, ?, ?, 'attribute', ?, ?, 0.8, 0.5, 'active', datetime('now'), datetime('now'))`,
				).run(randomUUID(), aspectId, agentId, content.trim(), normalized);
			}
		}
	}
	return "applied";
}

function applyMergeEntities(
	db: WriteDb,
	agentId: string,
	mut: DreamingMutation & { op: "merge_entities" },
): "applied" | "skipped" {
	if (!mut.source || !mut.target || mut.source.length === 0) return "skipped";

	// Resolve target — do NOT create; if the target doesn't exist, skip
	const targetId = resolveEntity(db, agentId, mut.target);
	if (!targetId) {
		logger.warn("dreaming", `Merge target "${mut.target}" not found, skipping`);
		return "skipped";
	}

	for (const src of mut.source) {
		const srcId = resolveEntity(db, agentId, src);
		if (!srcId || srcId === targetId) continue;

		// Move non-colliding aspects to target
		db.prepare(
			`UPDATE entity_aspects SET entity_id = ?, updated_at = datetime('now')
			 WHERE entity_id = ? AND agent_id = ?
			   AND canonical_name NOT IN (
			     SELECT canonical_name FROM entity_aspects WHERE entity_id = ? AND agent_id = ?
			   )`,
		).run(targetId, srcId, agentId, targetId, agentId);

		// For colliding aspects (same canonical_name on both entities),
		// copy active attributes from the source aspect into the target aspect
		// so they aren't lost in the cascade delete below.
		const collidingSourceAspects = db
			.prepare(
				`SELECT sa.id AS srcAspectId, ta.id AS tgtAspectId
				 FROM entity_aspects sa
				 JOIN entity_aspects ta
				   ON ta.entity_id = ? AND ta.agent_id = ? AND ta.canonical_name = sa.canonical_name
				 WHERE sa.entity_id = ? AND sa.agent_id = ?`,
			)
			.all(targetId, agentId, srcId, agentId) as Array<{ srcAspectId: string; tgtAspectId: string }>;

		for (const { srcAspectId, tgtAspectId } of collidingSourceAspects) {
			// Copy active attributes that don't already exist on the target aspect
			const srcAttrs = db
				.prepare(
					`SELECT content, normalized_content, kind, confidence, importance
					 FROM entity_attributes
					 WHERE aspect_id = ? AND agent_id = ? AND status = 'active'`,
				)
				.all(srcAspectId, agentId) as Array<{
				content: string;
				normalized_content: string;
				kind: string;
				confidence: number;
				importance: number;
			}>;
			for (const attr of srcAttrs) {
				const exists = db
					.prepare(
						`SELECT 1 FROM entity_attributes
						 WHERE aspect_id = ? AND agent_id = ? AND normalized_content = ?`,
					)
					.get(tgtAspectId, agentId, attr.normalized_content);
				if (!exists) {
					db.prepare(
						`INSERT INTO entity_attributes
						 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
					).run(
						randomUUID(),
						tgtAspectId,
						agentId,
						attr.kind,
						attr.content,
						attr.normalized_content,
						attr.confidence,
						attr.importance,
					);
				}
			}
		}

		// Move dependencies (source side)
		db.prepare(
			`UPDATE entity_dependencies SET source_entity_id = ?, updated_at = datetime('now')
			 WHERE source_entity_id = ? AND agent_id = ?`,
		).run(targetId, srcId, agentId);

		// Move dependencies (target side)
		db.prepare(
			`UPDATE entity_dependencies SET target_entity_id = ?, updated_at = datetime('now')
			 WHERE target_entity_id = ? AND agent_id = ?`,
		).run(targetId, srcId, agentId);

		// Clean up self-loop dependencies created by the rewrite
		db.prepare(
			`DELETE FROM entity_dependencies
			 WHERE source_entity_id = target_entity_id AND agent_id = ?`,
		).run(agentId);

		// Move memory mentions (OR IGNORE skips duplicates)
		db.prepare(
			`UPDATE OR IGNORE memory_entity_mentions SET entity_id = ?
			 WHERE entity_id = ?`,
		).run(targetId, srcId);
		// Clean up any remaining source mentions (duplicates skipped above)
		db.prepare("DELETE FROM memory_entity_mentions WHERE entity_id = ?").run(srcId);

		// Transfer mention count
		db.prepare(
			`UPDATE entities SET mentions = mentions + COALESCE(
			   (SELECT mentions FROM entities WHERE id = ?), 0
			 ), updated_at = datetime('now')
			 WHERE id = ?`,
		).run(srcId, targetId);

		// Delete remaining aspects/attributes on source (cascade)
		// and the source entity itself
		db.prepare(
			`DELETE FROM entity_attributes WHERE agent_id = ? AND aspect_id IN (
			   SELECT id FROM entity_aspects WHERE entity_id = ? AND agent_id = ?
			 )`,
		).run(agentId, srcId, agentId);
		db.prepare("DELETE FROM entity_aspects WHERE entity_id = ? AND agent_id = ?").run(srcId, agentId);
		db.prepare("DELETE FROM entities WHERE id = ? AND agent_id = ?").run(srcId, agentId);
	}
	return "applied";
}

function applyDeleteEntity(
	db: WriteDb,
	agentId: string,
	mut: DreamingMutation & { op: "delete_entity" },
): "applied" | "skipped" {
	if (!mut.name) return "skipped";
	const entityId = resolveEntity(db, agentId, mut.name);
	if (!entityId) return "skipped";

	// Don't delete pinned entities
	const pinned = db.prepare("SELECT pinned FROM entities WHERE id = ? AND agent_id = ?").get(entityId, agentId) as
		| { pinned: number }
		| undefined;
	if (pinned?.pinned === 1) return "skipped";

	db.prepare(
		`DELETE FROM entity_attributes WHERE agent_id = ? AND aspect_id IN (
		   SELECT id FROM entity_aspects WHERE entity_id = ? AND agent_id = ?
		 )`,
	).run(agentId, entityId, agentId);
	db.prepare("DELETE FROM entity_aspects WHERE entity_id = ? AND agent_id = ?").run(entityId, agentId);
	db.prepare(
		"DELETE FROM entity_dependencies WHERE (source_entity_id = ? OR target_entity_id = ?) AND agent_id = ?",
	).run(entityId, entityId, agentId);
	db.prepare("DELETE FROM memory_entity_mentions WHERE entity_id = ?").run(entityId);
	db.prepare("DELETE FROM entities WHERE id = ? AND agent_id = ?").run(entityId, agentId);
	return "applied";
}

function applyUpdateAspect(
	db: WriteDb,
	agentId: string,
	mut: DreamingMutation & { op: "update_aspect" },
): "applied" | "skipped" {
	if (!mut.entity || !mut.aspect || !mut.attributes) return "skipped";

	const entityId = resolveEntity(db, agentId, mut.entity);
	if (!entityId) return "skipped";
	const aspectId = resolveOrCreateAspect(db, entityId, agentId, mut.aspect);

	for (const content of mut.attributes) {
		if (!content || content.trim().length < 5) continue;
		const normalized = content.trim().toLowerCase();
		const exists = db
			.prepare(
				`SELECT 1 FROM entity_attributes
				 WHERE aspect_id = ? AND agent_id = ? AND normalized_content = ?`,
			)
			.get(aspectId, agentId, normalized);
		if (!exists) {
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
				 VALUES (?, ?, ?, 'attribute', ?, ?, 0.8, 0.5, 'active', datetime('now'), datetime('now'))`,
			).run(randomUUID(), aspectId, agentId, content.trim(), normalized);
		}
	}
	return "applied";
}

function applyDeleteAspect(
	db: WriteDb,
	agentId: string,
	mut: DreamingMutation & { op: "delete_aspect" },
): "applied" | "skipped" {
	if (!mut.entity || !mut.aspect) return "skipped";

	const entityId = resolveEntity(db, agentId, mut.entity);
	if (!entityId) return "skipped";
	const aspectId = resolveAspect(db, entityId, agentId, mut.aspect);
	if (!aspectId) return "skipped";

	// Don't delete aspects containing constraints
	const constraints = db
		.prepare(
			`SELECT 1 FROM entity_attributes
			 WHERE aspect_id = ? AND agent_id = ? AND kind = 'constraint' AND status = 'active'`,
		)
		.get(aspectId, agentId);
	if (constraints) return "skipped";

	db.prepare("DELETE FROM entity_attributes WHERE aspect_id = ? AND agent_id = ?").run(aspectId, agentId);
	db.prepare("DELETE FROM entity_aspects WHERE id = ? AND agent_id = ?").run(aspectId, agentId);
	return "applied";
}

function applySupersede(
	db: WriteDb,
	agentId: string,
	mut: DreamingMutation & { op: "supersede_attribute" },
): "applied" | "skipped" {
	if (!mut.entity || !mut.aspect || !mut.old || !mut.new) return "skipped";

	const entityId = resolveEntity(db, agentId, mut.entity);
	if (!entityId) return "skipped";
	const aspectId = resolveAspect(db, entityId, agentId, mut.aspect);
	if (!aspectId) return "skipped";

	// Find old attribute
	const normalizedOld = mut.old.trim().toLowerCase();
	const oldAttr = db
		.prepare(
			`SELECT id, kind FROM entity_attributes
			 WHERE aspect_id = ? AND agent_id = ? AND normalized_content = ? AND status = 'active'`,
		)
		.get(aspectId, agentId, normalizedOld) as { id: string; kind: string } | undefined;

	// Don't supersede constraints
	if (oldAttr?.kind === "constraint") return "skipped";
	// Old attribute must exist — don't create orphan replacements
	if (!oldAttr) return "skipped";

	// Create new attribute
	const newId = randomUUID();
	const normalizedNew = mut.new.trim().toLowerCase();
	db.prepare(
		`INSERT INTO entity_attributes
		 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
		 VALUES (?, ?, ?, 'attribute', ?, ?, 0.8, 0.5, 'active', datetime('now'), datetime('now'))`,
	).run(newId, aspectId, agentId, mut.new.trim(), normalizedNew);

	// Mark old as superseded
	db.prepare(
		`UPDATE entity_attributes
		 SET status = 'superseded', superseded_by = ?, updated_at = datetime('now')
		 WHERE id = ?`,
	).run(newId, oldAttr.id);
	return "applied";
}

function applyCreateAttribute(
	db: WriteDb,
	agentId: string,
	mut: DreamingMutation & { op: "create_attribute" },
): "applied" | "skipped" {
	if (!mut.entity || !mut.aspect || !mut.content || mut.content.trim().length < 5) return "skipped";

	const entityId = resolveEntity(db, agentId, mut.entity);
	if (!entityId) return "skipped";
	const aspectId = resolveOrCreateAspect(db, entityId, agentId, mut.aspect);

	const normalized = mut.content.trim().toLowerCase();
	const exists = db
		.prepare(
			`SELECT 1 FROM entity_attributes
			 WHERE aspect_id = ? AND agent_id = ? AND normalized_content = ?`,
		)
		.get(aspectId, agentId, normalized);
	if (exists) return "skipped";

	db.prepare(
		`INSERT INTO entity_attributes
		 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
		 VALUES (?, ?, ?, 'attribute', ?, ?, 0.8, 0.5, 'active', datetime('now'), datetime('now'))`,
	).run(randomUUID(), aspectId, agentId, mut.content.trim(), normalized);
	return "applied";
}

function applyDeleteAttribute(
	db: WriteDb,
	agentId: string,
	mut: DreamingMutation & { op: "delete_attribute" },
): "applied" | "skipped" {
	if (!mut.entity || !mut.aspect || !mut.content) return "skipped";

	const entityId = resolveEntity(db, agentId, mut.entity);
	if (!entityId) return "skipped";
	const aspectId = resolveAspect(db, entityId, agentId, mut.aspect);
	if (!aspectId) return "skipped";

	const normalized = mut.content.trim().toLowerCase();
	// Don't delete constraints
	const attr = db
		.prepare(
			`SELECT id, kind FROM entity_attributes
			 WHERE aspect_id = ? AND agent_id = ? AND normalized_content = ? AND status = 'active'`,
		)
		.get(aspectId, agentId, normalized) as { id: string; kind: string } | undefined;
	if (!attr || attr.kind === "constraint") return "skipped";

	db.prepare(
		`UPDATE entity_attributes SET status = 'deleted', updated_at = datetime('now')
		 WHERE id = ?`,
	).run(attr.id);
	return "applied";
}

// ---------------------------------------------------------------------------
// Main dreaming orchestrator
// ---------------------------------------------------------------------------

export async function runDreamingPass(
	accessor: DbAccessor,
	generate: LlmGenerateFn,
	cfg: DreamingConfig,
	agentsDir: string,
	agentId: string,
	mode: DreamingMode,
): Promise<{ passId: string; applied: number; skipped: number; failed: number; summary: string }> {
	const passId = createDreamingPass(accessor, agentId, mode);

	try {
		// Fetch data
		const state = getDreamingState(accessor, agentId);
		// Derive row limits from token budget — ~40% for graph, ~20 tokens per entity,
		// ~10 per aspect, ~25 per attribute, ~20 per dependency
		const graphTokenBudget = Math.floor(cfg.maxInputTokens * 0.4);
		const graphLimits = {
			entities: Math.max(100, Math.floor(graphTokenBudget / 20)),
			aspects: Math.max(200, Math.floor(graphTokenBudget / 10)),
			attributes: Math.max(500, Math.floor(graphTokenBudget / 25)),
			dependencies: Math.max(200, Math.floor(graphTokenBudget / 20)),
		};

		const { summaries, graph } = accessor.withReadDb((db) => {
			const summaries = fetchUnprocessedSummaries(db, agentId, mode === "compact" ? null : state.lastPassAt, 200);
			const graph = fetchEntityGraph(db, agentId, graphLimits);
			return { summaries, graph };
		});

		if (mode === "incremental" && summaries.length === 0 && graph.entities.length === 0) {
			accessor.withWriteTx((db) => {
				db.prepare(
					`UPDATE dreaming_passes
					 SET status = 'completed',
					     completed_at = datetime('now'),
					     tokens_consumed = 0,
					     mutations_applied = 0,
					     mutations_skipped = 0,
					     mutations_failed = 0,
					     summary = ?
					 WHERE id = ?`,
				).run("No new summaries or entities to process", passId);
				resetDreamingTokens(db, agentId, passId, mode);
			});
			return { passId, applied: 0, skipped: 0, failed: 0, summary: "No new summaries or entities to process" };
		}

		// Build prompt and call LLM
		const prompt = buildDreamingPrompt(mode, summaries, graph, agentsDir, cfg.maxInputTokens);

		logger.info("dreaming", "Starting dreaming pass", {
			mode,
			summaries: summaries.length,
			entities: graph.entities.length,
			promptChars: prompt.length,
		});

		const raw = await generate(prompt, {
			timeoutMs: cfg.timeout,
			maxTokens: cfg.maxOutputTokens,
		});

		// Parse response — include prompt tokens in consumption estimate
		const result = parseDreamingResult(raw);
		const promptTokens = Math.ceil(prompt.length / 4);
		const totalTokens = promptTokens + result.tokensConsumed;

		logger.info("dreaming", "Dreaming pass produced mutations", {
			count: result.mutations.length,
			promptTokens,
			outputTokens: result.tokensConsumed,
			summary: result.summary.slice(0, 200),
		});

		// Apply mutations and complete pass in a single atomic transaction.
		// This prevents a crash between mutation apply and pass completion
		// from leaving the graph mutated with the pass still in 'running'
		// state and the token counter unreset (which would re-trigger).
		const { applied, skipped, failed, errors } = accessor.withWriteTx((db) => {
			const result2 = applyMutations(db, agentId, result.mutations);

			// Complete pass record + reset token counter in same tx
			db.prepare(
				`UPDATE dreaming_passes
				 SET status = 'completed',
				     completed_at = datetime('now'),
				     tokens_consumed = ?,
				     mutations_applied = ?,
				     mutations_skipped = ?,
				     mutations_failed = ?,
				     summary = ?
				 WHERE id = ?`,
			).run(totalTokens, result2.applied, result2.skipped, result2.failed, result.summary, passId);
			resetDreamingTokens(db, agentId, passId, mode);

			return result2;
		});

		if (errors.length > 0) {
			logger.warn("dreaming", "Some mutations failed", { errors: errors.slice(0, 10) });
		}

		logger.info("dreaming", "Dreaming pass complete", {
			applied,
			skipped,
			failed,
			summary: result.summary.slice(0, 200),
		});

		return { passId, applied, skipped, failed, summary: result.summary };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		logger.error("dreaming", "Dreaming pass failed", { error: msg });
		failDreamingPass(accessor, passId, msg);
		throw e;
	}
}

// ---------------------------------------------------------------------------
// Threshold check
// ---------------------------------------------------------------------------

// Max backoff: 5min * 2^6 = ~5.3 hours
const MAX_FAILURE_BACKOFF_MULTIPLIER = 6;

export function shouldTriggerDreaming(accessor: DbAccessor, cfg: DreamingConfig, agentId: string): boolean {
	if (!cfg.enabled) return false;
	const state = getDreamingState(accessor, agentId);

	// Exponential backoff on consecutive failures: require tokens to
	// exceed threshold * 2^failures before retrying. The worker runs
	// every 5 min; this naturally delays retries (5min, 10min, 20min,
	// 40min, 80min, 160min, capped at ~5h).
	if (state.consecutiveFailures > 0) {
		const exp = Math.min(state.consecutiveFailures, MAX_FAILURE_BACKOFF_MULTIPLIER);
		const backoffChecks = 2 ** exp;

		// For first-run failures with backfill, require at least
		// tokenThreshold accumulated before retrying (instead of
		// triggering unconditionally with 0 tokens)
		if (state.lastPassAt === null && cfg.backfillOnFirstRun) {
			return state.tokensSinceLastPass >= cfg.tokenThreshold;
		}

		// For all other cases, multiply the threshold by the backoff factor
		return state.tokensSinceLastPass >= cfg.tokenThreshold * backoffChecks;
	}

	// First run with backfill always triggers (no failures)
	if (cfg.backfillOnFirstRun && state.lastPassAt === null) return true;
	return state.tokensSinceLastPass >= cfg.tokenThreshold;
}
