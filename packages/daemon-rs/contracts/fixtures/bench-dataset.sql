-- Benchmark dataset: 1000 memories, 50 entities, 10 sessions, 500 embeddings
-- Used by bench-spec.md for reproducible performance testing.
-- Apply to a fresh DB after migrations: sqlite3 bench.db < bench-dataset.sql

-- Insert 1000 memories with varied types
WITH RECURSIVE cnt(x) AS (
  SELECT 1
  UNION ALL
  SELECT x+1 FROM cnt WHERE x < 1000
)
INSERT OR IGNORE INTO memories (id, content, normalized_content, content_hash, type, tags, importance, who, context, created_at, updated_at, is_deleted)
SELECT
  printf('mem-%04d', x),
  'Memory content for benchmark test number ' || x || '. This contains enough text to exercise the FTS5 indexer and produce meaningful search results across different memory types and importance levels.',
  lower('memory content for benchmark test number ' || x || ' this contains enough text to exercise the fts5 indexer'),
  printf('hash%04d', x),
  CASE (x % 4)
    WHEN 0 THEN 'observation'
    WHEN 1 THEN 'fact'
    WHEN 2 THEN 'preference'
    WHEN 3 THEN 'decision'
  END,
  CASE (x % 3)
    WHEN 0 THEN 'testing,benchmark'
    WHEN 1 THEN 'development,code'
    WHEN 2 THEN 'architecture,design'
  END,
  0.3 + (x % 7) * 0.1,
  CASE (x % 5)
    WHEN 0 THEN 'user'
    WHEN 1 THEN 'system'
    WHEN 2 THEN 'agent'
    WHEN 3 THEN 'user'
    WHEN 4 THEN NULL
  END,
  'benchmark-context',
  datetime('2026-01-01', '+' || x || ' minutes'),
  datetime('2026-01-01', '+' || x || ' minutes'),
  0
FROM cnt;

-- Populate FTS index
INSERT OR IGNORE INTO memories_fts (rowid, content)
SELECT rowid, content FROM memories WHERE is_deleted = 0;

-- Insert 50 entities
WITH RECURSIVE cnt(x) AS (
  SELECT 1
  UNION ALL
  SELECT x+1 FROM cnt WHERE x < 50
)
INSERT OR IGNORE INTO entities (id, name, canonical_name, type, first_seen, last_seen, mention_count, agent_id, created_at, updated_at)
SELECT
  printf('ent-%04d', x),
  'Entity ' || x,
  lower('entity ' || x),
  CASE (x % 5)
    WHEN 0 THEN 'person'
    WHEN 1 THEN 'project'
    WHEN 2 THEN 'technology'
    WHEN 3 THEN 'concept'
    WHEN 4 THEN 'organization'
  END,
  datetime('2026-01-01'),
  datetime('2026-01-15'),
  x * 3,
  'bench-agent',
  datetime('2026-01-01'),
  datetime('2026-01-01');

-- Insert 10 sessions
WITH RECURSIVE cnt(x) AS (
  SELECT 1
  UNION ALL
  SELECT x+1 FROM cnt WHERE x < 10
)
INSERT OR IGNORE INTO sessions (session_key, harness, started_at, last_activity_at, status, runtime_path)
SELECT
  printf('bench-session-%02d', x),
  CASE (x % 2) WHEN 0 THEN 'claude-code' ELSE 'opencode' END,
  datetime('2026-01-01', '+' || (x * 60) || ' minutes'),
  datetime('2026-01-01', '+' || (x * 60 + 30) || ' minutes'),
  'ended',
  CASE (x % 2) WHEN 0 THEN 'plugin' ELSE 'legacy' END
FROM cnt;

-- Insert 20 pipeline jobs
WITH RECURSIVE cnt(x) AS (
  SELECT 1
  UNION ALL
  SELECT x+1 FROM cnt WHERE x < 20
)
INSERT OR IGNORE INTO pipeline_jobs (id, type, memory_id, status, priority, attempts, created_at, updated_at)
SELECT
  printf('job-%04d', x),
  CASE (x % 3)
    WHEN 0 THEN 'extraction'
    WHEN 1 THEN 'summary'
    WHEN 2 THEN 'structural-classify'
  END,
  printf('mem-%04d', x),
  CASE (x % 4)
    WHEN 0 THEN 'pending'
    WHEN 1 THEN 'processing'
    WHEN 2 THEN 'completed'
    WHEN 3 THEN 'dead'
  END,
  1,
  CASE WHEN x % 4 = 3 THEN 3 ELSE 0 END,
  datetime('2026-01-01', '+' || x || ' minutes'),
  datetime('2026-01-01', '+' || x || ' minutes')
FROM cnt;
