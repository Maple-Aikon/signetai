/**
 * Native embedding provider — runs nomic-embed-text ONNX directly
 * via @huggingface/transformers (WASM runtime).
 *
 * Lazy-initialized singleton with mutex-based init to handle
 * concurrent callers during model download.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NativeProviderStatus {
	readonly available: boolean;
	readonly error?: string;
	readonly dimensions: number;
	readonly modelCached: boolean;
}

interface NativeProviderSnapshot {
	readonly initialized: boolean;
	readonly initializing: boolean;
	readonly modelCached: boolean;
}

// We keep a narrow callable type for the pipeline return.
// transformers.js FeatureExtractionPipeline is callable but its
// full type drags in complex generics — this captures the contract
// we actually use and avoids `as unknown as` casts.
interface EmbedFn {
	(text: string, opts?: { pooling?: string; normalize?: boolean }): Promise<{
		data: Float32Array;
	}>;
	dispose?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_ID = "nomic-ai/nomic-embed-text-v1.5";
const EXPECTED_DIMS = 768;

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let embedFn: EmbedFn | null = null;
let initPromise: Promise<void> | null = null;
let initError: string | null = null;
let modelCached = false;

// ---------------------------------------------------------------------------
// Cache directory
// ---------------------------------------------------------------------------

function getCacheDir(): string {
	const agentsDir = process.env.SIGNET_PATH || join(homedir(), ".agents");
	return join(agentsDir, ".models");
}

// ---------------------------------------------------------------------------
// Lazy init
// ---------------------------------------------------------------------------

async function ensureInitialized(): Promise<void> {
	if (embedFn) return;
	if (initPromise) return initPromise;
	initPromise = doInit();
	return initPromise;
}

async function doInit(): Promise<void> {
	try {
		initError = null;

		const cacheDir = getCacheDir();
		mkdirSync(cacheDir, { recursive: true });

		// Dynamic import to avoid top-level WASM load
		const transformers = await import("@huggingface/transformers");

		// Configure cache directory
		transformers.env.cacheDir = cacheDir;
		transformers.env.allowLocalModels = true;

		logger.info("native-embedding", `Initializing ${MODEL_ID} (q8 quantization)`);
		logger.info("native-embedding", `Model cache: ${cacheDir}`);

		const pipe = await transformers.pipeline(
			"feature-extraction",
			MODEL_ID,
			{
				dtype: "q8" as const,
				progress_callback: (progress: {
					status: string;
					progress?: number;
					file?: string;
				}) => {
					if (
						progress.status === "download" &&
						typeof progress.progress === "number"
					) {
						logger.info(
							"native-embedding",
							`Downloading ${progress.file ?? "model"}: ${Math.round(progress.progress)}%`,
						);
					} else if (progress.status === "ready") {
						logger.info("native-embedding", "Model ready");
					}
				},
			},
		);

		// Warm-up to verify output shape
		const warmup = await pipe("test", { pooling: "mean", normalize: true });
		const dims = warmup.data.length;
		if (dims !== EXPECTED_DIMS) {
			throw new Error(
				`Expected ${EXPECTED_DIMS} dimensions but got ${dims}`,
			);
		}

		// The pipeline return is callable — assign to our narrow interface.
		// We verify the contract via the warmup call above rather than
		// relying on type assertions.
		embedFn = pipe;
		modelCached = true;
		logger.info("native-embedding", `Ready — ${EXPECTED_DIMS}-dim embeddings`);
	} catch (err) {
		initError = err instanceof Error ? err.message : String(err);
		initPromise = null; // allow retry on next call
		logger.error("native-embedding", `Init failed: ${initError}`);
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function nativeEmbed(text: string): Promise<number[]> {
	await ensureInitialized();
	if (embedFn === null) {
		throw new Error("Native embedding pipeline failed to initialize");
	}
	const output = await embedFn(text, { pooling: "mean", normalize: true });
	return Array.from(output.data);
}

export async function checkNativeProvider(): Promise<NativeProviderStatus> {
	try {
		await ensureInitialized();
		return {
			available: true,
			dimensions: EXPECTED_DIMS,
			modelCached,
		};
	} catch {
		return {
			available: false,
			error: initError ?? "Native embedding provider not ready",
			dimensions: EXPECTED_DIMS,
			modelCached: false,
		};
	}
}

export async function shutdownNativeProvider(): Promise<void> {
	if (embedFn) {
		if (typeof embedFn.dispose === "function") {
			try {
				await embedFn.dispose();
			} catch {
				// best-effort
			}
		}
		embedFn = null;
		initPromise = null;
		initError = null;
		logger.info("native-embedding", "Provider shut down");
	}
}

export function getNativeProviderStatus(): NativeProviderSnapshot {
	return {
		initialized: embedFn !== null,
		initializing: initPromise !== null && embedFn === null,
		modelCached,
	};
}
