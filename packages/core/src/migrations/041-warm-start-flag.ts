import type { MigrationDb } from "./index";

/**
 * Migration 041: Warm-Start Flag
 *
 * Adds is_warm_start column to memories so synthetic seed memories
 * inserted during predictor warm-start can be excluded from recall
 * results while still training the predictor.
 */

function hasColumn(db: MigrationDb, table: string, col: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<{ name?: unknown }>;
	return rows.some((r) => r.name === col);
}

export function up(db: MigrationDb): void {
	if (!hasColumn(db, "memories", "is_warm_start")) {
		db.exec("ALTER TABLE memories ADD COLUMN is_warm_start INTEGER DEFAULT 0");
	}
	db.exec("CREATE INDEX IF NOT EXISTS idx_memories_warm_start ON memories(is_warm_start) WHERE is_warm_start = 1");
}
