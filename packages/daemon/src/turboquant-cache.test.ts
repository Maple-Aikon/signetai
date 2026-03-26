import { describe, expect, it } from "bun:test";
import {
	DEFAULT_KV_CACHE_COMPRESSION,
	OLLAMA_KV_CACHE_GUIDANCE,
	TurboQuantKvCache,
	parseKvCacheCompressionConfig,
} from "./turboquant-cache";
import type { CompressedKvEntry, KvCacheCompressionOption, TurboQuantKvCacheConfig } from "./turboquant-cache";

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
		// Symmetric Beta → symmetric codebook
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
			// 4-bit should have > 0.99 cosine similarity for dim=64
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
			// 3-bit should still be quite good
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

	it("indices are valid (< numCentroids)", () => {
		const cache = TurboQuantKvCache.create({
			bits: 3,
			headDim: DIM,
			numHeads: 1,
		});
		const vec = randomVector(DIM, 7);
		const compressed = cache.compressVector(vec);
		for (const idx of compressed.indices) {
			expect(idx).toBeLessThan(cache.numCentroids);
		}
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

		// Each increase in bits should reduce MSE
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
		expect(Array.from(r1.indices)).toEqual(Array.from(r2.indices));
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

		// Norms should match (same vector), but indices should differ
		expect(r1.norm).toBeCloseTo(r2.norm, 5);
		// Indices won't be identical with different rotation matrices
		let anyDifferent = false;
		for (let i = 0; i < r1.indices.length; i++) {
			if (r1.indices[i] !== r2.indices[i]) {
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

		// SeqLen = 100, window = 32 → tokens 0-67 compressed, 68-99 not
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
// Store / retrieve compressed entries
// ---------------------------------------------------------------------------

describe("storeCompressed / getCompressedLayer", () => {
	it("stores and retrieves compressed KV pairs", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: 32,
			numHeads: 2,
		});

		const k = randomVector(32, 1);
		const v = randomVector(32, 2);

		const result = cache.storeCompressed(0, 0, k, v);
		expect(result.key.indices.length).toBe(32);
		expect(result.value.indices.length).toBe(32);

		const layer = cache.getCompressedLayer(0, 0);
		expect(layer).toBeDefined();
		expect(layer?.keys.length).toBe(1);
		expect(layer?.values.length).toBe(1);
	});

	it("accumulates entries across calls", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: 32,
			numHeads: 1,
		});

		for (let i = 0; i < 5; i++) {
			cache.storeCompressed(0, 0, randomVector(32, i), randomVector(32, i + 100));
		}

		const layer = cache.getCompressedLayer(0, 0);
		expect(layer?.keys.length).toBe(5);
		expect(layer?.values.length).toBe(5);
	});

	it("separates layers and heads", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: 32,
			numHeads: 4,
		});

		cache.storeCompressed(0, 0, randomVector(32, 1), randomVector(32, 2));
		cache.storeCompressed(0, 1, randomVector(32, 3), randomVector(32, 4));
		cache.storeCompressed(1, 0, randomVector(32, 5), randomVector(32, 6));

		expect(cache.getCompressedLayer(0, 0)?.keys.length).toBe(1);
		expect(cache.getCompressedLayer(0, 1)?.keys.length).toBe(1);
		expect(cache.getCompressedLayer(1, 0)?.keys.length).toBe(1);
		expect(cache.getCompressedLayer(1, 1)).toBeUndefined();
	});

	it("returns undefined for missing layer/head", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: 32,
			numHeads: 1,
		});
		expect(cache.getCompressedLayer(99, 0)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Sequence tracking and reset
// ---------------------------------------------------------------------------

describe("sequence tracking", () => {
	it("tracks sequence length", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: 32,
			numHeads: 1,
		});
		expect(cache.sequenceLength).toBe(0);
		cache.advanceSequence(10);
		expect(cache.sequenceLength).toBe(10);
		cache.advanceSequence();
		expect(cache.sequenceLength).toBe(11);
	});

	it("reset clears everything", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: 32,
			numHeads: 1,
		});
		cache.storeCompressed(0, 0, randomVector(32, 1), randomVector(32, 2));
		cache.advanceSequence(50);

		cache.reset();
		expect(cache.sequenceLength).toBe(0);
		expect(cache.getCompressedLayer(0, 0)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Memory statistics
// ---------------------------------------------------------------------------

describe("computeMemoryStats", () => {
	it("computes reasonable compression ratio", () => {
		const stats = TurboQuantKvCache.computeMemoryStats(
			128, // headDim
			4, // bits
			32, // numHeads
			24, // numLayers
			896, // compressedTokens (1024 - 128)
			128, // residualTokens
		);

		expect(stats.compressedBytes).toBeGreaterThan(0);
		expect(stats.residualBytes).toBeGreaterThan(0);
		expect(stats.totalBytes).toBe(stats.compressedBytes + stats.residualBytes);
		expect(stats.compressionRatio).toBeGreaterThan(1);
		expect(stats.uncompressedBytes).toBeGreaterThan(stats.totalBytes);
	});

	it("compression ratio increases with more compressed tokens", () => {
		const stats1 = TurboQuantKvCache.computeMemoryStats(128, 4, 32, 24, 100, 128);
		const stats2 = TurboQuantKvCache.computeMemoryStats(128, 4, 32, 24, 1000, 128);
		expect(stats2.compressionRatio).toBeGreaterThan(stats1.compressionRatio);
	});

	it("lower bits → higher compression ratio", () => {
		const stats3 = TurboQuantKvCache.computeMemoryStats(128, 3, 32, 24, 896, 128);
		const stats4 = TurboQuantKvCache.computeMemoryStats(128, 4, 32, 24, 896, 128);
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

	it("falls back for invalid residualWindowSize", () => {
		const result = parseKvCacheCompressionConfig({
			enabled: true,
			residualWindowSize: -10,
		});
		expect(result.residualWindowSize).toBe(DEFAULT_KV_CACHE_COMPRESSION.residualWindowSize);
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
		// At dim=128, 4-bit should be very accurate
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
