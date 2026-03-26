import { beforeEach, describe, expect, it } from "bun:test";
import Database from "bun:sqlite";
import type { DbAccessor, WriteDb } from "../db-accessor";
import { deadLetterExtractionJob, deadLetterPendingExtractionJobs } from "./extraction-fallback";

function makeAccessor(db: Database): DbAccessor {
	return {
		withWriteTx<T>(fn: (wdb: WriteDb) => T): T {
			return fn(db as unknown as WriteDb);
		},
		withReadDb<T>(fn: (rdb: Database) => T): T {
			return fn(db);
		},
	};
}

describe("extraction fallback helpers", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(`
			CREATE TABLE memories (
				id TEXT PRIMARY KEY,
				extraction_status TEXT,
				extraction_model TEXT
			);
			CREATE TABLE memory_jobs (
				id TEXT PRIMARY KEY,
				memory_id TEXT NOT NULL,
				job_type TEXT NOT NULL,
				status TEXT NOT NULL,
				error TEXT,
				attempts INTEGER NOT NULL DEFAULT 0,
				max_attempts INTEGER NOT NULL DEFAULT 3,
				failed_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);
		accessor = makeAccessor(db);
	});

	it("dead-letters pending extraction jobs and marks memories failed", () => {
		const now = new Date().toISOString();
		db.prepare("INSERT INTO memories (id, extraction_status) VALUES (?, ?)").run("mem-1", "queued");
		db.prepare(
			`INSERT INTO memory_jobs
			 (id, memory_id, job_type, status, attempts, max_attempts, created_at, updated_at)
			 VALUES (?, ?, 'extract', 'pending', 1, 3, ?, ?)`,
		).run("job-1", "mem-1", now, now);

		const changes = deadLetterPendingExtractionJobs(accessor, {
			reason: "Configured extraction provider unavailable at startup",
			extractionModel: "haiku",
		});

		expect(changes).toBe(1);
		const job = db.prepare("SELECT status, error FROM memory_jobs WHERE id = ?").get("job-1") as {
			status: string;
			error: string;
		};
		const memory = db
			.prepare("SELECT extraction_status, extraction_model FROM memories WHERE id = ?")
			.get("mem-1") as { extraction_status: string; extraction_model: string };
		expect(job.status).toBe("dead");
		expect(job.error).toContain("unavailable");
		expect(memory.extraction_status).toBe("failed");
		expect(memory.extraction_model).toBe("haiku");
	});

	it("creates a dead extraction job when blocking a newly queued memory", () => {
		db.prepare("INSERT INTO memories (id, extraction_status) VALUES (?, ?)").run("mem-2", "queued");

		deadLetterExtractionJob(accessor, "mem-2", {
			reason: "Configured extraction provider unavailable and fallbackProvider is none",
		});

		const job = db.prepare("SELECT status, error FROM memory_jobs WHERE memory_id = ?").get("mem-2") as {
			status: string;
			error: string;
		};
		const memory = db
			.prepare("SELECT extraction_status FROM memories WHERE id = ?")
			.get("mem-2") as { extraction_status: string };
		expect(job.status).toBe("dead");
		expect(job.error).toContain("fallbackProvider is none");
		expect(memory.extraction_status).toBe("failed");
	});
});
