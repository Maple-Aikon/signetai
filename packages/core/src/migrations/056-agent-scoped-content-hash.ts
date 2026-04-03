import type { MigrationDb } from "./index";

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	if (cols.some((col) => col.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Migration 056: Agent-aware content hash dedupe
 *
 * Summary facts and extracted memories may legitimately share identical
 * content across different agent scopes. Tighten the unique partial index so
 * duplicate content_hash values are only rejected within the same
 * (agent_id, scope) tuple.
 */
export function up(db: MigrationDb): void {
	// Defensive repair for stamped-but-partial databases.
	addColumnIfMissing(db, "memories", "agent_id", "TEXT DEFAULT 'default'");
	addColumnIfMissing(db, "memories", "scope", "TEXT");

	db.exec("DROP INDEX IF EXISTS idx_memories_content_hash_unique");
	db.exec(`
		CREATE UNIQUE INDEX idx_memories_content_hash_unique
		ON memories(
			content_hash,
			COALESCE(NULLIF(agent_id, ''), 'default'),
			COALESCE(scope, '__NULL__')
		)
		WHERE content_hash IS NOT NULL AND is_deleted = 0
	`);
}
