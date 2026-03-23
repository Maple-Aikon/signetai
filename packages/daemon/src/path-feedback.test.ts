import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@signet/core";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = join(tmpdir(), `signet-path-feedback-test-${Date.now()}`);
process.env.SIGNET_PATH = TEST_DIR;

const { initDbAccessor, closeDbAccessor, getDbAccessor } = await import("./db-accessor");
const { recordPathFeedback } = await import("./path-feedback");

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

function setupDb(): Database {
	const dbPath = join(TEST_DIR, "memory", "memories.db");
	ensureDir(join(TEST_DIR, "memory"));
	if (existsSync(dbPath)) rmSync(dbPath);

	const db = new Database(dbPath);
	db.exec("PRAGMA busy_timeout = 5000");
	runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	closeDbAccessor();
	initDbAccessor(dbPath);
	return db;
}

function seedGraph(db: Database): void {
	const ts = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories
		 (id, type, content, confidence, importance, created_at, updated_at, updated_by, vector_clock, is_deleted)
		 VALUES (?, 'fact', ?, 1.0, 0.5, ?, ?, 'test', '{}', 0)`,
	).run("mem-a", "A memory", ts, ts);
	db.prepare(
		`INSERT INTO entities
		 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
		 VALUES (?, ?, ?, 'project', 'default', 1, ?, ?)`,
	).run("ent-a", "Entity A", "entity a", ts, ts);
	db.prepare(
		`INSERT INTO entities
		 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
		 VALUES (?, ?, ?, 'project', 'default', 1, ?, ?)`,
	).run("ent-b", "Entity B", "entity b", ts, ts);
	db.prepare(
		`INSERT INTO entity_aspects
		 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
		 VALUES (?, ?, 'default', 'timeline', 'timeline', 0.5, ?, ?)`,
	).run("asp-a", "ent-a", ts, ts);
	db.prepare(
		`INSERT INTO entity_attributes
		 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
		 VALUES (?, ?, 'default', ?, 'attribute', 'x', 'x', 1, 0.8, 'active', ?, ?)`,
	).run("attr-a", "asp-a", "mem-a", ts, ts);
	db.prepare(
		`INSERT INTO entity_dependencies
		 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence, reason, created_at, updated_at)
		 VALUES (?, ?, ?, 'default', 'related_to', 0.5, 0.7, 'single-memory', ?, ?)`,
	).run("dep-a", "ent-a", "ent-b", ts, ts);
	db.prepare(
		`INSERT INTO session_memories
		 (id, session_key, memory_id, source, effective_score, final_score, rank, was_injected, fts_hit_count, created_at, path_json)
		 VALUES (?, ?, ?, 'ka_traversal', 0.8, 0.8, 0, 1, 0, ?, ?)`,
	).run(
		"sm-a",
		"sess-a",
		"mem-a",
		ts,
		JSON.stringify({
			entity_ids: ["ent-a", "ent-b"],
			aspect_ids: ["asp-a"],
			dependency_ids: ["dep-a"],
		}),
	);
}

let db: Database;

beforeEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
	ensureDir(TEST_DIR);
	db = setupDb();
	seedGraph(db);
});

afterEach(() => {
	db.close();
	closeDbAccessor();
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("recordPathFeedback", () => {
	it("writes event/stats and propagates aspect + dependency updates", () => {
		const result = recordPathFeedback(getDbAccessor(), {
			sessionKey: "sess-a",
			agentId: "default",
			ratings: { "mem-a": 1 },
			rewards: { "mem-a": { forward_citation: 1 } },
		});

		expect(result.recorded).toBe(1);
		expect(result.propagated).toBe(1);

		const event = db
			.prepare("SELECT rating, reward_forward FROM path_feedback_events WHERE memory_id = ?")
			.get("mem-a") as { rating: number; reward_forward: number } | undefined;
		expect(event).toBeDefined();
		expect(event?.rating).toBe(1);
		expect(event?.reward_forward).toBe(1);

		const stats = db
			.prepare("SELECT sample_count, positive_count FROM path_feedback_stats LIMIT 1")
			.get() as { sample_count: number; positive_count: number } | undefined;
		expect(stats?.sample_count).toBe(1);
		expect(stats?.positive_count).toBe(1);

		const aspect = db
			.prepare("SELECT weight FROM entity_aspects WHERE id = 'asp-a'")
			.get() as { weight: number } | undefined;
		expect(aspect?.weight).toBeGreaterThan(0.5);

		const dep = db
			.prepare("SELECT strength, reason FROM entity_dependencies WHERE id = 'dep-a'")
			.get() as { strength: number; reason: string } | undefined;
		expect(dep?.strength).toBeGreaterThan(0.5);
		expect(dep?.reason).toBe("pattern-matched");
	});

	it("promotes co-occurrence edge after repeated sessions", () => {
		for (const key of ["sess-co-1", "sess-co-2", "sess-co-3"]) {
			recordPathFeedback(getDbAccessor(), {
				sessionKey: key,
				agentId: "default",
				ratings: { "mem-a": 1 },
				paths: {
					"mem-a": {
						entity_ids: ["ent-a", "ent-b"],
						aspect_ids: [],
						dependency_ids: [],
					},
				},
			});
		}

		const edge = db
			.prepare(
				`SELECT reason, confidence
				 FROM entity_dependencies
				 WHERE source_entity_id = 'ent-a'
				   AND target_entity_id = 'ent-b'
				   AND dependency_type = 'related_to'
				 ORDER BY updated_at DESC
				 LIMIT 1`,
			)
			.get() as { reason: string; confidence: number } | undefined;
		expect(edge).toBeDefined();
		expect(edge?.reason).toBe("pattern-matched");
		expect(edge?.confidence).toBeGreaterThanOrEqual(0.5);
	});
});
