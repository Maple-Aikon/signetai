import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { loadMemoryConfig } from "./memory-config";
import { hybridRecall } from "./memory-search";

describe("hybridRecall", () => {
	let dir = "";
	let prevSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-memory-search-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(join(dir, "agent.yaml"), "name: SearchTest\n");
		prevSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (prevSignetPath === undefined) {
			process.env.SIGNET_PATH = undefined;
		} else {
			process.env.SIGNET_PATH = prevSignetPath;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps expanded transcript sources scoped to the requesting agent", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', ?, ?, ?, ?, 'test')`,
			).run("mem-a", "alpha retrieval context", "sess-shared", "agent-a", now, now);

			db.prepare(
				`INSERT INTO session_transcripts (
					session_key, content, harness, project, agent_id, created_at, updated_at
				) VALUES (?, ?, 'codex', ?, ?, ?, ?)`,
			).run("sess-shared", "agent-a transcript context", "proj-a", "agent-a", now, now);

			db.prepare(
				`INSERT INTO session_transcripts (
					session_key, content, harness, project, agent_id, created_at, updated_at
				) VALUES (?, ?, 'codex', ?, ?, ?, ?)`,
			).run("sess-shared", "agent-b transcript context", "proj-b", "agent-b", now, now);
		});

		const result = await hybridRecall(
			{
				query: "alpha retrieval context",
				keywordQuery: "alpha retrieval context",
				limit: 5,
				agentId: "agent-a",
				readPolicy: "isolated",
				expand: true,
			},
			loadMemoryConfig(dir),
			async () => null,
		);

		expect(result.results.map((row) => row.id)).toContain("mem-a");
		expect(result.sources).toBeDefined();
		expect(result.sources?.["sess-shared"]).toBe("agent-a transcript context");
		expect(Object.values(result.sources ?? {})).not.toContain("agent-b transcript context");
	});

	it("keeps score calibration stable when reranker provider is noop", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', ?, ?, ?, ?, 'test')`,
			).run("mem-a", "deploy rollback checklist release", "sess-a", "default", now, now);

			db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', ?, ?, ?, ?, 'test')`,
			).run("mem-b", "deploy checklist", "sess-a", "default", now, now);
		});

		const base = loadMemoryConfig(dir);
		base.search.rehearsal_enabled = false;
		base.search.min_score = 0;
		base.pipelineV2.graph.enabled = false;
		base.pipelineV2.traversal.enabled = false;
		base.pipelineV2.reranker.enabled = false;

		const withReranker = loadMemoryConfig(dir);
		withReranker.search.rehearsal_enabled = false;
		withReranker.search.min_score = 0;
		withReranker.pipelineV2.graph.enabled = false;
		withReranker.pipelineV2.traversal.enabled = false;
		withReranker.pipelineV2.reranker.enabled = true;
		withReranker.pipelineV2.reranker.topN = 10;

		const params = {
			query: "deploy rollback checklist release",
			keywordQuery: "deploy rollback checklist release",
			limit: 5,
			agentId: "default",
			readPolicy: "isolated",
		} as const;

		const before = await hybridRecall(params, base, async () => null);
		const after = await hybridRecall(params, withReranker, async () => null);

		expect(after.results.map((row) => row.id)).toEqual(before.results.map((row) => row.id));
		expect(after.results.map((row) => row.score)).toEqual(before.results.map((row) => row.score));
	});

	it("filters temporal bookkeeping noise from constructed entity cards", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			).run("mem-signet", "Signet project workspace", now, now);

			db.prepare(
				`INSERT INTO entities (
					id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
				) VALUES (?, ?, ?, 'project', 'default', 10, ?, ?)`,
			).run("ent-signet", "Signet", "signet", now, now);

			db.prepare(
				`INSERT INTO entity_aspects (
					id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at
				) VALUES (?, ?, 'default', 'context', 'context', 0.9, ?, ?)`,
			).run("asp-signet", "ent-signet", now, now);

			const stmt = db.prepare(
				`INSERT INTO entity_attributes (
					id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at
				) VALUES (?, 'asp-signet', 'default', NULL, 'attribute', ?, ?, 1, ?, 'active', ?, ?)`,
			);
			stmt.run("attr-good", "portable memory runtime", "portable memory runtime", 0.9, now, now);
			stmt.run(
				"attr-noise-1",
				"session:abc source=summary latest=2026-03-29",
				"session:abc source=summary latest=2026-03-29",
				0.8,
				now,
				now,
			);
			stmt.run("attr-noise-2", "[[memory/2026-03-29-summary.md]]", "[[memory/2026-03-29-summary.md]]", 0.7, now, now);
		});

		const cfg = loadMemoryConfig(dir);
		cfg.search.rehearsal_enabled = false;
		cfg.search.min_score = 0;
		cfg.pipelineV2.graph.enabled = true;
		cfg.pipelineV2.traversal.enabled = true;
		cfg.pipelineV2.reranker.enabled = false;

		const result = await hybridRecall(
			{
				query: "Signet",
				keywordQuery: "Signet",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
			},
			cfg,
			async () => null,
		);

		const card = result.results.find((row) => row.source === "constructed");
		expect(card).toBeDefined();
		expect(card?.content).toContain("portable memory runtime");
		expect(card?.content).not.toContain("session:abc");
		expect(card?.content).not.toContain("[[memory/");
		expect(card?.content_length ?? 0).toBeLessThanOrEqual(900);
	});
});
