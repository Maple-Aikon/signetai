/**
 * Tests for TurboQuant KV Cache Compression (native Rust backend).
 *
 * Validates the native Rust implementation through the thin TS wrapper,
 * ensuring identical behavior to the original pure-TS implementation.
 */

import { describe, expect, it } from "bun:test";
import {
	DEFAULT_KV_CACHE_COMPRESSION,
	OLLAMA_KV_CACHE_GUIDANCE,
	TurboQuantKvCache,
	parseKvCacheCompressionConfig,
} from "./turboquant-cache";
import type { CompressedKvEntry, KvCacheCompressionOption, TurboQuantKvCacheConfig } from "./turboquant-cache";

// Also test direct native function imports
import {
	turboquantCompress,
	turboquantDecompress,
	turboquantCreateCache,
	turboquantCacheInsert,
	turboquantCacheAdvance,
	turboquantCacheReset,
	turboquantCacheSeqLen,
	turboquantCacheStats,
	turboquantCacheReconstruct,
	turboquantComputeMemoryStats,
	turboquantShouldCompress,
} from "@signet/native";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random Float32Array of given length with seeded values. */
function randomVector(length: number, seed = 1): Float32Array {
	const vec = new Float32Array(length);
	let state = seed;
	for (let i = 0; i < length; i++) {
		// LCG for deterministic pseudo-random
		state = (state * 1664525 + 1013904223) >>> 0;
		vec[i] = (state / 4294967296) * 2 - 1; // [-1, 1]
	}
	return vec;
}

/** Compute L2 norm of a vector. */
function l2Norm(v: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
	return Math.sqrt(sum);
}

/** Compute cosine similarity between two vectors. */
function cosineSim(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom > 0 ? dot / denom : 0;
}

/** Compute MSE between two vectors. */
function mse(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) {
		const diff = a[i] - b[i];
		sum += diff * diff;
	}
	return sum / a.length;
}

/** Convert Float32Array to Buffer for native calls. */
function f32ToBuffer(arr: Float32Array): Buffer {
	return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

// ---------------------------------------------------------------------------
// TurboQuantKvCache creation
// ---------------------------------------------------------------------------

describe("TurboQuantKvCache.create", () => {
	it("creates with valid config", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: 64,
			numHeads: 8,
		});
		expect(cache.config.bits).toBe(4);
		expect(cache.config.headDim).toBe(64);
		expect(cache.config.numHeads).toBe(8);
		expect(cache.config.residualWindowSize).toBe(128);
		expect(cache.config.seed).toBe(42);
	});

	it("accepts custom residualWindowSize and seed", () => {
		const cache = TurboQuantKvCache.create({
			bits: 3,
			headDim: 128,
			numHeads: 32,
			residualWindowSize: 256,
			seed: 99,
		});
		expect(cache.config.residualWindowSize).toBe(256);
		expect(cache.config.seed).toBe(99);
	});

	it("rejects invalid bit width", () => {
		expect(() =>
			TurboQuantKvCache.create({
				bits: 5 as 4,
				headDim: 64,
				numHeads: 8,
			}),
		).toThrow(/Invalid bit width/);
	});

	it("rejects headDim < 2", () => {
		expect(() => TurboQuantKvCache.create({ bits: 4, headDim: 1, numHeads: 8 })).toThrow(/headDim must be >= 2/);
	});

	it("rejects numHeads < 1", () => {
		expect(() => TurboQuantKvCache.create({ bits: 4, headDim: 64, numHeads: 0 })).toThrow(/numHeads must be >= 1/);
	});

	it("numCentroids matches 2^bits", () => {
		for (const bits of [1, 2, 3, 4] as const) {
			const cache = TurboQuantKvCache.create({
				bits,
				headDim: 32,
				numHeads: 1,
			});
			expect(cache.numCentroids).toBe(2 ** bits);
		}
	});
});

// ---------------------------------------------------------------------------
// Codebook properties
// ---------------------------------------------------------------------------

describe("codebook", () => {
	it("has correct number of centroids", () => {
		for (const bits of [1, 2, 3, 4] as const) {
			const cache = TurboQuantKvCache.create({
				bits,
				headDim: 64,
				numHeads: 1,
			});
			expect(cache.codebook.length).toBe(2 ** bits);
		}
	});

	it("centroids are sorted ascending", () => {
		for (const bits of [1, 2, 3, 4] as const) {
			const cache = TurboQuantKvCache.create({
				bits,
				headDim: 64,
				numHeads: 1,
			});
			const cb = cache.codebook;
			for (let i = 1; i < cb.length; i++) {
				expect(cb[i]).toBeGreaterThan(cb[i - 1]);
			}
		}
	});

	it("centroids are symmetric around zero for even centroids", () => {
		const cache = TurboQuantKvCache.create({
			bits: 2,
			headDim: 64,
			numHeads: 1,
		});
		const cb = cache.codebook;
		for (let i = 0; i < cb.length; i++) {
			expect(cb[i] + cb[cb.length - 1 - i]).toBeCloseTo(0, 4);
		}
	});

	it("all centroids are within [-1, 1]", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: 128,
			numHeads: 1,
		});
		for (const c of cache.codebook) {
			expect(c).toBeGreaterThanOrEqual(-1);
			expect(c).toBeLessThanOrEqual(1);
		}
	});
});

// ---------------------------------------------------------------------------
// Compress / decompress roundtrip
// ---------------------------------------------------------------------------

describe("compress/decompress roundtrip", () => {
	const DIM = 64;

	it("preserves vector direction (high cosine similarity) at 4-bit", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: DIM,
			numHeads: 1,
		});

		for (let seed = 1; seed <= 10; seed++) {
			const vec = randomVector(DIM, seed);
			const compressed = cache.compressVector(vec);
			const restored = cache.decompressVector(compressed);
			const sim = cosineSim(vec, restored);
			expect(sim).toBeGreaterThan(0.95);
		}
	});

	it("preserves vector direction at 3-bit", () => {
		const cache = TurboQuantKvCache.create({
			bits: 3,
			headDim: DIM,
			numHeads: 1,
		});

		for (let seed = 1; seed <= 10; seed++) {
			const vec = randomVector(DIM, seed);
			const compressed = cache.compressVector(vec);
			const restored = cache.decompressVector(compressed);
			const sim = cosineSim(vec, restored);
			expect(sim).toBeGreaterThan(0.9);
		}
	});

	it("preserves norm", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: DIM,
			numHeads: 1,
		});
		const vec = randomVector(DIM, 42);
		const compressed = cache.compressVector(vec);
		expect(compressed.norm).toBeCloseTo(l2Norm(vec), 5);
	});

	it("packedCodes has correct byte length for 4-bit", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: DIM,
			numHeads: 1,
		});
		const vec = randomVector(DIM, 7);
		const compressed = cache.compressVector(vec);
		expect(compressed.packedCodes.length).toBe(Math.ceil((DIM * 4) / 8));
		expect(compressed.dim).toBe(DIM);
		expect(compressed.bits).toBe(4);
	});

	it("higher bits → lower MSE", () => {
		const vec = randomVector(DIM, 99);
		const mseByBits: number[] = [];

		for (const bits of [1, 2, 3, 4] as const) {
			const cache = TurboQuantKvCache.create({
				bits,
				headDim: DIM,
				numHeads: 1,
			});
			const compressed = cache.compressVector(vec);
			const restored = cache.decompressVector(compressed);
			mseByBits.push(mse(vec, restored));
		}

		for (let i = 1; i < mseByBits.length; i++) {
			expect(mseByBits[i]).toBeLessThan(mseByBits[i - 1]);
		}
	});

	it("handles zero vector gracefully", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: DIM,
			numHeads: 1,
		});
		const zero = new Float32Array(DIM);
		const compressed = cache.compressVector(zero);
		expect(compressed.norm).toBeCloseTo(0);
		const restored = cache.decompressVector(compressed);
		for (const v of restored) {
			expect(Math.abs(v)).toBeLessThan(1e-6);
		}
	});

	it("rejects wrong-length vector", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: DIM,
			numHeads: 1,
		});
		expect(() => cache.compressVector(new Float32Array(DIM + 1))).toThrow(/Vector length/);
	});
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
	it("same seed produces identical compression", () => {
		const config: TurboQuantKvCacheConfig = {
			bits: 4,
			headDim: 64,
			numHeads: 1,
			seed: 123,
		};
		const c1 = TurboQuantKvCache.create(config);
		const c2 = TurboQuantKvCache.create(config);

		const vec = randomVector(64, 7);
		const r1 = c1.compressVector(vec);
		const r2 = c2.compressVector(vec);

		expect(r1.norm).toBe(r2.norm);
		expect(Array.from(r1.packedCodes)).toEqual(Array.from(r2.packedCodes));
	});

	it("different seeds produce different compression", () => {
		const vec = randomVector(64, 7);
		const c1 = TurboQuantKvCache.create({
			bits: 4,
			headDim: 64,
			numHeads: 1,
			seed: 1,
		});
		const c2 = TurboQuantKvCache.create({
			bits: 4,
			headDim: 64,
			numHeads: 1,
			seed: 999,
		});

		const r1 = c1.compressVector(vec);
		const r2 = c2.compressVector(vec);

		expect(r1.norm).toBeCloseTo(r2.norm, 5);
		let anyDifferent = false;
		for (let i = 0; i < r1.packedCodes.length; i++) {
			if (r1.packedCodes[i] !== r2.packedCodes[i]) {
				anyDifferent = true;
				break;
			}
		}
		expect(anyDifferent).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Residual window
// ---------------------------------------------------------------------------

describe("shouldCompress", () => {
	it("does not compress tokens within residual window", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: 64,
			numHeads: 1,
			residualWindowSize: 32,
		});

		expect(cache.shouldCompress(0, 100)).toBe(true);
		expect(cache.shouldCompress(67, 100)).toBe(true);
		expect(cache.shouldCompress(68, 100)).toBe(false);
		expect(cache.shouldCompress(99, 100)).toBe(false);
	});

	it("nothing compressed when seqLen <= windowSize", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: 64,
			numHeads: 1,
			residualWindowSize: 128,
		});

		for (let pos = 0; pos < 128; pos++) {
			expect(cache.shouldCompress(pos, 128)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// Native cache insert / get
// ---------------------------------------------------------------------------

describe("native cache insert and get", () => {
	it("inserts and retrieves via native cache", () => {
		const handle = turboquantCreateCache({
			bits: 4,
			headDim: 32,
			numHeads: 2,
			residualWindowSize: 128,
			seed: 42,
		});

		const k = randomVector(32, 1);
		const v = randomVector(32, 2);

		turboquantCacheInsert(handle, 0, 0, f32ToBuffer(k), f32ToBuffer(v));
		turboquantCacheAdvance(handle, 1);

		const seqLen = turboquantCacheSeqLen(handle);
		expect(seqLen).toBe(1);

		const stats = turboquantCacheStats(handle);
		expect(stats.numLayers).toBe(1);
	});

	it("compresses when residual window is exceeded", () => {
		const windowSize = 4;
		const handle = turboquantCreateCache({
			bits: 4,
			headDim: 32,
			numHeads: 1,
			residualWindowSize: windowSize,
			seed: 42,
		});

		// Fill up and exceed the window
		for (let i = 0; i < windowSize + 3; i++) {
			const k = randomVector(32, i + 1);
			const v = randomVector(32, i + 100);
			turboquantCacheInsert(handle, 0, 0, f32ToBuffer(k), f32ToBuffer(v));
		}

		const stats = turboquantCacheStats(handle);
		expect(stats.compressedTokensPerLayer).toBe(3);
		expect(stats.residualTokensPerLayer).toBe(windowSize);
	});

	it("reconstructs layer correctly", () => {
		const windowSize = 4;
		const headDim = 32;
		const numHeads = 2;
		const handle = turboquantCreateCache({
			bits: 4,
			headDim,
			numHeads,
			residualWindowSize: windowSize,
			seed: 42,
		});

		// Insert some tokens for both heads
		const totalTokens = 3;
		for (let t = 0; t < totalTokens; t++) {
			for (let h = 0; h < numHeads; h++) {
				const k = randomVector(headDim, t * numHeads + h + 1);
				const v = randomVector(headDim, t * numHeads + h + 100);
				turboquantCacheInsert(handle, 0, h, f32ToBuffer(k), f32ToBuffer(v));
			}
		}

		const result = turboquantCacheReconstruct(handle, 0);
		expect(result).not.toBeNull();
		expect(result!.numHeads).toBe(numHeads);
		expect(result!.seqLen).toBe(totalTokens);
		expect(result!.headDim).toBe(headDim);
	});

	it("reset clears everything", () => {
		const handle = turboquantCreateCache({
			bits: 4,
			headDim: 32,
			numHeads: 1,
			residualWindowSize: 128,
			seed: 42,
		});

		turboquantCacheInsert(handle, 0, 0, f32ToBuffer(randomVector(32, 1)), f32ToBuffer(randomVector(32, 2)));
		turboquantCacheAdvance(handle, 50);

		turboquantCacheReset(handle);

		expect(turboquantCacheSeqLen(handle)).toBe(0);
		expect(turboquantCacheReconstruct(handle, 0)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Memory statistics
// ---------------------------------------------------------------------------

describe("turboquantComputeMemoryStats", () => {
	it("computes reasonable compression ratio", () => {
		const stats = turboquantComputeMemoryStats(128, 4, 32, 24, 896, 128);

		expect(stats.compressedBytes).toBeGreaterThan(0);
		expect(stats.residualBytes).toBeGreaterThan(0);
		expect(stats.totalBytes).toBe(stats.compressedBytes + stats.residualBytes);
		expect(stats.compressionRatio).toBeGreaterThan(1);
		expect(stats.uncompressedBytes).toBeGreaterThan(stats.totalBytes);
	});

	it("compression ratio increases with more compressed tokens", () => {
		const stats1 = turboquantComputeMemoryStats(128, 4, 32, 24, 100, 128);
		const stats2 = turboquantComputeMemoryStats(128, 4, 32, 24, 1000, 128);
		expect(stats2.compressionRatio).toBeGreaterThan(stats1.compressionRatio);
	});

	it("lower bits → higher compression ratio", () => {
		const stats3 = turboquantComputeMemoryStats(128, 3, 32, 24, 896, 128);
		const stats4 = turboquantComputeMemoryStats(128, 4, 32, 24, 896, 128);
		expect(stats3.compressionRatio).toBeGreaterThan(stats4.compressionRatio);
	});
});

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

describe("parseKvCacheCompressionConfig", () => {
	it("returns defaults for undefined/null", () => {
		expect(parseKvCacheCompressionConfig(undefined)).toEqual(DEFAULT_KV_CACHE_COMPRESSION);
		expect(parseKvCacheCompressionConfig(null)).toEqual(DEFAULT_KV_CACHE_COMPRESSION);
	});

	it("accepts boolean shorthand", () => {
		const enabled = parseKvCacheCompressionConfig(true);
		expect(enabled.enabled).toBe(true);
		expect(enabled.bits).toBe(DEFAULT_KV_CACHE_COMPRESSION.bits);

		const disabled = parseKvCacheCompressionConfig(false);
		expect(disabled.enabled).toBe(false);
	});

	it("parses full config object", () => {
		const result = parseKvCacheCompressionConfig({
			enabled: true,
			bits: 3,
			residualWindowSize: 256,
		});
		expect(result.enabled).toBe(true);
		expect(result.bits).toBe(3);
		expect(result.residualWindowSize).toBe(256);
	});

	it("falls back for invalid bits", () => {
		const result = parseKvCacheCompressionConfig({
			enabled: true,
			bits: 7,
		});
		expect(result.bits).toBe(DEFAULT_KV_CACHE_COMPRESSION.bits);
	});

	it("ignores non-object types", () => {
		expect(parseKvCacheCompressionConfig("yes")).toEqual(DEFAULT_KV_CACHE_COMPRESSION);
		expect(parseKvCacheCompressionConfig(42)).toEqual(DEFAULT_KV_CACHE_COMPRESSION);
	});
});

// ---------------------------------------------------------------------------
// Ollama guidance
// ---------------------------------------------------------------------------

describe("OLLAMA_KV_CACHE_GUIDANCE", () => {
	it("has expected structure", () => {
		expect(OLLAMA_KV_CACHE_GUIDANCE.envVar).toBe("OLLAMA_KV_CACHE_TYPE");
		expect(OLLAMA_KV_CACHE_GUIDANCE.recommendedValue).toBe("q4_0");
		expect(OLLAMA_KV_CACHE_GUIDANCE.alternativeValues).toContain("q8_0");
		expect(OLLAMA_KV_CACHE_GUIDANCE.alternativeValues).toContain("f16");
		expect(typeof OLLAMA_KV_CACHE_GUIDANCE.description).toBe("string");
	});
});

// ---------------------------------------------------------------------------
// Higher-dimension / batch quality tests
// ---------------------------------------------------------------------------

describe("quality at typical model dimensions", () => {
	it("dim=128 (typical head_dim) has excellent quality at 4-bit", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: 128,
			numHeads: 1,
		});

		let totalMse = 0;
		const trials = 50;
		for (let i = 0; i < trials; i++) {
			const vec = randomVector(128, i + 1000);
			const compressed = cache.compressVector(vec);
			const restored = cache.decompressVector(compressed);
			totalMse += mse(vec, restored);
		}
		const avgMse = totalMse / trials;
		expect(avgMse).toBeLessThan(0.01);
	});

	it("dim=128, 3-bit still has good quality", () => {
		const cache = TurboQuantKvCache.create({
			bits: 3,
			headDim: 128,
			numHeads: 1,
		});

		let totalSim = 0;
		const trials = 50;
		for (let i = 0; i < trials; i++) {
			const vec = randomVector(128, i + 2000);
			const compressed = cache.compressVector(vec);
			const restored = cache.decompressVector(compressed);
			totalSim += cosineSim(vec, restored);
		}
		const avgSim = totalSim / trials;
		expect(avgSim).toBeGreaterThan(0.95);
	});
});

// ---------------------------------------------------------------------------
// Direct native function tests
// ---------------------------------------------------------------------------

describe("direct native function calls", () => {
	it("turboquantCompress / turboquantDecompress roundtrip", () => {
		const vec = randomVector(64, 42);
		const config = { bits: 4, headDim: 64, numHeads: 1, residualWindowSize: 128, seed: 42 };

		const compressed = turboquantCompress(f32ToBuffer(vec), config);
		expect(compressed.dim).toBe(64);
		expect(compressed.bits).toBe(4);

		const decompressed = turboquantDecompress(compressed, config);
		const restored = new Float32Array(
			new Uint8Array(decompressed).buffer,
			0,
			64,
		);
		const sim = cosineSim(vec, restored);
		expect(sim).toBeGreaterThan(0.95);
	});

	it("turboquantShouldCompress matches expected behavior", () => {
		const handle = turboquantCreateCache({
			bits: 4,
			headDim: 64,
			numHeads: 1,
			residualWindowSize: 32,
			seed: 42,
		});

		expect(turboquantShouldCompress(handle, 0, 100)).toBe(true);
		expect(turboquantShouldCompress(handle, 68, 100)).toBe(false);
		expect(turboquantShouldCompress(handle, 99, 100)).toBe(false);
	});
});
