/**
 * Benchmark: hybrid recall search latency.
 *
 * Measures the shared hot path used by explicit recall and
 * user-prompt-submit. The benchmark uses a synthetic local workspace so it can
 * be run before and after search changes without touching real memory data.
 *
 * Run:
 *   bun run build:core
 *   bun run platform/daemon/src/memory-search.bench.ts
 *
 * Knobs:
 *   SIGNET_RECALL_BENCH_MEMORIES=2000
 *   SIGNET_RECALL_BENCH_ITERS=60
 *   SIGNET_RECALL_BENCH_EMBED_MS=40
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { loadMemoryConfig } from "./memory-config";
import { hybridRecall } from "./memory-search";

const TEST_DIR = join(tmpdir(), `signet-recall-bench-${Date.now()}`);
const MEMORY_COUNT = parseEnvInt("SIGNET_RECALL_BENCH_MEMORIES", 2000);
const ITERS = parseEnvInt("SIGNET_RECALL_BENCH_ITERS", 60);
const EMBED_MS = parseEnvInt("SIGNET_RECALL_BENCH_EMBED_MS", 40);
const QUERY = "signet memory search performance prompt submit recall";

process.env.SIGNET_PATH = TEST_DIR;

function parseEnvInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function setupWorkspace(): void {
	mkdirSync(join(TEST_DIR, "memory"), { recursive: true });
	writeFileSync(
		join(TEST_DIR, "agent.yaml"),
		[
			"name: RecallBench",
			"search:",
			"  top_k: 20",
			"  min_score: 0.1",
			"embedding:",
			"  provider: none",
			"  model: bench",
			"  dimensions: 768",
			"memory:",
			"  pipelineV2:",
			"    graph:",
			"      enabled: true",
			"    traversal:",
			"      enabled: true",
			"      primary: true",
			"    hints:",
			"      enabled: true",
			"    reranker:",
			"      enabled: true",
			"",
		].join("\n"),
	);

	const dbPath = join(TEST_DIR, "memory", "memories.db");
	if (existsSync(dbPath)) rmSync(dbPath);
	initDbAccessor(dbPath);

	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		const memoryStmt = db.prepare(
			`INSERT INTO memories (
				id, content, type, agent_id, importance, created_at, updated_at, updated_by
			) VALUES (?, ?, 'fact', 'default', ?, ?, ?, 'bench')`,
		);
		const hintStmt = db.prepare(
			`INSERT INTO memory_hints (id, memory_id, agent_id, hint, created_at)
			 VALUES (?, ?, 'default', ?, ?)`,
		);
		const mentionStmt = db.prepare("INSERT INTO memory_entity_mentions (memory_id, entity_id) VALUES (?, ?)");

		db.prepare(
			`INSERT INTO entities (
				id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
			) VALUES (?, ?, ?, 'project', 'default', ?, ?, ?)`,
		).run("ent-signet", "Signet", "signet", MEMORY_COUNT, now, now);

		for (let i = 0; i < MEMORY_COUNT; i++) {
			const id = `bench-mem-${String(i).padStart(5, "0")}`;
			const topic =
				i % 3 === 0
					? "prompt submit recall latency"
					: i % 3 === 1
						? "memory search performance"
						: "agent context retrieval";
			memoryStmt.run(
				id,
				`Signet ${topic} benchmark memory ${i}. This record keeps recall behavior measurable under lexical, hint, and traversal search.`,
				0.3 + (i % 7) * 0.08,
				now,
				now,
			);
			if (i < 200) {
				hintStmt.run(`hint-${id}`, id, `How fast is Signet ${topic}?`, now);
				mentionStmt.run(id, "ent-signet");
			}
		}
	});
}

async function fakeEmbedding(): Promise<number[]> {
	await Bun.sleep(EMBED_MS);
	return Array.from({ length: 768 }, (_, index) => (index % 17) / 17);
}

interface Stats {
	readonly avg: number;
	readonly p50: number;
	readonly p95: number;
	readonly min: number;
	readonly max: number;
}

function stats(times: readonly number[]): Stats {
	const sorted = [...times].sort((a, b) => a - b);
	const sum = sorted.reduce((acc, value) => acc + value, 0);
	return {
		avg: sum / sorted.length,
		p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
		p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
		min: sorted[0] ?? 0,
		max: sorted[sorted.length - 1] ?? 0,
	};
}

function printStats(label: string, result: Stats): void {
	console.log(`\n${label}`);
	console.log("=".repeat(64));
	console.log(
		`avg ${result.avg.toFixed(2)}ms | p50 ${result.p50.toFixed(2)}ms | p95 ${result.p95.toFixed(2)}ms | min ${result.min.toFixed(2)}ms | max ${result.max.toFixed(2)}ms`,
	);
}

setupWorkspace();
const cfg = loadMemoryConfig(TEST_DIR);
const params = {
	query: QUERY,
	keywordQuery: QUERY,
	limit: 10,
	agentId: "default",
	readPolicy: "isolated",
} as const;

console.log("\nHybrid recall latency benchmark");
console.log("=".repeat(64));
console.log(`workspace: ${TEST_DIR}`);
console.log(`memories: ${MEMORY_COUNT}`);
console.log(`iterations: ${ITERS}`);
console.log(`synthetic embedding delay: ${EMBED_MS}ms`);

for (let i = 0; i < 5; i++) {
	await hybridRecall(params, cfg, fakeEmbedding);
}

const times: number[] = [];
let ids = "";
for (let i = 0; i < ITERS; i++) {
	const start = performance.now();
	const result = await hybridRecall(params, cfg, fakeEmbedding);
	times.push(performance.now() - start);
	if (i === 0) ids = result.results.map((row) => row.id).join(", ");
}

printStats("hybridRecall", stats(times));
console.log(`first result ids: ${ids}`);

closeDbAccessor();
if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
process.exit(0);
