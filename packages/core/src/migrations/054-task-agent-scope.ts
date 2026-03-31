import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as ReadonlyArray<Record<string, unknown>>;
	const names = new Set(cols.map((col) => String(col.name)));

	if (!names.has("agent_id")) {
		db.exec("ALTER TABLE scheduled_tasks ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'");
	}

	db.exec(`
		UPDATE scheduled_tasks
		   SET agent_id = (
				SELECT MIN(sm.agent_id)
				  FROM entities e
				  JOIN skill_meta sm
				    ON sm.entity_id = e.id
				   AND sm.agent_id = e.agent_id
				 WHERE e.entity_type = 'skill'
				   AND sm.uninstalled_at IS NULL
				   AND lower(e.name) = lower(scheduled_tasks.skill_name)
				 GROUP BY lower(e.name)
				HAVING COUNT(DISTINCT sm.agent_id) = 1
		   )
		 WHERE skill_name IS NOT NULL
		   AND (agent_id IS NULL OR agent_id = '' OR agent_id = 'default')
		   AND EXISTS (
				SELECT 1
				  FROM entities e
				  JOIN skill_meta sm
				    ON sm.entity_id = e.id
				   AND sm.agent_id = e.agent_id
				 WHERE e.entity_type = 'skill'
				   AND sm.uninstalled_at IS NULL
				   AND lower(e.name) = lower(scheduled_tasks.skill_name)
				 GROUP BY lower(e.name)
				HAVING COUNT(DISTINCT sm.agent_id) = 1
		   );

		CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_agent
			ON scheduled_tasks(agent_id, created_at);
	`);
}
