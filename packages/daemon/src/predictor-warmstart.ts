/**
 * Predictor Warm-Start
 *
 * Seeds the predictor with synthetic training data derived from agent.yaml
 * so new installations get relevance-ranked memory from session one rather
 * than random ordering during the predictor's cold-start phase.
 *
 * Synthetic memories are excluded from recall (is_warm_start = 1) and decay
 * quickly via low confidence + low importance. Warm-start is skipped when
 * the predictor already has enough real training pairs (>= MIN_PAIRS).
 */

import type { DbAccessor } from "./db-accessor";
import { logger } from "./logger";
import type { PredictorClient } from "./predictor-client";

const MIN_PAIRS = 10;
const WARM_START_SESSION = "warm-start-synthetic";

export interface WarmStartOpts {
	readonly dbPath: string;
	readonly checkpointPath?: string;
	readonly agentId?: string;
	/** Skip the "already trained" guard — used for forced re-warm. */
	readonly force?: boolean;
}

export interface WarmStartResult {
	readonly skipped: boolean;
	readonly skipReason?: string;
	readonly memoriesInserted: number;
	readonly pairsInserted: number;
	readonly trained: boolean;
}

function buildSeeds(name: string, description: string): string[] {
	const seeds: string[] = [`Agent name: ${name}`, `Agent purpose: ${description}`];

	// Extract keywords from description for domain-aware seeds
	const words = description
		.toLowerCase()
		.replace(/[^a-z0-9 ]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 4);
	const unique = [...new Set(words)].slice(0, 5);
	for (const kw of unique) {
		seeds.push(`Domain focus: ${kw}`);
	}

	// Generic structural seeds that help the predictor learn importance signals
	seeds.push(
		"User preference: recent memories are more relevant than old ones",
		"User preference: high-importance memories should surface more often",
		"Frequently accessed memories are more useful than rarely accessed ones",
		"Memories with many entity connections tend to be more relevant",
		"Project-scoped memories are more relevant than global ones in context",
	);

	return seeds;
}

/**
 * Run predictor warm-start.
 * Called once after predictor starts — skipped if already trained.
 * Runs asynchronously; errors are logged but never thrown.
 */
export async function runWarmStart(
	accessor: DbAccessor,
	client: PredictorClient,
	name: string,
	description: string,
	opts: WarmStartOpts,
): Promise<WarmStartResult> {
	const agentId = opts.agentId ?? "default";

	if (client.crashDisabled) {
		return {
			skipped: true,
			skipReason: "predictor crash-disabled",
			memoriesInserted: 0,
			pairsInserted: 0,
			trained: false,
		};
	}
	if (!client.isAlive()) {
		return { skipped: true, skipReason: "predictor not alive", memoriesInserted: 0, pairsInserted: 0, trained: false };
	}

	// Skip if already warm-started
	const alreadyWarmed = accessor.withReadDb((db) => {
		const row = db.prepare("SELECT COUNT(*) as n FROM memories WHERE is_warm_start = 1 AND is_deleted = 0").get() as {
			n: number;
		};
		return row.n > 0;
	});
	if (alreadyWarmed && !opts.force) {
		return { skipped: true, skipReason: "already warm-started", memoriesInserted: 0, pairsInserted: 0, trained: false };
	}

	// Skip if predictor already has real training data
	if (!opts.force) {
		const pairCount = accessor.withReadDb((db) => {
			const row = db.prepare("SELECT COUNT(*) as n FROM predictor_training_pairs WHERE agent_id = ?").get(agentId) as {
				n: number;
			};
			return row.n;
		});
		if (pairCount >= MIN_PAIRS) {
			return {
				skipped: true,
				skipReason: `already has ${pairCount} training pairs`,
				memoriesInserted: 0,
				pairsInserted: 0,
				trained: false,
			};
		}
	}

	const seeds = buildSeeds(name, description);
	const now = new Date().toISOString();

	// Feature distributions for synthetic training pairs
	// High-label: high importance, recent, frequently accessed → should be recalled
	// Low-label: low importance, old, never accessed → should not be recalled
	const highFeatures = { recencyDays: 1, accessCount: 5, importance: 0.8, decayFactor: 0.95, label: 0.9, injected: 1 };
	const lowFeatures = { recencyDays: 60, accessCount: 0, importance: 0.2, decayFactor: 0.3, label: 0.1, injected: 0 };

	let memoriesInserted = 0;
	let pairsInserted = 0;

	accessor.withWriteTx((db) => {
		for (let i = 0; i < seeds.length; i++) {
			const memId = crypto.randomUUID();
			const importance = i < seeds.length / 2 ? 0.6 : 0.3;

			db.prepare(
				`INSERT OR IGNORE INTO memories
				 (id, content, type, confidence, importance, created_at, updated_at, is_warm_start, tags)
				 VALUES (?, ?, 'fact', 0.6, ?, ?, ?, 1, '["warm-start","synthetic"]')`,
			).run(memId, seeds[i], importance, now, now);
			memoriesInserted++;

			// Insert one high-label and one low-label training pair per seed
			const pairFeatures = i % 2 === 0 ? highFeatures : lowFeatures;
			const pairId = crypto.randomUUID();
			db.prepare(
				`INSERT OR IGNORE INTO predictor_training_pairs
				 (id, agent_id, session_key, memory_id, recency_days, access_count, importance,
				  decay_factor, fts_hit_count, is_constraint, combined_label, was_injected, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
			).run(
				pairId,
				agentId,
				WARM_START_SESSION,
				memId,
				pairFeatures.recencyDays,
				pairFeatures.accessCount,
				pairFeatures.importance,
				pairFeatures.decayFactor,
				pairFeatures.label,
				pairFeatures.injected,
				now,
			);
			pairsInserted++;
		}
	});

	logger.info("predictor", "Warm-start: inserted synthetic seeds", {
		memoriesInserted,
		pairsInserted,
		agentId,
	});

	// Train the predictor on the seeded data
	const result = await client.trainFromDb({
		agent_id: agentId,
		db_path: opts.dbPath,
		checkpoint_path: opts.checkpointPath,
	});

	if (!result) {
		logger.warn("predictor", "Warm-start: trainFromDb returned null (non-fatal)");
		return { skipped: false, memoriesInserted, pairsInserted, trained: false };
	}

	logger.info("predictor", "Warm-start complete", {
		loss: result.loss,
		samplesUsed: result.samples_used,
		durationMs: result.duration_ms,
	});

	return { skipped: false, memoriesInserted, pairsInserted, trained: true };
}
