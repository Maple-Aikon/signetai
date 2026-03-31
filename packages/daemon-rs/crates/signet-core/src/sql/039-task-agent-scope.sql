-- Migration 039: task agent scoping
-- Mirrors the JS daemon ownership model for scheduled tasks so task-triggered
-- skill analytics are attributed to the task owner instead of the caller.

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
