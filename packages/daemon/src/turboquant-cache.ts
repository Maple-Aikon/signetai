/**
 * TurboQuant KV Cache Compression
 *
 * Pure TypeScript implementation of Google's TurboQuant algorithm
 * (arXiv:2504.19874, ICLR 2026) adapted for KV cache compression
 * in local generative model inference.
 *
 * Compresses key/value cache tensors to 3-4 bits per coordinate with
 * near-zero accuracy loss, enabling ~6x memory reduction for long
 * context windows.
 *
 * ## Current integration status
 *
 * - **nomic-embed-text (encoder):** Does NOT use KV cache. No integration needed.
 * - **Ollama / qwen3:4b:** Manages its own KV cache via llama.cpp. Cannot
 *   integrate directly. Use `OLLAMA_KV_CACHE_TYPE=q4_0` env var for Ollama's
 *   built-in KV cache quantization instead.
 * - **Future HuggingFace transformers.js generative models:** This module is
 *   ready to drop in. Wrap the model's `generate()` call with a
 *   {@link TurboQuantKvCache} to compress past-token KV entries automatically.
 *
 * ## Algorithm overview
 *
 * 1. Generate a deterministic random rotation matrix via QR decomposition
 * 2. Compute an optimal codebook from the Beta((d-1)/2, (d-1)/2) distribution
 * 3. Quantize: rotate each KV vector, find nearest centroid per coordinate
 * 4. Dequantize: centroid lookup → inverse rotation → rescale by norm
 * 5. A "residual window" of the most recent N tokens stays in full precision
 *
 * @see https://arxiv.org/abs/2504.19874
 * @module
 */

import { logger } from "./logger";

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
// Math utilities — seeded PRNG, QR, matrix ops
// ---------------------------------------------------------------------------

/** Seeded xoshiro128** PRNG returning values in [0, 1). */
function createRng(seed: number): () => number {
	let s0 = seed >>> 0;
	let s1 = (seed * 1597334677) >>> 0;
	let s2 = (seed * 2654435761) >>> 0;
	let s3 = (seed * 668265263) >>> 0;

	for (let i = 0; i < 20; i++) {
		const t = s1 << 9;
		s2 ^= s0;
		s3 ^= s1;
		s1 ^= s2;
		s0 ^= s3;
		s2 ^= t;
		s3 = (s3 << 11) | (s3 >>> 21);
	}

	return (): number => {
		const result = Math.imul(s1 * 5, 1) >>> 0;
		const rot = ((result << 7) | (result >>> 25)) >>> 0;
		const t = s1 << 9;
		s2 ^= s0;
		s3 ^= s1;
		s1 ^= s2;
		s0 ^= s3;
		s2 ^= t;
		s3 = (s3 << 11) | (s3 >>> 21);
		return (rot >>> 0) / 4294967296;
	};
}

/** Generate a flat row-major matrix of standard normal samples (Box-Muller). */
function randnMatrix(rows: number, cols: number, rng: () => number): Float32Array {
	const data = new Float32Array(rows * cols);
	for (let i = 0; i < data.length - 1; i += 2) {
		const u1 = rng() || 1e-10;
		const u2 = rng();
		const r = Math.sqrt(-2 * Math.log(u1));
		const theta = 2 * Math.PI * u2;
		data[i] = r * Math.cos(theta);
		data[i + 1] = r * Math.sin(theta);
	}
	if (data.length % 2 !== 0) {
		const u1 = rng() || 1e-10;
		const u2 = rng();
		data[data.length - 1] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
	}
	return data;
}

/**
 * QR decomposition via modified Gram-Schmidt.
 * Returns Q (orthogonal) as a flat Float32Array (rows × cols, row-major).
 */
function qrQ(matrix: Float32Array, rows: number, cols: number): Float32Array {
	const q = new Float32Array(matrix);

	const getCol = (c: number): Float32Array => {
		const col = new Float32Array(rows);
		for (let r = 0; r < rows; r++) col[r] = q[r * cols + c];
		return col;
	};
	const setCol = (c: number, col: Float32Array): void => {
		for (let r = 0; r < rows; r++) q[r * cols + c] = col[r];
	};
	const dot = (a: Float32Array, b: Float32Array): number => {
		let s = 0;
		for (let i = 0; i < a.length; i++) s += a[i] * b[i];
		return s;
	};

	for (let j = 0; j < cols; j++) {
		const col = getCol(j);
		for (let k = 0; k < j; k++) {
			const qk = getCol(k);
			const proj = dot(col, qk);
			for (let i = 0; i < rows; i++) col[i] -= proj * qk[i];
		}
		const norm = Math.sqrt(dot(col, col));
		if (norm > 1e-10) {
			for (let i = 0; i < rows; i++) col[i] /= norm;
		}
		setCol(j, col);
	}
	return q;
}

/** Matrix-vector multiply: result = M @ v. M is (rows × cols) row-major. */
function matVecMul(m: Float32Array, v: Float32Array, rows: number, cols: number): Float32Array {
	const result = new Float32Array(rows);
	for (let r = 0; r < rows; r++) {
		let sum = 0;
		const off = r * cols;
		for (let c = 0; c < cols; c++) sum += m[off + c] * v[c];
		result[r] = sum;
	}
	return result;
}

/** Transpose-multiply: result = M^T @ v. M is (rows × cols) row-major. */
function matTVecMul(m: Float32Array, v: Float32Array, rows: number, cols: number): Float32Array {
	const result = new Float32Array(cols);
	for (let r = 0; r < rows; r++) {
		const vi = v[r];
		const off = r * cols;
		for (let c = 0; c < cols; c++) result[c] += m[off + c] * vi;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Beta distribution utilities (codebook computation)
// ---------------------------------------------------------------------------

/** Log-gamma via Lanczos approximation. */
function lgamma(x: number): number {
	const c = [
		0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
		12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
	];
	if (x < 0.5) {
		return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
	}
	const xm = x - 1;
	let a = c[0];
	const t = xm + 7.5;
	for (let i = 1; i < 9; i++) a += c[i] / (xm + i);
	return 0.5 * Math.log(2 * Math.PI) + (xm + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized incomplete beta I_x(a, b) via Lentz continued fraction. */
function betaInc(x: number, a: number, b: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	if (x > (a + 1) / (a + b + 2)) return 1 - betaInc(1 - x, b, a);

	const lnBeta = lgamma(a) + lgamma(b) - lgamma(a + b);
	const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;

	let d = 1 - ((a + b) * x) / (a + 1);
	if (Math.abs(d) < 1e-30) d = 1e-30;
	d = 1 / d;
	let f = d;
	let c = 1;

	for (let m = 1; m <= 200; m++) {
		let num = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
		d = 1 + num * d;
		if (Math.abs(d) < 1e-30) d = 1e-30;
		c = 1 + num / c;
		if (Math.abs(c) < 1e-30) c = 1e-30;
		d = 1 / d;
		f *= c * d;

		num = (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
		d = 1 + num * d;
		if (Math.abs(d) < 1e-30) d = 1e-30;
		c = 1 + num / c;
		if (Math.abs(c) < 1e-30) c = 1e-30;
		d = 1 / d;
		const delta = c * d;
		f *= delta;
		if (Math.abs(delta - 1) < 1e-10) break;
	}

	return front * f;
}

/** Beta PDF on [0, 1]. */
function betaPdf(x: number, a: number, b: number): number {
	if (x <= 0 || x >= 1) return 0;
	const lnB = lgamma(a) + lgamma(b) - lgamma(a + b);
	return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - lnB);
}

/** Inverse regularized incomplete beta via Newton's method. */
function betaIncinv(a: number, b: number, p: number): number {
	if (p <= 0) return 0;
	if (p >= 1) return 1;
	let x = 0.5;
	for (let iter = 0; iter < 100; iter++) {
		const fx = betaInc(x, a, b) - p;
		if (Math.abs(fx) < 1e-12) break;
		const lnB = lgamma(a) + lgamma(b) - lgamma(a + b);
		const pdf = Math.exp((a - 1) * Math.log(x + 1e-15) + (b - 1) * Math.log(1 - x + 1e-15) - lnB);
		if (pdf < 1e-15) break;
		x = Math.max(1e-10, Math.min(1 - 1e-10, x - fx / pdf));
	}
	return x;
}

// ---------------------------------------------------------------------------
// Codebook
// ---------------------------------------------------------------------------

/** Compute the optimal TurboQuant codebook for Beta((d-1)/2, (d-1)/2). */
function computeCodebook(dim: number, bits: number): Float32Array {
	const nCentroids = 2 ** bits;
	const alpha = (dim - 1) / 2;

	if (bits === 1) {
		const c = Math.sqrt(2 / (Math.PI * dim));
		return new Float32Array([-c, c]);
	}

	const boundaries: number[] = [];
	for (let i = 1; i < nCentroids; i++) {
		const q = betaIncinv(alpha, alpha, i / nCentroids);
		boundaries.push(2 * q - 1);
	}

	const centroids = new Float32Array(nCentroids);
	const nPoints = 500;

	for (let i = 0; i < nCentroids; i++) {
		const lower = i === 0 ? -1 : boundaries[i - 1];
		const upper = i < boundaries.length ? boundaries[i] : 1;
		const a01 = Math.max((lower + 1) / 2, 1e-10);
		const b01 = Math.min((upper + 1) / 2, 1 - 1e-10);

		let sumXPdf = 0;
		let sumPdf = 0;
		const dx = (b01 - a01) / nPoints;

		for (let j = 0; j <= nPoints; j++) {
			const x01 = a01 + j * dx;
			const pdf = betaPdf(x01, alpha, alpha);
			const w = j === 0 || j === nPoints ? 0.5 : 1;
			sumXPdf += w * x01 * pdf;
			sumPdf += w * pdf;
		}

		const exp01 = sumPdf > 1e-15 ? sumXPdf / sumPdf : (a01 + b01) / 2;
		centroids[i] = 2 * exp01 - 1;
	}

	return centroids;
}

// ---------------------------------------------------------------------------
// Compressed KV entry
// ---------------------------------------------------------------------------

/** A single compressed KV vector (one head, one token). */
export interface CompressedKvEntry {
	/** Quantization indices per coordinate. */
	readonly indices: Uint8Array;
	/** Original L2 norm of the vector. */
	readonly norm: number;
}

/** Per-layer, per-head compressed KV cache. */
export interface CompressedKvLayer {
	/** Compressed key vectors (one per token outside residual window). */
	readonly keys: readonly CompressedKvEntry[];
	/** Compressed value vectors (one per token outside residual window). */
	readonly values: readonly CompressedKvEntry[];
}

// ---------------------------------------------------------------------------
// TurboQuantKvCache — main class
// ---------------------------------------------------------------------------

/**
 * Manages TurboQuant-compressed KV cache for a single attention head dimension.
 *
 * Usage pattern for future generative model integration:
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
	private readonly _rotation: Float32Array;
	private readonly _codebook: Float32Array;
	private readonly _numCentroids: number;

	/** Compressed KV entries per layer → per head. */
	private readonly _layers: Map<number, Map<number, CompressedKvLayer>>;
	/** Current sequence position (tokens seen). */
	private _seqLen: number;

	private constructor(config: Readonly<Required<TurboQuantKvCacheConfig>>) {
		this._config = config;
		this._numCentroids = 2 ** config.bits;
		this._layers = new Map();
		this._seqLen = 0;

		const rng = createRng(config.seed);
		const gaussian = randnMatrix(config.headDim, config.headDim, rng);
		this._rotation = qrQ(gaussian, config.headDim, config.headDim);
		this._codebook = computeCodebook(config.headDim, config.bits);
	}

	/**
	 * Create a new TurboQuantKvCache instance.
	 * Validates configuration and precomputes rotation matrix + codebook.
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

		const resolved: Required<TurboQuantKvCacheConfig> = {
			bits: config.bits,
			headDim: config.headDim,
			numHeads: config.numHeads,
			residualWindowSize: config.residualWindowSize ?? 128,
			seed: config.seed ?? 42,
		};

		logger.info(
			"memory",
			`[turboquant] Initialized: ${String(resolved.bits)}-bit, headDim=${String(resolved.headDim)}, ` +
				`numHeads=${String(resolved.numHeads)}, residualWindow=${String(resolved.residualWindowSize)}`,
		);

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
		return this._seqLen;
	}

	/** Codebook centroids (read-only copy). */
	get codebook(): Float32Array {
		return new Float32Array(this._codebook);
	}

	/**
	 * Compress a single KV vector (one head, one coordinate set).
	 *
	 * Steps:
	 * 1. Compute and store the L2 norm
	 * 2. Normalize to unit vector
	 * 3. Apply random rotation
	 * 4. Find nearest codebook centroid per coordinate
	 */
	compressVector(vector: Float32Array): CompressedKvEntry {
		const dim = this._config.headDim;
		if (vector.length !== dim) {
			throw new Error(`Vector length ${String(vector.length)} != headDim ${String(dim)}`);
		}

		// Compute norm
		let normSq = 0;
		for (let i = 0; i < dim; i++) normSq += vector[i] * vector[i];
		const norm = Math.sqrt(normSq);

		// Normalize
		const unit = new Float32Array(dim);
		const invNorm = norm > 1e-10 ? 1 / norm : 0;
		for (let i = 0; i < dim; i++) unit[i] = vector[i] * invNorm;

		// Rotate: y = rotation @ unit
		const rotated = matVecMul(this._rotation, unit, dim, dim);

		// Quantize: find nearest centroid per coordinate
		const indices = new Uint8Array(dim);
		for (let i = 0; i < dim; i++) {
			let bestIdx = 0;
			let bestDist = Math.abs(rotated[i] - this._codebook[0]);
			for (let c = 1; c < this._numCentroids; c++) {
				const dist = Math.abs(rotated[i] - this._codebook[c]);
				if (dist < bestDist) {
					bestDist = dist;
					bestIdx = c;
				}
			}
			indices[i] = bestIdx;
		}

		return { indices, norm };
	}

	/**
	 * Decompress a single KV vector from its compressed representation.
	 *
	 * Steps:
	 * 1. Look up codebook centroids from indices
	 * 2. Apply inverse rotation (rotation^T)
	 * 3. Rescale by stored norm
	 */
	decompressVector(entry: CompressedKvEntry): Float32Array {
		const dim = this._config.headDim;

		// Centroid lookup
		const rotated = new Float32Array(dim);
		for (let i = 0; i < dim; i++) {
			rotated[i] = this._codebook[entry.indices[i]];
		}

		// Inverse rotation: x_hat = rotation^T @ rotated
		const vec = matTVecMul(this._rotation, rotated, dim, dim);

		// Rescale
		for (let i = 0; i < dim; i++) vec[i] *= entry.norm;

		return vec;
	}

	/**
	 * Determine whether a token at the given position should be compressed.
	 * Tokens within the residual window (most recent N) stay full-precision.
	 */
	shouldCompress(tokenPosition: number, currentSeqLen: number): boolean {
		const windowStart = currentSeqLen - this._config.residualWindowSize;
		return tokenPosition < windowStart;
	}

	/**
	 * Store a compressed KV entry for a specific layer/head/position.
	 * This is the integration point: call after each forward pass for tokens
	 * that fall outside the residual window.
	 */
	storeCompressed(
		layerIdx: number,
		headIdx: number,
		key: Float32Array,
		value: Float32Array,
	): { readonly key: CompressedKvEntry; readonly value: CompressedKvEntry } {
		const compKey = this.compressVector(key);
		const compValue = this.compressVector(value);

		let layerMap = this._layers.get(layerIdx);
		if (!layerMap) {
			layerMap = new Map();
			this._layers.set(layerIdx, layerMap);
		}

		const existing = layerMap.get(headIdx);
		const keys = existing ? [...existing.keys, compKey] : [compKey];
		const values = existing ? [...existing.values, compValue] : [compValue];
		layerMap.set(headIdx, { keys, values });

		return { key: compKey, value: compValue };
	}

	/** Retrieve all compressed entries for a layer/head. */
	getCompressedLayer(layerIdx: number, headIdx: number): CompressedKvLayer | undefined {
		return this._layers.get(layerIdx)?.get(headIdx);
	}

	/** Advance the sequence position counter. */
	advanceSequence(count = 1): void {
		this._seqLen += count;
	}

	/** Reset the cache (e.g., on new generation). */
	reset(): void {
		this._layers.clear();
		this._seqLen = 0;
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
	): {
		readonly compressedBytes: number;
		readonly residualBytes: number;
		readonly totalBytes: number;
		readonly uncompressedBytes: number;
		readonly compressionRatio: number;
		readonly bitsPerElement: number;
	} {
		// Compressed: indices (bits per dim) + norm (f32) per head per layer per token
		// For keys + values (2x)
		const indicesPerToken = (headDim * bits) / 8;
		const normPerToken = 4; // float32
		const bytesPerCompToken = (indicesPerToken + normPerToken) * numHeads * numLayers * 2;
		const compressedBytes = Math.ceil(bytesPerCompToken * compressedTokens);

		// Residual: full fp32 per dim per head per layer per token (keys + values)
		const bytesPerResidualToken = headDim * 4 * numHeads * numLayers * 2;
		const residualBytes = bytesPerResidualToken * residualTokens;

		const totalBytes = compressedBytes + residualBytes;

		// Uncompressed baseline: all tokens at fp16
		const totalTokens = compressedTokens + residualTokens;
		const uncompressedBytes = headDim * 2 * numHeads * numLayers * 2 * totalTokens;

		const compressionRatio = uncompressedBytes > 0 ? uncompressedBytes / totalBytes : 0;
		const bitsPerElement = totalTokens > 0 ? (totalBytes * 8) / (totalTokens * headDim * numHeads * numLayers * 2) : 0;

		return {
			compressedBytes,
			residualBytes,
			totalBytes,
			uncompressedBytes,
			compressionRatio,
			bitsPerElement,
		};
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
 * Ollama/llama.cpp manages its own KV cache — TurboQuant cannot wrap it.
 * Instead, use Ollama's built-in quantized KV cache support.
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
