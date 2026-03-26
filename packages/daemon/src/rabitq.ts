/**
 * RaBitQ — Thin TypeScript wrapper over native Rust implementation.
 *
 * Replaces the pure-TS rabitq.ts with native bindings from @signet/native.
 * All heavy computation (rotation matrix generation, codebook computation,
 * quantization, compressed search) is done in Rust; this module provides
 * the same public API surface for drop-in compatibility.
 */

import {
	rabitqBuildIndex,
	rabitqSearch,
	rabitqCompress,
	rabitqDecompress,
	rabitqGenerateRotationMatrix,
	rabitqComputeCodebook,
	rabitqBruteForceSearch,
	rabitqIndexInfo,
	type RabitqSearchResult,
	type RabitqIndexInfo,
} from "@signet/native";

// ---------------------------------------------------------------------------
// Types (match the original TS interface)
// ---------------------------------------------------------------------------

/** Search result from compressed search. */
export interface CompressedSearchResult {
	id: string;
	score: number;
}

/** Opaque compressed index handle (serialized Buffer from Rust). */
export type CompressedIndexHandle = Buffer;

/** Index metadata (read from a serialized handle). */
export interface CompressedIndexMeta {
	bits: number;
	dim: number;
	count: number;
	codebookSize: number;
}

// ---------------------------------------------------------------------------
// Rotation Matrix + Codebook
// ---------------------------------------------------------------------------

/**
 * Generate a random orthogonal rotation matrix via Householder QR.
 *
 * @param dim  Dimensionality (768 for nomic-embed)
 * @param seed Optional seed for deterministic generation
 * @returns Buffer containing dim×dim f32 values (row-major, little-endian)
 */
export function generateRotationMatrix(dim: number, seed?: number): Buffer {
	return rabitqGenerateRotationMatrix(dim, seed ?? Date.now()) as Buffer;
}

/**
 * Compute the RaBitQ codebook centroids.
 *
 * @param bits Number of quantization bits (e.g. 4 → 16 centroids)
 * @param dim  Vector dimensionality
 * @returns Buffer containing 2^bits f32 centroid values (little-endian)
 */
export function computeCodebook(bits: number, dim: number): Buffer {
	return rabitqComputeCodebook(bits, dim) as Buffer;
}

// ---------------------------------------------------------------------------
// Index Build
// ---------------------------------------------------------------------------

/**
 * Build a compressed RaBitQ index from vectors.
 *
 * Handles rotation matrix generation and codebook computation internally.
 *
 * @param vectors Array of Float32Array embeddings (each dim-dimensional)
 * @param ids     Corresponding memory IDs
 * @param bits    Quantization bits per coordinate (default: 4)
 * @param dim     Vector dimensionality (inferred from first vector if omitted)
 * @param seed    PRNG seed for rotation matrix (default: 42)
 * @returns Opaque CompressedIndexHandle (Buffer)
 */
export function buildIndex(
	vectors: ReadonlyArray<Float32Array>,
	ids: ReadonlyArray<string>,
	bits = 4,
	dim?: number,
	seed = 42,
): CompressedIndexHandle {
	const actualDim = dim ?? vectors[0]?.length ?? 768;

	// Concatenate all vectors into a single Buffer for FFI
	const totalBytes = vectors.length * actualDim * 4;
	const buf = Buffer.alloc(totalBytes);
	let offset = 0;
	for (const vec of vectors) {
		for (let i = 0; i < actualDim; i++) {
			buf.writeFloatLE(vec[i] ?? 0, offset);
			offset += 4;
		}
	}

	return rabitqBuildIndex(buf, ids as string[], bits, actualDim, seed) as Buffer;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search a compressed index for approximate nearest neighbours.
 *
 * @param indexHandle Opaque CompressedIndexHandle from buildIndex()
 * @param query      Query vector (Float32Array)
 * @param topK       Number of results to return
 * @returns Array of {id, score} sorted by descending score
 */
export function compressedSearch(
	indexHandle: CompressedIndexHandle,
	query: Float32Array,
	topK: number,
): CompressedSearchResult[] {
	return rabitqSearch(indexHandle, query, topK) as CompressedSearchResult[];
}

// ---------------------------------------------------------------------------
// Compress / Decompress (with pre-computed rotation + codebook)
// ---------------------------------------------------------------------------

/**
 * Quantize vectors with pre-computed rotation matrix and codebook.
 *
 * Use when you want to cache the rotation matrix and codebook across
 * multiple index builds (e.g. incremental updates).
 */
export function compress(
	vectors: ReadonlyArray<Float32Array>,
	ids: ReadonlyArray<string>,
	rotationMatrix: Buffer,
	codebook: Buffer,
	bits: number,
	dim: number,
): CompressedIndexHandle {
	const totalBytes = vectors.length * dim * 4;
	const buf = Buffer.alloc(totalBytes);
	let offset = 0;
	for (const vec of vectors) {
		for (let i = 0; i < dim; i++) {
			buf.writeFloatLE(vec[i] ?? 0, offset);
			offset += 4;
		}
	}

	return rabitqCompress(buf, ids as string[], rotationMatrix, codebook, bits, dim) as Buffer;
}

/**
 * Decompress (dequantize) a compressed index back to approximate vectors.
 *
 * @param indexHandle Serialized CompressedIndex buffer
 * @param dim        Vector dimensionality (needed to parse output)
 * @returns Array of Float32Array approximate vectors
 */
export function decompress(indexHandle: CompressedIndexHandle, dim: number): Float32Array[] {
	const resultBuf = rabitqDecompress(indexHandle) as Buffer;
	const floatCount = resultBuf.length / 4;
	const numVectors = floatCount / dim;
	const vectors: Float32Array[] = [];

	for (let i = 0; i < numVectors; i++) {
		const vec = new Float32Array(dim);
		const base = i * dim * 4;
		for (let j = 0; j < dim; j++) {
			vec[j] = resultBuf.readFloatLE(base + j * 4);
		}
		vectors.push(vec);
	}

	return vectors;
}

// ---------------------------------------------------------------------------
// Index Info
// ---------------------------------------------------------------------------

/**
 * Get metadata about a serialized compressed index.
 */
export function getIndexInfo(indexHandle: CompressedIndexHandle): CompressedIndexMeta {
	const info = rabitqIndexInfo(indexHandle) as RabitqIndexInfo;
	return {
		bits: info.bits,
		dim: info.dim,
		count: info.count,
		codebookSize: info.codebookSize,
	};
}

// ---------------------------------------------------------------------------
// Brute Force Search (for recall evaluation)
// ---------------------------------------------------------------------------

/**
 * Brute-force cosine similarity search (ground truth baseline).
 */
export function bruteForceSearch(
	query: Float32Array,
	vectors: ReadonlyArray<Float32Array>,
	ids: ReadonlyArray<string>,
	topK: number,
): CompressedSearchResult[] {
	const dim = query.length;
	const totalBytes = vectors.length * dim * 4;
	const buf = Buffer.alloc(totalBytes);
	let offset = 0;
	for (const vec of vectors) {
		for (let i = 0; i < dim; i++) {
			buf.writeFloatLE(vec[i] ?? 0, offset);
			offset += 4;
		}
	}

	return rabitqBruteForceSearch(query, buf, ids as string[], dim, topK) as CompressedSearchResult[];
}
