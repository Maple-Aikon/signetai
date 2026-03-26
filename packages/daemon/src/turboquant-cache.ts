/**
 * TurboQuant KV Cache Compression — Thin TS wrapper over native Rust.
 *
 * Delegates all heavy computation (rotation matrix generation, Beta codebook,
 * quantize/dequantize, residual window management) to the native Rust
 * implementation in `@signet/native` for maximum performance.
 *
 * The API surface matches the original pure-TS implementation so that
 * `native-generation.ts` and other consumers can switch with minimal changes.
 *
 * @see https://arxiv.org/abs/2504.19874
 * @module
 */

import {
	turboquantCompress,
	turboquantDecompress,
	turboquantCreateCache,
	turboquantCacheInsert,
	turboquantCacheGet,
	turboquantCacheAdvance,
	turboquantCacheReset,
	turboquantCacheSeqLen,
	turboquantShouldCompress,
	turboquantCacheStats,
	turboquantCacheCodebook,
	turboquantCacheReconstruct,
	turboquantComputeMemoryStats,
	type TurboQuantConfig,
	type CompressedKvEntryJs,
	type CompressedLayerJs,
	type ReconstructedLayerJs,
	type CacheStatsJs,
	type MemoryStatsJs,
} from "@signet/native";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Valid quantization bit widths. */
const VALID_BITS = [1, 2, 3, 4] as const;
type BitWidth = (typeof VALID_BITS)[number];

export interface TurboQuantKvCacheConfig {
	/** Bits per coordinate (1-4). Higher = more accurate, less compression. */
	readonly bits: BitWidth;
	/** Head dimension of the model (e.g. 64, 128). */
	readonly headDim: number;
	/** Number of attention heads (key side). */
	readonly numHeads: number;
	/**
	 * Number of recent tokens to keep in full precision.
	 * Tokens outside this window are compressed.
	 * @default 128
	 */
	readonly residualWindowSize?: number;
	/** Random seed for deterministic rotation matrix. */
	readonly seed?: number;
}

/**
 * User-facing config option for agent.yaml `memory.kv_cache_compression`.
 * Defaults to OFF — must be explicitly enabled.
 */
export interface KvCacheCompressionOption {
	readonly enabled: boolean;
	readonly bits?: BitWidth;
	readonly residualWindowSize?: number;
}

export const DEFAULT_KV_CACHE_COMPRESSION: KvCacheCompressionOption = {
	enabled: false,
	bits: 4,
	residualWindowSize: 128,
};

// ---------------------------------------------------------------------------
// Compressed KV entry (matches Rust CompressedKvEntryJs)
// ---------------------------------------------------------------------------

/** A single compressed KV vector (one head, one token). */
export interface CompressedKvEntry {
	/** Bit-packed quantization codes. */
	readonly packedCodes: Uint8Array;
	/** Original L2 norm of the vector. */
	readonly norm: number;
	/** Original dimension (needed for unpacking). */
	readonly dim: number;
	/** Bit width used for packing. */
	readonly bits: number;
}

/** Per-layer, per-head compressed KV cache. */
export interface CompressedKvLayer {
	/** Compressed key vectors (one per token outside residual window). */
	readonly keys: readonly CompressedKvEntry[];
	/** Compressed value vectors (one per token outside residual window). */
	readonly values: readonly CompressedKvEntry[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert a TurboQuantKvCacheConfig to the native TurboQuantConfig format. */
function toNativeConfig(config: TurboQuantKvCacheConfig): TurboQuantConfig {
	return {
		bits: config.bits,
		headDim: config.headDim,
		numHeads: config.numHeads,
		residualWindowSize: config.residualWindowSize ?? 128,
		seed: config.seed ?? 42,
	};
}

/** Convert a Float32Array to a Buffer for native call. */
function f32ToBuffer(arr: Float32Array): Buffer {
	return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Convert a native CompressedKvEntryJs to our CompressedKvEntry. */
function fromNativeEntry(entry: CompressedKvEntryJs): CompressedKvEntry {
	return {
		packedCodes: new Uint8Array(entry.packedCodes),
		norm: entry.norm,
		dim: entry.dim,
		bits: entry.bits,
	};
}

/** Convert our CompressedKvEntry to native CompressedKvEntryJs. */
function toNativeEntry(entry: CompressedKvEntry): CompressedKvEntryJs {
	return {
		packedCodes: Buffer.from(entry.packedCodes),
		norm: entry.norm,
		dim: entry.dim,
		bits: entry.bits,
	};
}

// ---------------------------------------------------------------------------
// TurboQuantKvCache — main class (wrapping native cache)
// ---------------------------------------------------------------------------

/**
 * Manages TurboQuant-compressed KV cache for a single attention head dimension.
 *
 * This is a thin wrapper around the native Rust implementation. All heavy
 * computation (rotation, codebook, quantize/dequantize, residual window)
 * happens in Rust.
 *
 * Usage pattern for generative model integration:
 *
 * ```ts
 * const cache = TurboQuantKvCache.create({
 *   bits: 4,
 *   headDim: 128,
 *   numHeads: 32,
 *   residualWindowSize: 128,
 * });
 *
 * // After each decoder step, compress old KV entries:
 * const compressed = cache.compressVector(keyVector);
 * const restored = cache.decompressVector(compressed);
 * ```
 */
export class TurboQuantKvCache {
	private readonly _config: Readonly<Required<TurboQuantKvCacheConfig>>;
	private readonly _nativeConfig: TurboQuantConfig;
	private readonly _cacheHandle: ReturnType<typeof turboquantCreateCache>;
	private readonly _numCentroids: number;

	private constructor(config: Readonly<Required<TurboQuantKvCacheConfig>>) {
		this._config = config;
		this._nativeConfig = toNativeConfig(config);
		this._cacheHandle = turboquantCreateCache(this._nativeConfig);
		this._numCentroids = 2 ** config.bits;
	}

	/**
	 * Create a new TurboQuantKvCache instance.
	 * Validates configuration and precomputes rotation matrix + codebook (in Rust).
	 */
	static create(config: TurboQuantKvCacheConfig): TurboQuantKvCache {
		if (!VALID_BITS.includes(config.bits)) {
			throw new Error(`Invalid bit width: ${String(config.bits)}. Must be one of: ${VALID_BITS.join(", ")}`);
		}
		if (config.headDim < 2) {
			throw new Error(`headDim must be >= 2, got ${String(config.headDim)}`);
		}
		if (config.numHeads < 1) {
			throw new Error(`numHeads must be >= 1, got ${String(config.numHeads)}`);
		}

		const rawWindow = config.residualWindowSize;
		if (rawWindow !== undefined) {
			if (!Number.isFinite(rawWindow) || rawWindow < 0 || !Number.isInteger(rawWindow)) {
				throw new Error(
					`residualWindowSize must be a non-negative integer, got ${String(rawWindow)}`,
				);
			}
		}

		const resolved: Required<TurboQuantKvCacheConfig> = {
			bits: config.bits,
			headDim: config.headDim,
			numHeads: config.numHeads,
			residualWindowSize: rawWindow ?? 128,
			seed: config.seed ?? 42,
		};

		return new TurboQuantKvCache(resolved);
	}

	/** Current configuration (read-only). */
	get config(): Readonly<Required<TurboQuantKvCacheConfig>> {
		return this._config;
	}

	/** Number of centroids (2^bits). */
	get numCentroids(): number {
		return this._numCentroids;
	}

	/** Current sequence length. */
	get sequenceLength(): number {
		return turboquantCacheSeqLen(this._cacheHandle);
	}

	/** Codebook centroids (copy from native). */
	get codebook(): Float32Array {
		const buf = turboquantCacheCodebook(this._cacheHandle);
		const bytes = new Uint8Array(buf);
		return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
	}

	/** Native cache handle (for advanced usage / KvCacheManager). */
	get nativeHandle(): ReturnType<typeof turboquantCreateCache> {
		return this._cacheHandle;
	}

	/**
	 * Compress a single KV vector (delegates to native Rust).
	 */
	compressVector(vector: Float32Array): CompressedKvEntry {
		if (vector.length !== this._config.headDim) {
			throw new Error(`Vector length ${String(vector.length)} != headDim ${String(this._config.headDim)}`);
		}
		const result = turboquantCompress(f32ToBuffer(vector), this._nativeConfig);
		return fromNativeEntry(result);
	}

	/**
	 * Decompress a single KV vector (delegates to native Rust).
	 */
	decompressVector(entry: CompressedKvEntry): Float32Array {
		const result = turboquantDecompress(toNativeEntry(entry), this._nativeConfig);
		const bytes = new Uint8Array(result);
		return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
	}

	/**
	 * Determine whether a token at the given position should be compressed.
	 */
	shouldCompress(tokenPosition: number, currentSeqLen: number): boolean {
		return turboquantShouldCompress(this._cacheHandle, tokenPosition, currentSeqLen);
	}

	/**
	 * Store a compressed KV entry for a specific layer/head.
	 * The residual window is managed in native Rust.
	 */
	storeCompressed(
		layerIdx: number,
		headIdx: number,
		key: Float32Array,
		value: Float32Array,
	): { readonly key: CompressedKvEntry; readonly value: CompressedKvEntry } {
		if (headIdx < 0 || headIdx >= this._config.numHeads) {
			throw new Error(
				`headIdx ${String(headIdx)} out of range [0, ${String(this._config.numHeads)})`,
			);
		}

		// Insert into native cache (handles residual window + compression)
		turboquantCacheInsert(this._cacheHandle, layerIdx, headIdx, f32ToBuffer(key), f32ToBuffer(value));

		// Also return the compressed versions for callers that need them
		const compKey = this.compressVector(key);
		const compValue = this.compressVector(value);
		return { key: compKey, value: compValue };
	}

	/** Advance the sequence position counter. */
	advanceSequence(count = 1): void {
		if (!Number.isFinite(count) || count < 0) {
			throw new Error(`advanceSequence count must be a non-negative finite number, got ${String(count)}`);
		}
		turboquantCacheAdvance(this._cacheHandle, count);
	}

	/** Reset the cache (e.g., on new generation). */
	reset(): void {
		turboquantCacheReset(this._cacheHandle);
	}

	/**
	 * Get cache statistics.
	 */
	getStats(): CacheStatsJs {
		return turboquantCacheStats(this._cacheHandle);
	}

	/**
	 * Reconstruct a full float32 tensor for a layer.
	 */
	reconstructLayer(layerIdx: number): ReconstructedLayerJs | null {
		const result = turboquantCacheReconstruct(this._cacheHandle, layerIdx);
		return result ?? null;
	}

	/**
	 * Compute memory usage statistics.
	 */
	static computeMemoryStats(
		headDim: number,
		bits: BitWidth,
		numHeads: number,
		numLayers: number,
		compressedTokens: number,
		residualTokens: number,
	): MemoryStatsJs {
		return turboquantComputeMemoryStats(
			headDim,
			bits,
			numHeads,
			numLayers,
			compressedTokens,
			residualTokens,
		);
	}
}

// ---------------------------------------------------------------------------
// Config parsing helper
// ---------------------------------------------------------------------------

/**
 * Parse `memory.kv_cache_compression` from the user's agent.yaml config.
 * Returns defaults if absent or malformed.
 */
export function parseKvCacheCompressionConfig(raw: unknown): KvCacheCompressionOption {
	if (raw === undefined || raw === null) return DEFAULT_KV_CACHE_COMPRESSION;

	if (typeof raw === "boolean") {
		return { ...DEFAULT_KV_CACHE_COMPRESSION, enabled: raw };
	}

	if (typeof raw !== "object") return DEFAULT_KV_CACHE_COMPRESSION;

	const obj = raw as Record<string, unknown>;
	const enabled = typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_KV_CACHE_COMPRESSION.enabled;

	let bits = DEFAULT_KV_CACHE_COMPRESSION.bits;
	if (typeof obj.bits === "number" && VALID_BITS.includes(obj.bits as BitWidth)) {
		bits = obj.bits as BitWidth;
	}

	let residualWindowSize = DEFAULT_KV_CACHE_COMPRESSION.residualWindowSize;
	if (
		typeof obj.residualWindowSize === "number" &&
		Number.isFinite(obj.residualWindowSize) &&
		obj.residualWindowSize > 0
	) {
		residualWindowSize = Math.round(obj.residualWindowSize);
	}

	return { enabled, bits, residualWindowSize };
}

// ---------------------------------------------------------------------------
// Ollama guidance
// ---------------------------------------------------------------------------

/**
 * Guidance for Ollama KV cache quantization.
 */
export const OLLAMA_KV_CACHE_GUIDANCE = {
	envVar: "OLLAMA_KV_CACHE_TYPE",
	recommendedValue: "q4_0",
	description:
		"Set OLLAMA_KV_CACHE_TYPE=q4_0 before starting Ollama to enable " +
		"4-bit KV cache quantization via llama.cpp. This is complementary " +
		"to TurboQuant and applies to all Ollama-served models (e.g. qwen3:4b). " +
		"Expected ~4x memory reduction for KV cache with minimal quality loss.",
	alternativeValues: ["q8_0", "f16"] as const,
} as const;
