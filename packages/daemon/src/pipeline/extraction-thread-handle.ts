/**
 * Main-thread adapter for the extraction worker thread.
 *
 * Spawns a node:worker_threads Worker running extraction-thread.ts,
 * implements the WorkerHandle interface by translating method calls
 * into IPC messages. Drop-in replacement for the direct startWorker()
 * return value.
 */

import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { logger } from "../logger";
import type { LogCategory } from "../logger";
import type { WorkerInit, WorkerToMainMessage } from "./extraction-thread-protocol";
import type { WorkerHandle, WorkerStats } from "./worker";

const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

export function startExtractionThread(init: WorkerInit): Promise<WorkerHandle> {
	return new Promise<WorkerHandle>((resolve, reject) => {
		const bundled = join(import.meta.dir, "extraction-thread.js");
		const workerPath = existsSync(bundled) ? bundled : join(import.meta.dir, "extraction-thread.ts");
		const worker = new Worker(workerPath, { workerData: init });

		let running = true;
		let latestStats: WorkerStats = {
			failures: 0,
			lastProgressAt: Date.now(),
			pending: 0,
			processed: 0,
			backoffMs: 0,
			overloaded: false,
			loadPerCpu: null,
			maxLoadPerCpu: 0,
			overloadBackoffMs: 0,
			overloadSince: null,
			nextTickInMs: 0,
		};

		const readyTimer = setTimeout(() => {
			reject(new Error(`Extraction worker thread failed to become ready within ${READY_TIMEOUT_MS}ms`));
			worker.terminate();
		}, READY_TIMEOUT_MS);

		worker.on("message", (msg: WorkerToMainMessage) => {
			switch (msg.type) {
				case "ready":
					clearTimeout(readyTimer);
					logger.info("pipeline", "Extraction worker thread ready");
					resolve(handle);
					break;

				case "stopped":
					running = false;
					break;

				case "stats":
					latestStats = msg.stats;
					break;

				case "log": {
					const cat = msg.category as LogCategory;
					if (msg.level === "error") {
						logger.error(cat, msg.message, undefined, msg.data);
					} else if (msg.level === "warn") {
						logger.warn(cat, msg.message, msg.data);
					} else {
						logger.info(cat, msg.message, msg.data);
					}
					break;
				}

				case "error":
					logger.error("pipeline", "Extraction worker thread error", undefined, {
						error: msg.error,
						stack: msg.stack,
					});
					break;

				case "telemetry":
				case "analytics":
					break;
			}
		});

		worker.on("error", (err: Error) => {
			clearTimeout(readyTimer);
			logger.error("pipeline", "Extraction worker thread crashed", err);
			running = false;
			reject(err);
		});

		worker.on("exit", (code: number) => {
			running = false;
			if (code !== 0) {
				logger.warn("pipeline", "Extraction worker thread exited with non-zero code", { code });
			}
		});

		const handle: WorkerHandle = {
			get running() {
				return running;
			},
			get stats(): WorkerStats {
				return latestStats;
			},
			nudge(): void {
				if (!running) return;
				worker.postMessage({ type: "nudge" });
			},
			async stop(): Promise<void> {
				if (!running) return;
				worker.postMessage({ type: "stop" });
				await new Promise<void>((res) => {
					const stopTimer = setTimeout(() => {
						logger.warn("pipeline", "Extraction worker thread stop timed out, terminating");
						worker.terminate();
						res();
					}, STOP_TIMEOUT_MS);
					worker.on("message", (msg: WorkerToMainMessage) => {
						if (msg.type === "stopped") {
							clearTimeout(stopTimer);
							res();
						}
					});
				});
				await worker.terminate();
				running = false;
				logger.info("pipeline", "Extraction worker thread stopped");
			},
		};
	});
}
