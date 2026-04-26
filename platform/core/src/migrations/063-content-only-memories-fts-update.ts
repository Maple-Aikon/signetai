/**
 * Migration 063: avoid FTS churn on metadata-only memory updates.
 *
 * Recall updates access_count and last_accessed for returned memories. The
 * legacy AFTER UPDATE trigger rebuilt the FTS row for every one of those
 * metadata writes, adding avoidable latency to recall and prompt-submit. FTS
 * content only depends on memories.content, so restrict the update trigger to
 * content changes.
 */
export function up(db: { exec(sql: string): void }): void {
	db.exec("DROP TRIGGER IF EXISTS memories_au");
	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);
}
