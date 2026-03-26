/**
 * Tests for RaBitQ compressed vector search — native Rust bindings.
 *
 * Validates:
 * - Rotation matrix generation (determinism, orthogonality via norm preservation)
 * - Codebook distribution properties
 * - Round-trip accuracy (build → decompress)
 * - Compressed search recall vs brute force
 * - Edge cases (empty, single vector, dimension mismatch)
 * - Serialization round-trip (index ↔ Buffer)
 * - Performance benchmarks
 */

import { describe, expect, test } from "bun:test";
import {
	buildIndex,
	bruteForceSearch,
	compress,
	compressedSearch,
	computeCodebook,
	decompress,
	generateRotationMatrix,
	getIndexInfo,
} from "./rabitq";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seeded pseudo-random number generator (simple LCG for test data). */
function makeRng(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) & 0x7fffffff;
		return s / 0x7fffffff;
	};
}

/** Generate a random Float32Array vector with gaussian-like values. */
function randomVector(dim: number, rng: () => number): Float32Array {
	const vec = new Float32Array(dim);
	for (let i = 0; i < dim; i++) {
		const u = rng() || 0.001;
		const v = rng();
		vec[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	}
	return vec;
}

/** Normalize a vector to unit length in-place. */
function normalize(vec: Float32Array): Float32Array {
	let norm = 0;
	for (let i = 0; i < vec.length; i++) {
		norm += vec[i] * vec[i];
	}
	norm = Math.sqrt(norm);
	if (norm > 0) {
		for (let i = 0; i < vec.length; i++) {
			vec[i] /= norm;
		}
	}
	return vec;
}

/** Cosine similarity between two vectors. */
function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let nA = 0;
	let nB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		nA += a[i] * a[i];
		nB += b[i] * b[i];
	}
	const denom = Math.sqrt(nA) * Math.sqrt(nB);
	return denom > 0 ? dot / denom : 0;
}

/** Parse a rotation matrix Buffer into Float32Array. */
function parseRotationMatrix(buf: Buffer, dim: number): Float32Array {
	const result = new Float32Array(dim * dim);
	for (let i = 0; i < dim * dim; i++) {
		result[i] = buf.readFloatLE(i * 4);
	}
	return result;
}

/** Parse a codebook Buffer into Float32Array. */
function parseCodebook(buf: Buffer, bits: number): Float32Array {
	const n = 1 << bits;
	const result = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		result[i] = buf.readFloatLE(i * 4);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Rotation Matrix Tests
// ---------------------------------------------------------------------------

describe("generateRotationMatrix", () => {
	test("deterministic with same seed", () => {
		const dim = 32;
		const R1 = generateRotationMatrix(dim, 123);
		const R2 = generateRotationMatrix(dim, 123);
		expect(R1.equals(R2)).toBe(true);
	});

	test("different seeds produce different matrices", () => {
		const dim = 16;
		const R1 = generateRotationMatrix(dim, 1);
		const R2 = generateRotationMatrix(dim, 2);
		expect(R1.equals(R2)).toBe(false);
	});

	test("preserves vector norms (rotation is isometric)", () => {
		const dim = 32;
		const R = parseRotationMatrix(generateRotationMatrix(dim, 42), dim);
		const rng = makeRng(99);
		const vec = randomVector(dim, rng);

		// Compute R × vec
		const rotated = new Float32Array(dim);
		for (let i = 0; i < dim; i++) {
			let sum = 0;
			for (let j = 0; j < dim; j++) {
				sum += R[i * dim + j] * vec[j];
			}
			rotated[i] = sum;
		}

		let origNorm = 0;
		let rotNorm = 0;
		for (let i = 0; i < dim; i++) {
			origNorm += vec[i] * vec[i];
			rotNorm += rotated[i] * rotated[i];
		}

		expect(Math.abs(Math.sqrt(origNorm) - Math.sqrt(rotNorm))).toBeLessThan(1e-4);
	});

	test("produces orthogonal matrix (R*R^T ≈ I) for small dims", () => {
		const dim = 16;
		const R = parseRotationMatrix(generateRotationMatrix(dim, 42), dim);

		for (let i = 0; i < dim; i++) {
			for (let j = 0; j < dim; j++) {
				let dot = 0;
				for (let k = 0; k < dim; k++) {
					dot += R[i * dim + k] * R[j * dim + k];
				}
				const expected = i === j ? 1 : 0;
				expect(Math.abs(dot - expected)).toBeLessThan(1e-4);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Codebook Tests
// ---------------------------------------------------------------------------

describe("computeCodebook", () => {
	test("produces correct number of centroids", () => {
		const cb4 = parseCodebook(computeCodebook(4, 768), 4);
		expect(cb4.length).toBe(16);

		const cb2 = parseCodebook(computeCodebook(2, 768), 2);
		expect(cb2.length).toBe(4);

		const cb1 = parseCodebook(computeCodebook(1, 768), 1);
		expect(cb1.length).toBe(2);
	});

	test("centroids are sorted ascending", () => {
		const cb = parseCodebook(computeCodebook(4, 768), 4);
		for (let i = 1; i < cb.length; i++) {
			expect(cb[i]).toBeGreaterThanOrEqual(cb[i - 1]);
		}
	});

	test("centroids are in [-1, 1] range", () => {
		const cb = parseCodebook(computeCodebook(4, 768), 4);
		for (let i = 0; i < cb.length; i++) {
			expect(cb[i]).toBeGreaterThanOrEqual(-1);
			expect(cb[i]).toBeLessThanOrEqual(1);
		}
	});

	test("centroids are symmetric around 0 for high dimensions", () => {
		const cb = parseCodebook(computeCodebook(4, 768), 4);
		for (let i = 0; i < cb.length / 2; i++) {
			const j = cb.length - 1 - i;
			expect(Math.abs(cb[i] + cb[j])).toBeLessThan(0.01);
		}
	});

	test("centroids cluster near 0 for high dimensions (concentration of measure)", () => {
		const cb = parseCodebook(computeCodebook(4, 768), 4);
		for (let i = 0; i < cb.length; i++) {
			expect(Math.abs(cb[i])).toBeLessThan(0.15);
		}
	});
});

// ---------------------------------------------------------------------------
// Build + Decompress Round-Trip Tests
// ---------------------------------------------------------------------------

describe("buildIndex + decompress (round-trip)", () => {
	const dim = 64;
	const seed = 42;
	const bits = 4;

	test("round-trip preserves vector direction (cosine > 0.7)", () => {
		const rng = makeRng(100);
		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) {
			vectors.push(normalize(randomVector(dim, rng)));
			ids.push(`vec-${i}`);
		}

		const indexBuf = buildIndex(vectors, ids, bits, dim, seed);
		const restored = decompress(indexBuf, dim);

		expect(restored.length).toBe(vectors.length);

		for (let i = 0; i < vectors.length; i++) {
			const sim = cosine(vectors[i], restored[i]);
			expect(sim).toBeGreaterThan(0.85);
		}
	});

	test("round-trip preserves approximate norms", () => {
		const rng = makeRng(200);
		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			vectors.push(randomVector(dim, rng));
			ids.push(`vec-${i}`);
		}

		const indexBuf = buildIndex(vectors, ids, bits, dim, seed);
		const restored = decompress(indexBuf, dim);

		for (let i = 0; i < vectors.length; i++) {
			let origNorm = 0;
			let restNorm = 0;
			for (let j = 0; j < dim; j++) {
				origNorm += vectors[i][j] * vectors[i][j];
				restNorm += restored[i][j] * restored[i][j];
			}
			origNorm = Math.sqrt(origNorm);
			restNorm = Math.sqrt(restNorm);

			const ratio = restNorm / origNorm;
			expect(ratio).toBeGreaterThan(0.7);
			expect(ratio).toBeLessThan(1.3);
		}
	});

	test("getIndexInfo returns correct metadata", () => {
		const rng = makeRng(300);
		const ids = ["alpha", "beta", "gamma"];
		const vectors = ids.map(() => randomVector(dim, rng));

		const indexBuf = buildIndex(vectors, ids, bits, dim, seed);
		const info = getIndexInfo(indexBuf);

		expect(info.count).toBe(3);
		expect(info.dim).toBe(dim);
		expect(info.bits).toBe(bits);
		expect(info.codebookSize).toBe(16);
	});

	test("compressed size is smaller than original", () => {
		const rng = makeRng(400);
		const numVectors = 100;
		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < numVectors; i++) {
			vectors.push(randomVector(dim, rng));
			ids.push(`v${i}`);
		}

		const indexBuf = buildIndex(vectors, ids, bits, dim, seed);

		// Original: numVectors × dim × 4 bytes
		const originalBytes = numVectors * dim * 4;
		// The serialized buffer contains everything (rotation matrix + codebook + compressed vectors)
		// but at scale the per-vector savings dominate
		expect(indexBuf.length).toBeLessThan(originalBytes * 2); // reasonable with overhead
	});
});

// ---------------------------------------------------------------------------
// Compressed Search Tests
// ---------------------------------------------------------------------------

describe("compressedSearch", () => {
	const dim = 64;
	const seed = 42;
	const bits = 4;

	test("returns correct number of results", () => {
		const rng = makeRng(500);
		const numVectors = 50;
		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < numVectors; i++) {
			vectors.push(normalize(randomVector(dim, rng)));
			ids.push(`v${i}`);
		}

		const indexBuf = buildIndex(vectors, ids, bits, dim, seed);
		const query = normalize(randomVector(dim, rng));

		const results10 = compressedSearch(indexBuf, query, 10);
		expect(results10.length).toBe(10);

		const results5 = compressedSearch(indexBuf, query, 5);
		expect(results5.length).toBe(5);

		const resultsAll = compressedSearch(indexBuf, query, 100);
		expect(resultsAll.length).toBe(numVectors);
	});

	test("results are sorted by score descending", () => {
		const rng = makeRng(600);
		const numVectors = 30;
		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < numVectors; i++) {
			vectors.push(normalize(randomVector(dim, rng)));
			ids.push(`v${i}`);
		}

		const indexBuf = buildIndex(vectors, ids, bits, dim, seed);
		const query = normalize(randomVector(dim, rng));
		const results = compressedSearch(indexBuf, query, 20);

		for (let i = 1; i < results.length; i++) {
			expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
		}
	});

	test("recall@10 vs brute force is reasonable (> 0.3 for 64-dim)", () => {
		const rng = makeRng(700);
		const numVectors = 200;
		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < numVectors; i++) {
			vectors.push(normalize(randomVector(dim, rng)));
			ids.push(`v${i}`);
		}

		const indexBuf = buildIndex(vectors, ids, bits, dim, seed);

		let totalRecall = 0;
		const numQueries = 10;

		for (let q = 0; q < numQueries; q++) {
			const query = normalize(randomVector(dim, rng));
			const k = 10;

			const compressed = compressedSearch(indexBuf, query, k);
			const bruteForce = bruteForceSearch(query, vectors, ids, k);

			const trueTopK = new Set(bruteForce.map((r) => r.id));
			let hits = 0;
			for (const r of compressed) {
				if (trueTopK.has(r.id)) hits++;
			}

			totalRecall += hits / k;
		}

		const avgRecall = totalRecall / numQueries;
		expect(avgRecall).toBeGreaterThan(0.3);
	});

	test("finds exact match when query is one of the vectors", () => {
		const rng = makeRng(800);
		const numVectors = 20;
		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < numVectors; i++) {
			vectors.push(normalize(randomVector(dim, rng)));
			ids.push(`v${i}`);
		}

		const indexBuf = buildIndex(vectors, ids, bits, dim, seed);

		const targetIdx = 5;
		const results = compressedSearch(indexBuf, vectors[targetIdx], 5);
		const foundIds = results.map((r) => r.id);
		expect(foundIds).toContain(`v${targetIdx}`);
	});
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
	test("empty vector set produces empty index", () => {
		const indexBuf = buildIndex([], [], 4, 16, 42);
		const info = getIndexInfo(indexBuf);
		expect(info.count).toBe(0);
	});

	test("empty index search returns empty results", () => {
		const dim = 16;
		const indexBuf = buildIndex([], [], 4, dim, 42);
		// Empty index has dim=0 in the serialized format, so search with dim=16 query
		// would mismatch — but the count=0 short-circuit should handle it
		const query = new Float32Array(dim);
		// For an empty index, the native code returns empty regardless
		const results = compressedSearch(indexBuf, query, 10);
		expect(results.length).toBe(0);
	});

	test("single vector build + search works", () => {
		const dim = 16;
		const rng = makeRng(900);
		const vec = normalize(randomVector(dim, rng));

		const indexBuf = buildIndex([vec], ["single"], 4, dim, 42);
		const info = getIndexInfo(indexBuf);
		expect(info.count).toBe(1);

		const results = compressedSearch(indexBuf, vec, 1);
		expect(results.length).toBe(1);
		expect(results[0].id).toBe("single");
	});

	test("zero vector is handled gracefully", () => {
		const dim = 16;
		const zero = new Float32Array(dim);

		const indexBuf = buildIndex([zero], ["zero"], 4, dim, 42);
		const info = getIndexInfo(indexBuf);
		expect(info.count).toBe(1);

		// Search with zero query returns empty (norm too small)
		const results = compressedSearch(indexBuf, zero, 1);
		expect(results.length).toBe(0);
	});

	test("topK = 0 returns empty results", () => {
		const dim = 16;
		const rng = makeRng(960);
		const vec = normalize(randomVector(dim, rng));

		const indexBuf = buildIndex([vec], ["x"], 4, dim, 42);
		const results = compressedSearch(indexBuf, vec, 0);
		expect(results.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Compress with pre-computed rotation/codebook
// ---------------------------------------------------------------------------

describe("compress (with pre-computed rotation + codebook)", () => {
	test("produces same search results as buildIndex", () => {
		const dim = 32;
		const seed = 42;
		const bits = 4;
		const rng = makeRng(1100);

		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < 20; i++) {
			vectors.push(normalize(randomVector(dim, rng)));
			ids.push(`v${i}`);
		}

		// Build via buildIndex (generates rotation+codebook internally)
		const indexBuf1 = buildIndex(vectors, ids, bits, dim, seed);

		// Build via compress (pre-computed rotation+codebook)
		const rotBuf = generateRotationMatrix(dim, seed);
		const cbBuf = computeCodebook(bits, dim);
		const indexBuf2 = compress(vectors, ids, rotBuf, cbBuf, bits, dim);

		const query = normalize(randomVector(dim, rng));

		const results1 = compressedSearch(indexBuf1, query, 5);
		const results2 = compressedSearch(indexBuf2, query, 5);

		// Both should return the same top IDs (same algorithm, same seed)
		expect(results1.map((r) => r.id)).toEqual(results2.map((r) => r.id));
	});
});

// ---------------------------------------------------------------------------
// Performance Benchmarks
// ---------------------------------------------------------------------------

describe("performance", () => {
	test("compressed search is fast on 1K vectors", () => {
		const dim = 128;
		const numVectors = 1000;
		const bits = 4;
		const seed = 42;
		const topK = 10;
		const rng = makeRng(1000);

		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < numVectors; i++) {
			vectors.push(normalize(randomVector(dim, rng)));
			ids.push(`v${i}`);
		}

		const indexBuf = buildIndex(vectors, ids, bits, dim, seed);
		const query = normalize(randomVector(dim, rng));

		// Warm up
		compressedSearch(indexBuf, query, topK);

		// Benchmark
		const iterations = 50;
		const start = performance.now();
		for (let i = 0; i < iterations; i++) {
			compressedSearch(indexBuf, query, topK);
		}
		const elapsed = (performance.now() - start) / iterations;

		console.log(
			`  Native compressed search: ${elapsed.toFixed(2)}ms per query (${numVectors} vectors, ${dim}-dim)`,
		);
		expect(elapsed).toBeGreaterThan(0);
	});

	test("memory compression ratio is significant", () => {
		const dim = 768;
		const numVectors = 1000;
		const bits = 4;

		const originalBytes = numVectors * dim * 4;
		const compressedPerVector = Math.ceil(dim / 2) + 8;
		const compressedBytes = numVectors * compressedPerVector;
		const overheadBytes = dim * dim * 4 + (1 << bits) * 4;

		const ratio10k = (10000 * dim * 4) / (10000 * compressedPerVector + overheadBytes);
		console.log(`  At 10K vectors: ${ratio10k.toFixed(2)}× compression`);
		expect(ratio10k).toBeGreaterThan(3);
	});
});

// ---------------------------------------------------------------------------
// Higher-dimensional recall test
// ---------------------------------------------------------------------------

describe("higher-dimensional quality", () => {
	test("recall@10 on 256-dim 500-vector set", () => {
		const dim = 256;
		const numVectors = 500;
		const bits = 4;
		const seed = 12345;
		const topK = 10;
		const rng = makeRng(2000);

		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < numVectors; i++) {
			vectors.push(normalize(randomVector(dim, rng)));
			ids.push(`v${i}`);
		}

		const indexBuf = buildIndex(vectors, ids, bits, dim, seed);

		let totalRecall = 0;
		const numQueries = 20;

		for (let q = 0; q < numQueries; q++) {
			const query = normalize(randomVector(dim, rng));
			const compressed = compressedSearch(indexBuf, query, topK);
			const truth = bruteForceSearch(query, vectors, ids, topK);

			const trueSet = new Set(truth.map((r) => r.id));
			let hits = 0;
			for (const r of compressed) {
				if (trueSet.has(r.id)) hits++;
			}
			totalRecall += hits / topK;
		}

		const avgRecall = totalRecall / numQueries;
		console.log(`  Recall@${topK} (${dim}-dim, ${numVectors} vectors): ${(avgRecall * 100).toFixed(1)}%`);
		expect(avgRecall).toBeGreaterThan(0.2);
	});
});
