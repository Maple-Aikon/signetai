/**
 * Dreaming worker — periodically checks token threshold and triggers
 * consolidation passes. Manages the dreaming lifecycle as a daemon
 * background task.
 */

import type { DreamingConfig } from "@signet/core";
import type { DbAccessor } from "../db-accessor";
import { logger } from "../logger";
import {
	type DreamingMode,
	type LlmGenerateFn,
	getDreamingState,
	recordDreamingFailure,
	runDreamingPass,
	shouldTriggerDreaming,
} from "./dreaming";
import type { LlmProvider } from "./provider";

export interface DreamingWorkerHandle {
	stop(): void;
	/** Force-trigger a pass (API / CLI). */
	trigger(
		mode: DreamingMode,
	): Promise<{ passId: string; applied: number; skipped: number; failed: number; summary: string }>;
	readonly running: boolean;
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min

export function startDreamingWorker(
	accessor: DbAccessor,
	generate: LlmGenerateFn,
	cfg: DreamingConfig,
	agentsDir: string,
	agentId: string,
): DreamingWorkerHandle {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let active = false;
	let stopped = false;

	async function check(): Promise<void> {
		if (stopped || active) return;

		try {
			const state = getDreamingState(accessor, agentId);
			const isFirst = state.lastPassAt === null && cfg.backfillOnFirstRun;
			const mode: DreamingMode = isFirst ? "compact" : "incremental";

			if (!shouldTriggerDreaming(accessor, cfg, agentId)) return;

			logger.info("dreaming-worker", "Token threshold reached, starting dreaming pass", {
				tokens: state.tokensSinceLastPass,
				threshold: cfg.tokenThreshold,
				mode,
			});

			active = true;
			await runDreamingPass(accessor, generate, cfg, agentsDir, agentId, mode);
		} catch (e) {
			recordDreamingFailure(accessor, agentId);
			logger.error("dreaming-worker", "Dreaming check failed", {
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			active = false;
		}
	}

	function schedule(): void {
		if (stopped) return;
		timer = setTimeout(async () => {
			await check();
			schedule();
		}, CHECK_INTERVAL_MS);
	}

	// Start the periodic check
	schedule();

	logger.info("dreaming-worker", "Dreaming worker started", {
		threshold: cfg.tokenThreshold,
		provider: cfg.provider,
		model: cfg.model,
	});

	return {
		// Cancels the timer but does NOT await an in-flight pass.
		// An active pass will complete (or fail) asynchronously; the
		// `stopped` flag prevents new passes from being scheduled.
		stop() {
			stopped = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		},

		async trigger(mode: DreamingMode) {
			if (active) {
				throw new Error("A dreaming pass is already running");
			}
			active = true;
			try {
				return await runDreamingPass(accessor, generate, cfg, agentsDir, agentId, mode);
			} catch (e) {
				recordDreamingFailure(accessor, agentId);
				throw e;
			} finally {
				active = false;
			}
		},

		get running() {
			return active;
		},
	};
}
