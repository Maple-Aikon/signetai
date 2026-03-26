/**
 * Unit tests for native-generation.ts
 *
 * Mocks the transformers.js bindings and verifies:
 * - Multi-model config registry (Qwen + Nemotron)
 * - TurboQuant compression targets only attention layers (per model)
 * - KV cache management across generation steps
 * - Token sampling logic (greedy + temperature + top-p)
 * - LlmProvider interface compliance for all model variants
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	sampleToken,
	KvCacheManager,
	NATIVE_MODELS,
	DEFAULT_MODEL_ID,
	type NativeModelConfig,
} from "./native-generation";
import { TurboQuantKvCache } from "./turboquant-cache";

// ---------------------------------------------------------------------------
// Mock logger to suppress output during tests
// ---------------------------------------------------------------------------
vi.mock("./logger", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// ---------------------------------------------------------------------------
// Helpers — fake tensors and data
// ---------------------------------------------------------------------------

/** Minimal OnnxTensor-like object for tests. */
function fakeTensor(
	data: Float32Array,
	dims: readonly number[],
): { data: Float32Array; dims: readonly number[] } {
	return { data, dims };
}

/** Create a tensor with shape [1, numHeads, seqLen, headDim] filled with `fillValue`. */
function makeKvTensor(
	numHeads: number,
	seqLen: number,
	headDim: number,
	fillValue = 1.0,
): { data: Float32Array; dims: readonly number[] } {
	const data = new Float32Array(numHeads * seqLen * headDim);
	data.fill(fillValue);
	return fakeTensor(data, [1, numHeads, seqLen, headDim]);
}

/** Fake Tensor constructor that mirrors OnnxTensor interface. */
class FakeTensor {
	readonly data: Float32Array;
	readonly dims: readonly number[];
	constructor(_type: string, data: Float32Array, dims: readonly number[]) {
		this.data = data;
		this.dims = dims;
	}
}

// ---------------------------------------------------------------------------
// Model config constants for tests
// ---------------------------------------------------------------------------

// Qwen 3.5 4B architecture
const QWEN_NUM_KV_HEADS = 4;
const QWEN_HEAD_DIM = 256;
const QWEN_ATTN_LAYERS = [3, 7, 11, 15, 19, 23, 27, 31];
const QWEN_TOTAL_LAYERS = 32;
const QWEN_LINEAR_LAYERS = Array.from({ length: QWEN_TOTAL_LAYERS }, (_, i) => i).filter(
	(i) => !QWEN_ATTN_LAYERS.includes(i),
);

// Nemotron 3 Nano 4B architecture
const NEMO_NUM_KV_HEADS = 8;
const NEMO_HEAD_DIM = 128;
const NEMO_ATTN_LAYERS = [12, 17, 24, 32];
const NEMO_TOTAL_LAYERS = 42;
const NEMO_NON_ATTN_LAYERS = Array.from({ length: NEMO_TOTAL_LAYERS }, (_, i) => i).filter(
	(i) => !NEMO_ATTN_LAYERS.includes(i),
);

const RESIDUAL_WINDOW = 128;

// ---------------------------------------------------------------------------
// Helper: create a KvCacheManager for a given model config
// ---------------------------------------------------------------------------

function createManagerForModel(
	config: NativeModelConfig,
	residualWindowSize = RESIDUAL_WINDOW,
): { manager: KvCacheManager; tqCache: TurboQuantKvCache } {
	const tqCache = TurboQuantKvCache.create({
		bits: 4,
		headDim: config.headDim,
		numHeads: config.numKvHeads,
		residualWindowSize,
	});
	const manager = new KvCacheManager(
		tqCache,
		config.numKvHeads,
		config.headDim,
		config.attentionLayerIndices,
	);
	return { manager, tqCache };
}

// ---------------------------------------------------------------------------
// Token sampling tests
// ---------------------------------------------------------------------------

describe("sampleToken", () => {
	it("should return argmax in greedy mode (temperature=0)", () => {
		const logits = new Float32Array([1.0, 3.0, 2.0, 0.5]);
		const result = sampleToken(logits, 0, 0.9);
		expect(result).toBe(1); // index of 3.0
	});

	it("should return argmax for very low temperature", () => {
		const logits = new Float32Array([0.1, 0.2, 10.0, 0.3]);
		const result = sampleToken(logits, 0, 1.0);
		expect(result).toBe(2); // index of 10.0
	});

	it("should return a valid index with temperature > 0", () => {
		const logits = new Float32Array([1.0, 2.0, 3.0]);
		const result = sampleToken(logits, 0.7, 0.9);
		expect(result).toBeGreaterThanOrEqual(0);
		expect(result).toBeLessThan(3);
	});

	it("should handle uniform logits", () => {
		const logits = new Float32Array(100);
		logits.fill(1.0);
		const result = sampleToken(logits, 1.0, 1.0);
		expect(result).toBeGreaterThanOrEqual(0);
		expect(result).toBeLessThan(100);
	});

	it("should handle single-element logits", () => {
		const logits = new Float32Array([5.0]);
		const result = sampleToken(logits, 1.0, 1.0);
		expect(result).toBe(0);
	});

	it("should handle very large logit differences gracefully", () => {
		const logits = new Float32Array([0, 0, 1000, 0]);
		const result = sampleToken(logits, 1.0, 0.9);
		expect(result).toBe(2);
	});

	it("should respect top-p filtering", () => {
		// Create logits where one token dominates
		const logits = new Float32Array([10.0, -100.0, -100.0, -100.0]);
		// With very tight top-p, only the dominant token should be sampled
		const result = sampleToken(logits, 1.0, 0.01);
		expect(result).toBe(0);
	});

	it("should return consistent results in greedy mode", () => {
		const logits = new Float32Array([1.5, 3.7, 2.1, 0.8]);
		const results = new Set<number>();
		for (let i = 0; i < 10; i++) {
			results.add(sampleToken(logits, 0, 0.9));
		}
		// Greedy should always return the same index
		expect(results.size).toBe(1);
		expect(results.has(1)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// NATIVE_MODELS registry tests
// ---------------------------------------------------------------------------

describe("NATIVE_MODELS registry", () => {
	it("should have exactly 2 models", () => {
		expect(NATIVE_MODELS.size).toBe(2);
	});

	it("should contain qwen3.5-4b with correct values", () => {
		const config = NATIVE_MODELS.get("qwen3.5-4b");
		expect(config).toBeDefined();
		expect(config!.id).toBe("qwen3.5-4b");
		expect(config!.onnxId).toBe("onnx-community/Qwen3.5-4B-ONNX");
		expect(config!.dtype).toBe("q4f16");
		expect(config!.architecture).toBe("qwen3_5");
		expect(config!.totalLayers).toBe(32);
		expect(config!.headDim).toBe(256);
		expect(config!.numKvHeads).toBe(4);
		expect(config!.eosTokenId).toBe(248044);
		expect(config!.displayName).toBe("Qwen 3.5 4B");
		expect(config!.attentionLayerIndices.size).toBe(8);
		for (const idx of QWEN_ATTN_LAYERS) {
			expect(config!.attentionLayerIndices.has(idx)).toBe(true);
		}
	});

	it("should contain nemotron-3-nano-4b with correct values", () => {
		const config = NATIVE_MODELS.get("nemotron-3-nano-4b");
		expect(config).toBeDefined();
		expect(config!.id).toBe("nemotron-3-nano-4b");
		expect(config!.onnxId).toBe("onnx-community/NVIDIA-Nemotron-3-Nano-4B-BF16-ONNX");
		expect(config!.dtype).toBe("q4f16");
		expect(config!.architecture).toBe("nemotron_h");
		expect(config!.totalLayers).toBe(42);
		expect(config!.headDim).toBe(128);
		expect(config!.numKvHeads).toBe(8);
		expect(config!.eosTokenId).toBe(2);
		expect(config!.displayName).toBe("Nemotron 3 Nano 4B");
		expect(config!.attentionLayerIndices.size).toBe(4);
		for (const idx of NEMO_ATTN_LAYERS) {
			expect(config!.attentionLayerIndices.has(idx)).toBe(true);
		}
	});

	it("should default to qwen3.5-4b", () => {
		expect(DEFAULT_MODEL_ID).toBe("qwen3.5-4b");
	});
});

// ---------------------------------------------------------------------------
// KvCacheManager — backward compat static method
// ---------------------------------------------------------------------------

describe("KvCacheManager.isFullAttentionLayer (backward compat)", () => {
	it("should identify Qwen full_attention layers correctly", () => {
		for (const idx of QWEN_ATTN_LAYERS) {
			expect(KvCacheManager.isFullAttentionLayer(idx)).toBe(true);
		}
	});

	it("should reject linear_attention layers", () => {
		for (const idx of QWEN_LINEAR_LAYERS) {
			expect(KvCacheManager.isFullAttentionLayer(idx)).toBe(false);
		}
	});

	it("should reject out-of-range indices", () => {
		expect(KvCacheManager.isFullAttentionLayer(32)).toBe(false);
		expect(KvCacheManager.isFullAttentionLayer(-1)).toBe(false);
		expect(KvCacheManager.isFullAttentionLayer(100)).toBe(false);
	});

	it("should identify exactly 8 full_attention layers", () => {
		let count = 0;
		for (let i = 0; i < 32; i++) {
			if (KvCacheManager.isFullAttentionLayer(i)) count++;
		}
		expect(count).toBe(8);
	});
});

// ---------------------------------------------------------------------------
// KvCacheManager — config-driven instance method (Qwen)
// ---------------------------------------------------------------------------

describe("KvCacheManager.isAttentionLayer (Qwen config)", () => {
	it("should identify Qwen attention layers via instance method", () => {
		const qwenConfig = NATIVE_MODELS.get("qwen3.5-4b")!;
		const { manager } = createManagerForModel(qwenConfig);
		for (const idx of QWEN_ATTN_LAYERS) {
			expect(manager.isAttentionLayer(idx)).toBe(true);
		}
		for (const idx of QWEN_LINEAR_LAYERS) {
			expect(manager.isAttentionLayer(idx)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// KvCacheManager — config-driven instance method (Nemotron)
// ---------------------------------------------------------------------------

describe("KvCacheManager.isAttentionLayer (Nemotron config)", () => {
	it("should identify exactly 4 Nemotron attention layers", () => {
		const nemoConfig = NATIVE_MODELS.get("nemotron-3-nano-4b")!;
		const { manager } = createManagerForModel(nemoConfig);

		let count = 0;
		for (let i = 0; i < NEMO_TOTAL_LAYERS; i++) {
			if (manager.isAttentionLayer(i)) count++;
		}
		expect(count).toBe(4);
	});

	it("should identify the correct Nemotron attention layer indices", () => {
		const nemoConfig = NATIVE_MODELS.get("nemotron-3-nano-4b")!;
		const { manager } = createManagerForModel(nemoConfig);

		for (const idx of NEMO_ATTN_LAYERS) {
			expect(manager.isAttentionLayer(idx)).toBe(true);
		}
	});

	it("should reject Nemotron non-attention layers (mamba + mlp)", () => {
		const nemoConfig = NATIVE_MODELS.get("nemotron-3-nano-4b")!;
		const { manager } = createManagerForModel(nemoConfig);

		for (const idx of NEMO_NON_ATTN_LAYERS) {
			expect(manager.isAttentionLayer(idx)).toBe(false);
		}
	});

	it("should expose attentionLayerIndices via getter", () => {
		const nemoConfig = NATIVE_MODELS.get("nemotron-3-nano-4b")!;
		const { manager } = createManagerForModel(nemoConfig);

		const indices = manager.attentionLayerIndices;
		expect(indices.size).toBe(4);
		expect(indices.has(12)).toBe(true);
		expect(indices.has(17)).toBe(true);
		expect(indices.has(24)).toBe(true);
		expect(indices.has(32)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// KvCacheManager — prefill + compression tests (Qwen)
// ---------------------------------------------------------------------------

describe("KvCacheManager (Qwen)", () => {
	let tqCache: TurboQuantKvCache;
	let manager: KvCacheManager;

	beforeEach(() => {
		const qwenConfig = NATIVE_MODELS.get("qwen3.5-4b")!;
		({ tqCache, manager } = createManagerForModel(qwenConfig));
	});

	it("should initialize with zero tokens", () => {
		expect(manager.totalTokens).toBe(0);
	});

	it("should advance token counter", () => {
		manager.advanceToken(10);
		expect(manager.totalTokens).toBe(10);
		manager.advanceToken();
		expect(manager.totalTokens).toBe(11);
	});

	it("should initialize layer state from prefill", () => {
		const seqLen = 5;
		const keyTensor = makeKvTensor(QWEN_NUM_KV_HEADS, seqLen, QWEN_HEAD_DIM, 0.5);
		const valTensor = makeKvTensor(QWEN_NUM_KV_HEADS, seqLen, QWEN_HEAD_DIM, 0.3);

		manager.initLayerFromPrefill(3, keyTensor, valTensor);
		manager.advanceToken(seqLen);

		const stats = manager.getStats();
		expect(stats.compressedLayers).toBe(1);
		expect(stats.residualTokensPerLayer).toBe(seqLen);
		expect(stats.compressedTokensPerLayer).toBe(0);
	});

	it("should not compress when within residual window", () => {
		// Prefill with tokens under the residual window size
		const seqLen = 10;
		const keyTensor = makeKvTensor(QWEN_NUM_KV_HEADS, seqLen, QWEN_HEAD_DIM, 1.0);
		const valTensor = makeKvTensor(QWEN_NUM_KV_HEADS, seqLen, QWEN_HEAD_DIM, 1.0);

		manager.initLayerFromPrefill(7, keyTensor, valTensor);
		manager.advanceToken(seqLen);

		// Add a few more tokens (still under window)
		for (let i = 0; i < 5; i++) {
			const newKey = makeKvTensor(QWEN_NUM_KV_HEADS, 1, QWEN_HEAD_DIM, 2.0);
			const newVal = makeKvTensor(QWEN_NUM_KV_HEADS, 1, QWEN_HEAD_DIM, 2.0);
			manager.appendAndCompress(7, newKey, newVal);
			manager.advanceToken();
		}

		const stats = manager.getStats();
		// 10 + 5 = 15, which is under the 128-token window
		expect(stats.residualTokensPerLayer).toBe(15);
		expect(stats.compressedTokensPerLayer).toBe(0);
	});

	it("should start compressing once tokens exceed residual window", () => {
		// Fill up the residual window
		const seqLen = RESIDUAL_WINDOW;
		const keyTensor = makeKvTensor(QWEN_NUM_KV_HEADS, seqLen, QWEN_HEAD_DIM, 1.0);
		const valTensor = makeKvTensor(QWEN_NUM_KV_HEADS, seqLen, QWEN_HEAD_DIM, 1.0);

		manager.initLayerFromPrefill(3, keyTensor, valTensor);
		manager.advanceToken(seqLen);

		// Add tokens that push beyond the window
		const extraTokens = 10;
		for (let i = 0; i < extraTokens; i++) {
			const newKey = makeKvTensor(QWEN_NUM_KV_HEADS, 1, QWEN_HEAD_DIM, 2.0);
			const newVal = makeKvTensor(QWEN_NUM_KV_HEADS, 1, QWEN_HEAD_DIM, 2.0);
			manager.appendAndCompress(3, newKey, newVal);
			manager.advanceToken();
		}

		const stats = manager.getStats();
		// Should have compressed the overflow
		expect(stats.compressedTokensPerLayer).toBe(extraTokens);
		expect(stats.residualTokensPerLayer).toBe(RESIDUAL_WINDOW);
	});

	it("should reconstruct layer correctly from compressed + residual", () => {
		const seqLen = 5;
		const keyTensor = makeKvTensor(QWEN_NUM_KV_HEADS, seqLen, QWEN_HEAD_DIM, 1.0);
		const valTensor = makeKvTensor(QWEN_NUM_KV_HEADS, seqLen, QWEN_HEAD_DIM, 0.5);

		manager.initLayerFromPrefill(3, keyTensor, valTensor);
		manager.advanceToken(seqLen);

		const result = manager.reconstructLayer(3, FakeTensor as any);
		expect(result).not.toBeNull();
		expect(result!.key.dims).toEqual([1, QWEN_NUM_KV_HEADS, seqLen, QWEN_HEAD_DIM]);
		expect(result!.value.dims).toEqual([1, QWEN_NUM_KV_HEADS, seqLen, QWEN_HEAD_DIM]);
		expect(result!.key.data.length).toBe(QWEN_NUM_KV_HEADS * seqLen * QWEN_HEAD_DIM);
		expect(result!.value.data.length).toBe(QWEN_NUM_KV_HEADS * seqLen * QWEN_HEAD_DIM);
	});

	it("should return null for uninitialized layers", () => {
		const result = manager.reconstructLayer(99, FakeTensor as any);
		expect(result).toBeNull();
	});

	it("should reset all state", () => {
		const keyTensor = makeKvTensor(QWEN_NUM_KV_HEADS, 5, QWEN_HEAD_DIM, 1.0);
		const valTensor = makeKvTensor(QWEN_NUM_KV_HEADS, 5, QWEN_HEAD_DIM, 1.0);
		manager.initLayerFromPrefill(3, keyTensor, valTensor);
		manager.advanceToken(5);

		manager.reset();

		expect(manager.totalTokens).toBe(0);
		expect(manager.reconstructLayer(3, FakeTensor as any)).toBeNull();
		const stats = manager.getStats();
		expect(stats.compressedLayers).toBe(0);
	});

	it("should handle multiple full_attention layers independently", () => {
		for (const layerIdx of QWEN_ATTN_LAYERS) {
			const keyTensor = makeKvTensor(QWEN_NUM_KV_HEADS, 3, QWEN_HEAD_DIM, layerIdx * 0.1);
			const valTensor = makeKvTensor(QWEN_NUM_KV_HEADS, 3, QWEN_HEAD_DIM, layerIdx * 0.1);
			manager.initLayerFromPrefill(layerIdx, keyTensor, valTensor);
		}

		const stats = manager.getStats();
		expect(stats.compressedLayers).toBe(QWEN_ATTN_LAYERS.length);
	});
});

// ---------------------------------------------------------------------------
// KvCacheManager — Nemotron-specific tests
// ---------------------------------------------------------------------------

describe("KvCacheManager (Nemotron)", () => {
	let tqCache: TurboQuantKvCache;
	let manager: KvCacheManager;

	beforeEach(() => {
		const nemoConfig = NATIVE_MODELS.get("nemotron-3-nano-4b")!;
		({ tqCache, manager } = createManagerForModel(nemoConfig));
	});

	it("should initialize with zero tokens", () => {
		expect(manager.totalTokens).toBe(0);
	});

	it("should initialize Nemotron attention layers from prefill", () => {
		for (const layerIdx of NEMO_ATTN_LAYERS) {
			const keyTensor = makeKvTensor(NEMO_NUM_KV_HEADS, 5, NEMO_HEAD_DIM, 1.0);
			const valTensor = makeKvTensor(NEMO_NUM_KV_HEADS, 5, NEMO_HEAD_DIM, 1.0);
			manager.initLayerFromPrefill(layerIdx, keyTensor, valTensor);
		}

		const stats = manager.getStats();
		expect(stats.compressedLayers).toBe(4);
		expect(stats.residualTokensPerLayer).toBe(5);
	});

	it("should reconstruct Nemotron attention layer correctly", () => {
		const seqLen = 3;
		const keyTensor = makeKvTensor(NEMO_NUM_KV_HEADS, seqLen, NEMO_HEAD_DIM, 0.7);
		const valTensor = makeKvTensor(NEMO_NUM_KV_HEADS, seqLen, NEMO_HEAD_DIM, 0.3);

		manager.initLayerFromPrefill(12, keyTensor, valTensor);
		manager.advanceToken(seqLen);

		const result = manager.reconstructLayer(12, FakeTensor as any);
		expect(result).not.toBeNull();
		expect(result!.key.dims).toEqual([1, NEMO_NUM_KV_HEADS, seqLen, NEMO_HEAD_DIM]);
		expect(result!.value.dims).toEqual([1, NEMO_NUM_KV_HEADS, seqLen, NEMO_HEAD_DIM]);
		expect(result!.key.data.length).toBe(NEMO_NUM_KV_HEADS * seqLen * NEMO_HEAD_DIM);
	});

	it("should compress Nemotron KV cache beyond residual window", () => {
		const seqLen = RESIDUAL_WINDOW;
		const keyTensor = makeKvTensor(NEMO_NUM_KV_HEADS, seqLen, NEMO_HEAD_DIM, 1.0);
		const valTensor = makeKvTensor(NEMO_NUM_KV_HEADS, seqLen, NEMO_HEAD_DIM, 1.0);

		manager.initLayerFromPrefill(17, keyTensor, valTensor);
		manager.advanceToken(seqLen);

		// Add tokens that push beyond the window
		for (let i = 0; i < 5; i++) {
			const newKey = makeKvTensor(NEMO_NUM_KV_HEADS, 1, NEMO_HEAD_DIM, 2.0);
			const newVal = makeKvTensor(NEMO_NUM_KV_HEADS, 1, NEMO_HEAD_DIM, 2.0);
			manager.appendAndCompress(17, newKey, newVal);
			manager.advanceToken();
		}

		const stats = manager.getStats();
		expect(stats.compressedTokensPerLayer).toBe(5);
		expect(stats.residualTokensPerLayer).toBe(RESIDUAL_WINDOW);
	});

	it("should not track non-attention Nemotron layers", () => {
		// Mamba layer (index 0) should not be tracked
		expect(manager.isAttentionLayer(0)).toBe(false);
		expect(manager.reconstructLayer(0, FakeTensor as any)).toBeNull();
		// MLP layer (index 1)
		expect(manager.isAttentionLayer(1)).toBe(false);
	});

	it("should handle Nemotron compression with 8 KV heads × 128 headDim", () => {
		const compressSpy = vi.spyOn(tqCache, "compressVector");
		const smallWindow = 4;
		const nemoConfig = NATIVE_MODELS.get("nemotron-3-nano-4b")!;
		const { manager: smallMgr, tqCache: smallCache } = createManagerForModel(nemoConfig, smallWindow);
		const spy = vi.spyOn(smallCache, "compressVector");

		const prefillKey = makeKvTensor(NEMO_NUM_KV_HEADS, smallWindow, NEMO_HEAD_DIM, 1.0);
		const prefillVal = makeKvTensor(NEMO_NUM_KV_HEADS, smallWindow, NEMO_HEAD_DIM, 1.0);
		smallMgr.initLayerFromPrefill(24, prefillKey, prefillVal);
		smallMgr.advanceToken(smallWindow);

		// Add one token past window
		const newKey = makeKvTensor(NEMO_NUM_KV_HEADS, 1, NEMO_HEAD_DIM, 2.0);
		const newVal = makeKvTensor(NEMO_NUM_KV_HEADS, 1, NEMO_HEAD_DIM, 2.0);
		smallMgr.appendAndCompress(24, newKey, newVal);

		// compressVector: 1 token × 8 heads × 2 (key+val) = 16
		expect(spy).toHaveBeenCalledTimes(NEMO_NUM_KV_HEADS * 2);

		compressSpy.mockRestore();
		spy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// TurboQuant integration — compression round-trip (Qwen)
// ---------------------------------------------------------------------------

describe("TurboQuant compression round-trip via KvCacheManager (Qwen)", () => {
	let tqCache: TurboQuantKvCache;
	let manager: KvCacheManager;

	beforeEach(() => {
		tqCache = TurboQuantKvCache.create({
			bits: 4,
			headDim: QWEN_HEAD_DIM,
			numHeads: QWEN_NUM_KV_HEADS,
			residualWindowSize: 4, // Small window for testing
		});
		manager = new KvCacheManager(
			tqCache,
			QWEN_NUM_KV_HEADS,
			QWEN_HEAD_DIM,
			new Set(QWEN_ATTN_LAYERS),
		);
	});

	it("should compress vectors and decompress with reasonable fidelity", () => {
		// Create a random vector
		const vec = new Float32Array(QWEN_HEAD_DIM);
		for (let i = 0; i < QWEN_HEAD_DIM; i++) {
			vec[i] = Math.sin(i * 0.1) * 2.0;
		}

		const compressed = tqCache.compressVector(vec);
		const decompressed = tqCache.decompressVector(compressed);

		expect(decompressed.length).toBe(QWEN_HEAD_DIM);

		// Compute relative error — TurboQuant 4-bit should keep it under ~15%
		let errorSq = 0;
		let normSq = 0;
		for (let i = 0; i < QWEN_HEAD_DIM; i++) {
			errorSq += (vec[i] - decompressed[i]) ** 2;
			normSq += vec[i] ** 2;
		}
		const relativeError = Math.sqrt(errorSq / normSq);
		expect(relativeError).toBeLessThan(0.2); // generous threshold for 4-bit
	});

	it("should only compress tokens beyond the residual window", () => {
		const windowSize = 4;

		// Prefill with exactly the window size
		const prefillKey = makeKvTensor(QWEN_NUM_KV_HEADS, windowSize, QWEN_HEAD_DIM, 1.0);
		const prefillVal = makeKvTensor(QWEN_NUM_KV_HEADS, windowSize, QWEN_HEAD_DIM, 1.0);
		manager.initLayerFromPrefill(3, prefillKey, prefillVal);
		manager.advanceToken(windowSize);

		let stats = manager.getStats();
		expect(stats.compressedTokensPerLayer).toBe(0);
		expect(stats.residualTokensPerLayer).toBe(windowSize);

		// Add one more token — should push oldest out of window
		const newKey = makeKvTensor(QWEN_NUM_KV_HEADS, 1, QWEN_HEAD_DIM, 2.0);
		const newVal = makeKvTensor(QWEN_NUM_KV_HEADS, 1, QWEN_HEAD_DIM, 2.0);
		manager.appendAndCompress(3, newKey, newVal);
		manager.advanceToken();

		stats = manager.getStats();
		expect(stats.compressedTokensPerLayer).toBe(1);
		expect(stats.residualTokensPerLayer).toBe(windowSize);
	});

	it("should maintain sequence length consistency after compression", () => {
		const windowSize = 4;
		const initialLen = 3;

		const prefillKey = makeKvTensor(QWEN_NUM_KV_HEADS, initialLen, QWEN_HEAD_DIM, 1.0);
		const prefillVal = makeKvTensor(QWEN_NUM_KV_HEADS, initialLen, QWEN_HEAD_DIM, 1.0);
		manager.initLayerFromPrefill(3, prefillKey, prefillVal);
		manager.advanceToken(initialLen);

		// Add enough tokens to trigger compression
		const extra = 10;
		for (let i = 0; i < extra; i++) {
			const newKey = makeKvTensor(QWEN_NUM_KV_HEADS, 1, QWEN_HEAD_DIM, i * 0.1);
			const newVal = makeKvTensor(QWEN_NUM_KV_HEADS, 1, QWEN_HEAD_DIM, i * 0.1);
			manager.appendAndCompress(3, newKey, newVal);
			manager.advanceToken();
		}

		// Reconstruct and verify total sequence length
		const result = manager.reconstructLayer(3, FakeTensor as any);
		expect(result).not.toBeNull();
		const expectedTotalSeq = initialLen + extra;
		expect(result!.key.dims[2]).toBe(expectedTotalSeq);
		expect(result!.value.dims[2]).toBe(expectedTotalSeq);
	});
});

// ---------------------------------------------------------------------------
// TurboQuant compression round-trip (Nemotron)
// ---------------------------------------------------------------------------

describe("TurboQuant compression round-trip via KvCacheManager (Nemotron)", () => {
	let tqCache: TurboQuantKvCache;
	let manager: KvCacheManager;

	beforeEach(() => {
		tqCache = TurboQuantKvCache.create({
			bits: 4,
			headDim: NEMO_HEAD_DIM,
			numHeads: NEMO_NUM_KV_HEADS,
			residualWindowSize: 4,
		});
		manager = new KvCacheManager(
			tqCache,
			NEMO_NUM_KV_HEADS,
			NEMO_HEAD_DIM,
			new Set(NEMO_ATTN_LAYERS),
		);
	});

	it("should compress Nemotron vectors (headDim=128) with reasonable fidelity", () => {
		const vec = new Float32Array(NEMO_HEAD_DIM);
		for (let i = 0; i < NEMO_HEAD_DIM; i++) {
			vec[i] = Math.cos(i * 0.15) * 1.5;
		}

		const compressed = tqCache.compressVector(vec);
		const decompressed = tqCache.decompressVector(compressed);

		expect(decompressed.length).toBe(NEMO_HEAD_DIM);

		let errorSq = 0;
		let normSq = 0;
		for (let i = 0; i < NEMO_HEAD_DIM; i++) {
			errorSq += (vec[i] - decompressed[i]) ** 2;
			normSq += vec[i] ** 2;
		}
		const relativeError = Math.sqrt(errorSq / normSq);
		expect(relativeError).toBeLessThan(0.25); // slightly more generous for smaller dim
	});

	it("should maintain sequence length consistency with Nemotron dims", () => {
		const windowSize = 4;
		const initialLen = 3;

		const prefillKey = makeKvTensor(NEMO_NUM_KV_HEADS, initialLen, NEMO_HEAD_DIM, 1.0);
		const prefillVal = makeKvTensor(NEMO_NUM_KV_HEADS, initialLen, NEMO_HEAD_DIM, 1.0);
		manager.initLayerFromPrefill(12, prefillKey, prefillVal);
		manager.advanceToken(initialLen);

		const extra = 8;
		for (let i = 0; i < extra; i++) {
			const newKey = makeKvTensor(NEMO_NUM_KV_HEADS, 1, NEMO_HEAD_DIM, i * 0.1);
			const newVal = makeKvTensor(NEMO_NUM_KV_HEADS, 1, NEMO_HEAD_DIM, i * 0.1);
			manager.appendAndCompress(12, newKey, newVal);
			manager.advanceToken();
		}

		const result = manager.reconstructLayer(12, FakeTensor as any);
		expect(result).not.toBeNull();
		const expectedTotalSeq = initialLen + extra;
		expect(result!.key.dims).toEqual([1, NEMO_NUM_KV_HEADS, expectedTotalSeq, NEMO_HEAD_DIM]);
	});
});

// ---------------------------------------------------------------------------
// Provider interface compliance
// ---------------------------------------------------------------------------

describe("createNativeGenerationProvider (interface check)", () => {
	// We can't fully test the provider without loading the model,
	// but we can verify the shape of the returned object.

	it("should be importable without side effects", async () => {
		// Dynamically import to verify no immediate model loading
		const mod = await import("./native-generation");
		expect(typeof mod.createNativeGenerationProvider).toBe("function");
		expect(typeof mod.createQwenProvider).toBe("function");
		expect(typeof mod.createNemotronProvider).toBe("function");
		expect(typeof mod.nativeGenerate).toBe("function");
		expect(typeof mod.nativeGenerateWithUsage).toBe("function");
		expect(typeof mod.checkNativeGenerationProvider).toBe("function");
		expect(typeof mod.shutdownNativeGenerationProvider).toBe("function");
		expect(typeof mod.getNativeGenerationStatus).toBe("function");
		expect(typeof mod.DEFAULT_MODEL_ID).toBe("string");
		expect(mod.NATIVE_MODELS).toBeInstanceOf(Map);
	});

	it("should return a Qwen provider with the correct shape (default)", async () => {
		const mod = await import("./native-generation");
		const provider = mod.createNativeGenerationProvider();

		expect(provider.name).toBe("native-qwen3.5-4b");
		expect(typeof provider.generate).toBe("function");
		expect(typeof provider.generateWithUsage).toBe("function");
		expect(typeof provider.available).toBe("function");
	});

	it("should return a Nemotron provider via convenience factory", async () => {
		const mod = await import("./native-generation");
		const provider = mod.createNemotronProvider();

		expect(provider.name).toBe("native-nemotron-3-nano-4b");
		expect(typeof provider.generate).toBe("function");
		expect(typeof provider.generateWithUsage).toBe("function");
		expect(typeof provider.available).toBe("function");
	});

	it("should return a Qwen provider via convenience factory", async () => {
		const mod = await import("./native-generation");
		const provider = mod.createQwenProvider();

		expect(provider.name).toBe("native-qwen3.5-4b");
	});

	it("should return a Nemotron provider via modelId option", async () => {
		const mod = await import("./native-generation");
		const provider = mod.createNativeGenerationProvider({ modelId: "nemotron-3-nano-4b" });

		expect(provider.name).toBe("native-nemotron-3-nano-4b");
	});

	it("should report unavailable before initialization", async () => {
		const mod = await import("./native-generation");
		const status = mod.getNativeGenerationStatus();
		expect(status.initialized).toBe(false);
		expect(status.initializing).toBe(false);
	});

	it("should accept custom generation options in the provider", async () => {
		const mod = await import("./native-generation");
		const provider = mod.createNativeGenerationProvider({
			temperature: 0,
			topP: 1.0,
			maxTokens: 100,
			turboQuantBits: 3,
			residualWindowSize: 64,
		});

		expect(provider.name).toBe("native-qwen3.5-4b");
		// The custom options are baked in — we just verify construction succeeds
	});

	it("should accept custom generation options in the Nemotron provider", async () => {
		const mod = await import("./native-generation");
		const provider = mod.createNemotronProvider({
			temperature: 0.5,
			maxTokens: 512,
			turboQuantBits: 2,
		});

		expect(provider.name).toBe("native-nemotron-3-nano-4b");
	});
});

// ---------------------------------------------------------------------------
// Full_attention layer filtering in multi-layer scenario (Qwen)
// ---------------------------------------------------------------------------

describe("Attention layer selectivity (Qwen)", () => {
	let tqCache: TurboQuantKvCache;
	let manager: KvCacheManager;

	beforeEach(() => {
		const qwenConfig = NATIVE_MODELS.get("qwen3.5-4b")!;
		({ tqCache, manager } = createManagerForModel(qwenConfig));
	});

	it("should initialize state only for attention layers passed to initLayerFromPrefill", () => {
		// Simulate prefill output for all 32 layers
		for (let i = 0; i < QWEN_TOTAL_LAYERS; i++) {
			if (manager.isAttentionLayer(i)) {
				const keyTensor = makeKvTensor(QWEN_NUM_KV_HEADS, 10, QWEN_HEAD_DIM, 1.0);
				const valTensor = makeKvTensor(QWEN_NUM_KV_HEADS, 10, QWEN_HEAD_DIM, 1.0);
				manager.initLayerFromPrefill(i, keyTensor, valTensor);
			}
		}

		// Only attention layers should have state
		for (let i = 0; i < QWEN_TOTAL_LAYERS; i++) {
			const result = manager.reconstructLayer(i, FakeTensor as any);
			if (manager.isAttentionLayer(i)) {
				expect(result).not.toBeNull();
				expect(result!.key.dims[2]).toBe(10);
			} else {
				expect(result).toBeNull();
			}
		}
	});

	it("should apply compression only to attention layers during generation", () => {
		const compressSpy = vi.spyOn(tqCache, "compressVector");

		// Initialize a full_attention layer (3) and exceed window
		const windowSize = RESIDUAL_WINDOW;
		const prefillKey = makeKvTensor(QWEN_NUM_KV_HEADS, windowSize, QWEN_HEAD_DIM, 1.0);
		const prefillVal = makeKvTensor(QWEN_NUM_KV_HEADS, windowSize, QWEN_HEAD_DIM, 1.0);
		manager.initLayerFromPrefill(3, prefillKey, prefillVal);
		manager.advanceToken(windowSize);

		// No compression yet since we're exactly at the window
		expect(compressSpy).not.toHaveBeenCalled();

		// Add a new token to layer 3 — should trigger compression
		const newKey = makeKvTensor(QWEN_NUM_KV_HEADS, 1, QWEN_HEAD_DIM, 2.0);
		const newVal = makeKvTensor(QWEN_NUM_KV_HEADS, 1, QWEN_HEAD_DIM, 2.0);
		manager.appendAndCompress(3, newKey, newVal);

		// compressVector called for keys + values × numHeads = 2 × 4 = 8
		// (1 token compressed per head, for both key and value)
		expect(compressSpy).toHaveBeenCalledTimes(QWEN_NUM_KV_HEADS * 2);

		compressSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// Attention layer selectivity (Nemotron)
// ---------------------------------------------------------------------------

describe("Attention layer selectivity (Nemotron)", () => {
	let tqCache: TurboQuantKvCache;
	let manager: KvCacheManager;

	beforeEach(() => {
		const nemoConfig = NATIVE_MODELS.get("nemotron-3-nano-4b")!;
		({ tqCache, manager } = createManagerForModel(nemoConfig));
	});

	it("should initialize state only for Nemotron attention layers", () => {
		// Simulate: only init attention layers
		for (let i = 0; i < NEMO_TOTAL_LAYERS; i++) {
			if (manager.isAttentionLayer(i)) {
				const keyTensor = makeKvTensor(NEMO_NUM_KV_HEADS, 8, NEMO_HEAD_DIM, 1.0);
				const valTensor = makeKvTensor(NEMO_NUM_KV_HEADS, 8, NEMO_HEAD_DIM, 1.0);
				manager.initLayerFromPrefill(i, keyTensor, valTensor);
			}
		}

		// Only 4 attention layers should have state
		let stateCount = 0;
		for (let i = 0; i < NEMO_TOTAL_LAYERS; i++) {
			const result = manager.reconstructLayer(i, FakeTensor as any);
			if (manager.isAttentionLayer(i)) {
				expect(result).not.toBeNull();
				stateCount++;
			} else {
				expect(result).toBeNull();
			}
		}
		expect(stateCount).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
	it("should handle empty prompt tokenization gracefully", () => {
		// sampleToken should still work with minimal logits
		const logits = new Float32Array([0.0]);
		expect(sampleToken(logits, 0.7, 0.9)).toBe(0);
	});

	it("should handle negative logits correctly", () => {
		const logits = new Float32Array([-10.0, -5.0, -1.0, -8.0]);
		// Greedy: should pick index 2 (-1.0 is the highest)
		expect(sampleToken(logits, 0, 0.9)).toBe(2);
	});

	it("should handle all-same logits in greedy mode", () => {
		const logits = new Float32Array([3.0, 3.0, 3.0, 3.0]);
		// With greedy, first index with max value
		expect(sampleToken(logits, 0, 1.0)).toBe(0);
	});

	it("should handle large vocabulary in sampling", () => {
		// Simulate a vocab of 250K (similar to Qwen)
		const vocabSize = 250_000;
		const logits = new Float32Array(vocabSize);
		logits.fill(-100);
		logits[123456] = 10.0; // One dominant token

		const result = sampleToken(logits, 0, 0.9);
		expect(result).toBe(123456);
	});

	it("KvCacheManager should handle zero-length prefill (Qwen)", () => {
		const qwenConfig = NATIVE_MODELS.get("qwen3.5-4b")!;
		const { manager: mgr } = createManagerForModel(qwenConfig);

		// Prefill with zero-length sequence
		const emptyKey = makeKvTensor(QWEN_NUM_KV_HEADS, 0, QWEN_HEAD_DIM, 0);
		const emptyVal = makeKvTensor(QWEN_NUM_KV_HEADS, 0, QWEN_HEAD_DIM, 0);
		mgr.initLayerFromPrefill(3, emptyKey, emptyVal);

		const result = mgr.reconstructLayer(3, FakeTensor as any);
		// Should return null for zero-length
		expect(result).toBeNull();
	});

	it("KvCacheManager should handle zero-length prefill (Nemotron)", () => {
		const nemoConfig = NATIVE_MODELS.get("nemotron-3-nano-4b")!;
		const { manager: mgr } = createManagerForModel(nemoConfig);

		const emptyKey = makeKvTensor(NEMO_NUM_KV_HEADS, 0, NEMO_HEAD_DIM, 0);
		const emptyVal = makeKvTensor(NEMO_NUM_KV_HEADS, 0, NEMO_HEAD_DIM, 0);
		mgr.initLayerFromPrefill(12, emptyKey, emptyVal);

		const result = mgr.reconstructLayer(12, FakeTensor as any);
		expect(result).toBeNull();
	});

	it("KvCacheManager backward compat: constructor without attentionLayerIndices uses Qwen defaults", () => {
		const cache = TurboQuantKvCache.create({
			bits: 4,
			headDim: QWEN_HEAD_DIM,
			numHeads: QWEN_NUM_KV_HEADS,
			residualWindowSize: RESIDUAL_WINDOW,
		});
		// No attentionLayerIndices param — should default to Qwen layers
		const mgr = new KvCacheManager(cache, QWEN_NUM_KV_HEADS, QWEN_HEAD_DIM);

		for (const idx of QWEN_ATTN_LAYERS) {
			expect(mgr.isAttentionLayer(idx)).toBe(true);
		}
		expect(mgr.isAttentionLayer(0)).toBe(false);
		expect(mgr.isAttentionLayer(12)).toBe(false);
	});
});
