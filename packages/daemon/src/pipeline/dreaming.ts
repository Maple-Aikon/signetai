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

interface DreamingMutation {
	readonly op: string;
	readonly [key: string]: unknown;
}

export interface DreamingResult {
	readonly mutations: readonly DreamingMutation[];
	readonly summary: string;
	readonly tokensConsumed: number;
}

export interface DreamingState {
	readonly tokensSinceLastPass: number;
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
				`SELECT tokens_since_last_pass, last_pass_at,
				        last_pass_id, last_pass_mode
				 FROM dreaming_state WHERE agent_id = ?`,
			)
			.get(agentId) as
			| {
					tokens_since_last_pass: number;
					last_pass_at: string | null;
					last_pass_id: string | null;
					last_pass_mode: string | null;
			  }
			| undefined;
		if (!row) {
			return { tokensSinceLastPass: 0, lastPassAt: null, lastPassId: null, lastPassMode: null };
		}
		return {
			tokensSinceLastPass: row.tokens_since_last_pass,
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
			     last_pass_at = datetime('now'),
			     last_pass_id = ?,
			     last_pass_mode = ?,
			     updated_at = datetime('now')
			 WHERE agent_id = ?`,
		).run(passId, mode, agentId);
	} else {
		db.prepare(
			`INSERT INTO dreaming_state (agent_id, tokens_since_last_pass, last_pass_at, last_pass_id, last_pass_mode)
			 VALUES (?, 0, datetime('now'), ?, ?)`,
		).run(agentId, passId, mode);
	}
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

function completeDreamingPass(
	accessor: DbAccessor,
	passId: string,
	agentId: string,
	mode: string,
	result: { tokensConsumed: number; applied: number; skipped: number; failed: number; summary: string },
): void {
	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE dreaming_passes
			 SET status = 'completed',
			     completed_at = datetime('now'),
			     tokens_consumed = ?,
			     mutations_applied = ?,
			     mutations_failed = ?,
			     summary = ?
			 WHERE id = ?`,
		).run(result.tokensConsumed, result.applied, result.failed, result.summary, passId);
		resetDreamingTokens(db, agentId, passId, mode);
	});
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
	for (const entity of graph.entities) {
		graphText += `\n## ${entity.name} (${entity.entityType})`;
		if (entity.description) graphText += `\n${entity.description}`;
		const aspects = aspectsByEntity.get(entity.id) ?? [];
		for (const aspect of aspects) {
			graphText += `\n### ${aspect.name} (weight: ${aspect.weight.toFixed(2)})`;
			const attrs = attrsByAspect.get(aspect.id) ?? [];
			for (const attr of attrs) {
				const tag = attr.kind === "constraint" ? " [CONSTRAINT]" : "";
				graphText += `\n- ${attr.content}${tag}`;
			}
		}
		graphText += "\n";
	}

	let depText = "";
	for (const dep of graph.dependencies) {
		const src = entityMap.get(dep.sourceEntityId)?.name ?? dep.sourceEntityId;
		const tgt = entityMap.get(dep.targetEntityId)?.name ?? dep.targetEntityId;
		depText += `\n- ${src} --[${dep.dependencyType}]--> ${tgt} (strength: ${dep.strength.toFixed(2)}, confidence: ${dep.confidence.toFixed(2)})`;
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
	return {
		mutations: Array.isArray(parsed.mutations) ? (parsed.mutations as DreamingMutation[]) : [],
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
					default:
						errors.push(`Unknown op: ${mut.op}`);
						failed++;
						return undefined;
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

function applyCreateEntity(db: WriteDb, agentId: string, mut: DreamingMutation): "applied" | "skipped" {
	const name = mut.name as string;
	const type = (mut.type as string) ?? "unknown";
	if (!name) return "skipped";
	const entityId = resolveOrCreateEntity(db, agentId, name, type);
	const aspects = mut.aspects as Array<{ name: string; attributes?: string[] }> | undefined;
	if (!aspects) return "applied";
	for (const aspect of aspects) {
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

function applyMergeEntities(db: WriteDb, agentId: string, mut: DreamingMutation): "applied" | "skipped" {
	const sources = mut.source as string[] | undefined;
	const target = mut.target as string;
	if (!sources || !target || sources.length === 0) return "skipped";

	// Resolve or create the target entity
	const targetId = resolveOrCreateEntity(db, agentId, target);

	for (const src of sources) {
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

function applyDeleteEntity(db: WriteDb, agentId: string, mut: DreamingMutation): "applied" | "skipped" {
	const name = mut.name as string;
	if (!name) return "skipped";
	const entityId = resolveEntity(db, agentId, name);
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

function applyUpdateAspect(db: WriteDb, agentId: string, mut: DreamingMutation): "applied" | "skipped" {
	const entityName = mut.entity as string;
	const aspectName = mut.aspect as string;
	const attributes = mut.attributes as string[] | undefined;
	if (!entityName || !aspectName || !attributes) return "skipped";

	const entityId = resolveEntity(db, agentId, entityName);
	if (!entityId) return "skipped";
	const aspectId = resolveOrCreateAspect(db, entityId, agentId, aspectName);

	for (const content of attributes) {
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

function applyDeleteAspect(db: WriteDb, agentId: string, mut: DreamingMutation): "applied" | "skipped" {
	const entityName = mut.entity as string;
	const aspectName = mut.aspect as string;
	if (!entityName || !aspectName) return "skipped";

	const entityId = resolveEntity(db, agentId, entityName);
	if (!entityId) return "skipped";
	const aspectId = resolveAspect(db, entityId, agentId, aspectName);
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

function applySupersede(db: WriteDb, agentId: string, mut: DreamingMutation): "applied" | "skipped" {
	const entityName = mut.entity as string;
	const aspectName = mut.aspect as string;
	const oldContent = mut.old as string;
	const newContent = mut.new as string;
	if (!entityName || !aspectName || !oldContent || !newContent) return "skipped";

	const entityId = resolveEntity(db, agentId, entityName);
	if (!entityId) return "skipped";
	const aspectId = resolveAspect(db, entityId, agentId, aspectName);
	if (!aspectId) return "skipped";

	// Find old attribute
	const normalizedOld = oldContent.trim().toLowerCase();
	const oldAttr = db
		.prepare(
			`SELECT id, kind FROM entity_attributes
			 WHERE aspect_id = ? AND agent_id = ? AND normalized_content = ? AND status = 'active'`,
		)
		.get(aspectId, agentId, normalizedOld) as { id: string; kind: string } | undefined;

	// Don't supersede constraints
	if (oldAttr?.kind === "constraint") return "skipped";

	// Create new attribute
	const newId = randomUUID();
	const normalizedNew = newContent.trim().toLowerCase();
	db.prepare(
		`INSERT INTO entity_attributes
		 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
		 VALUES (?, ?, ?, 'attribute', ?, ?, 0.8, 0.5, 'active', datetime('now'), datetime('now'))`,
	).run(newId, aspectId, agentId, newContent.trim(), normalizedNew);

	// Mark old as superseded
	if (oldAttr) {
		db.prepare(
			`UPDATE entity_attributes
			 SET status = 'superseded', superseded_by = ?, updated_at = datetime('now')
			 WHERE id = ?`,
		).run(newId, oldAttr.id);
	}
	return "applied";
}

function applyCreateAttribute(db: WriteDb, agentId: string, mut: DreamingMutation): "applied" | "skipped" {
	const entityName = mut.entity as string;
	const aspectName = mut.aspect as string;
	const content = mut.content as string;
	if (!entityName || !aspectName || !content || content.trim().length < 5) return "skipped";

	const entityId = resolveEntity(db, agentId, entityName);
	if (!entityId) return "skipped";
	const aspectId = resolveOrCreateAspect(db, entityId, agentId, aspectName);

	const normalized = content.trim().toLowerCase();
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
	).run(randomUUID(), aspectId, agentId, content.trim(), normalized);
	return "applied";
}

function applyDeleteAttribute(db: WriteDb, agentId: string, mut: DreamingMutation): "applied" | "skipped" {
	const entityName = mut.entity as string;
	const aspectName = mut.aspect as string;
	const content = mut.content as string;
	if (!entityName || !aspectName || !content) return "skipped";

	const entityId = resolveEntity(db, agentId, entityName);
	if (!entityId) return "skipped";
	const aspectId = resolveAspect(db, entityId, agentId, aspectName);
	if (!aspectId) return "skipped";

	const normalized = content.trim().toLowerCase();
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
		const { summaries, graph } = accessor.withReadDb((db) => {
			const summaries = fetchUnprocessedSummaries(db, agentId, mode === "compact" ? null : state.lastPassAt, 200);
			const graph = fetchEntityGraph(db, agentId);
			return { summaries, graph };
		});

		if (mode === "incremental" && summaries.length === 0 && graph.entities.length === 0) {
			completeDreamingPass(accessor, passId, agentId, mode, {
				tokensConsumed: 0,
				applied: 0,
				skipped: 0,
				failed: 0,
				summary: "No new summaries or entities to process",
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

		// Parse response
		const result = parseDreamingResult(raw);

		logger.info("dreaming", "Dreaming pass produced mutations", {
			count: result.mutations.length,
			summary: result.summary.slice(0, 200),
		});

		// Apply mutations in a single transaction
		const { applied, skipped, failed, errors } = accessor.withWriteTx((db) =>
			applyMutations(db, agentId, result.mutations),
		);

		if (errors.length > 0) {
			logger.warn("dreaming", "Some mutations failed", { errors: errors.slice(0, 10) });
		}

		completeDreamingPass(accessor, passId, agentId, mode, {
			tokensConsumed: result.tokensConsumed,
			applied,
			skipped,
			failed,
			summary: result.summary,
		});

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

export function shouldTriggerDreaming(accessor: DbAccessor, cfg: DreamingConfig, agentId: string): boolean {
	if (!cfg.enabled) return false;
	const state = getDreamingState(accessor, agentId);
	// First run with backfill always triggers
	if (cfg.backfillOnFirstRun && state.lastPassAt === null) return true;
	return state.tokensSinceLastPass >= cfg.tokenThreshold;
}
