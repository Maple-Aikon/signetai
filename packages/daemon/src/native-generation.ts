/**
 * Native text generation provider — runs ONNX models directly via
 * @huggingface/transformers (WASM runtime) with TurboQuant KV cache
 * compression.
 *
 * Supported models:
 * - **Qwen 3.5 4B** (`qwen3.5-4b`): 32 layers, 8 full_attention + 24
 *   linear_attention. Default model.
 * - **NVIDIA Nemotron 3 Nano 4B** (`nemotron-3-nano-4b`): 42 layers,
 *   4 attention + 23 mamba + 15 MLP. Hybrid Mamba-Attention architecture.
 *
 * Uses a manual token-by-token generation loop (not the built-in
 * `pipeline("text-generation")`) so we can intercept and compress
 * KV cache tensors between forward passes. Only attention layers
 * produce traditional KV cache — those are compressed via TurboQuant
 * while other layers (linear_attention, mamba, MLP) are passed through.
 *
 * Lazy-initialized singleton with mutex-based init to handle
 * concurrent callers during model download. Supports hot-swapping
 * between models (one loaded at a time).
 *
 * @module
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LlmGenerateResult, LlmProvider } from "@signet/core";
import { logger } from "./logger";
import { TurboQuantKvCache } from "./turboquant-cache";
import type { CompressedKvEntry } from "./turboquant-cache";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Selectable native model identifiers. */
export type NativeModelId = "qwen3.5-4b" | "nemotron-3-nano-4b";

/**
 * Configuration for a native ONNX generative model.
 * Abstracts architecture-specific details so the generation loop
 * is model-agnostic.
 */
export interface NativeModelConfig {
	/** Human-readable identifier used in logs and provider name. */
	readonly id: string;
	/** HuggingFace ONNX model repository. */
	readonly onnxId: string;
	/** Quantization dtype for from_pretrained. */
	readonly dtype: "q4f16" | "fp16" | "q8";
	/** Architecture tag for architecture-specific behaviour. */
	readonly architecture: "qwen3_5" | "nemotron_h";
	/**
	 * Layer indices that produce standard KV cache (multi-head attention).
	 * Only these layers participate in TurboQuant compression.
	 * All other layers are passed through (linear_attention, mamba, mlp).
	 */
	readonly attentionLayerIndices: ReadonlySet<number>;
	/** Total number of layers in the model. */
	readonly totalLayers: number;
	/** Dimension of each attention head. */
	readonly headDim: number;
	/** Number of key-value heads (GQA groups). */
	readonly numKvHeads: number;
	/** End-of-sequence token id. */
	readonly eosTokenId: number;
	/** Human-friendly display name for logs. */
	readonly displayName: string;
}

/** Status snapshot returned by {@link checkNativeGenerationProvider}. */
interface NativeGenerationStatus {
	readonly available: boolean;
	readonly error?: string;
	readonly modelId: string;
	readonly modelCached: boolean;
}

/** Lightweight snapshot returned by {@link getNativeGenerationStatus}. */
interface NativeGenerationSnapshot {
	readonly initialized: boolean;
	readonly initializing: boolean;
	readonly modelCached: boolean;
}

/** Options for the generation call. */
export interface NativeGenerateOptions {
	/** Maximum number of tokens to generate. @default 2048 */
	readonly maxTokens?: number;
	/** Abort after this many milliseconds. @default 120000 */
	readonly timeoutMs?: number;
	/** Sampling temperature. 0 = greedy. @default 0.7 */
	readonly temperature?: number;
	/** Nucleus sampling cutoff. @default 0.9 */
	readonly topP?: number;
	/** TurboQuant bit width for KV cache compression (1-4). @default 4 */
	readonly turboQuantBits?: 1 | 2 | 3 | 4;
	/** Number of recent tokens to keep uncompressed. @default 128 */
	readonly residualWindowSize?: number;
	/** Which native model to use. @default "qwen3.5-4b" */
	readonly modelId?: NativeModelId;
}

/** Progress information from transformers.js model download. */
interface ProgressInfo {
	readonly status: string;
	readonly progress?: number;
	readonly file?: string;
}

/**
 * Minimal tensor interface matching what transformers.js ONNX models
 * produce. The actual Tensor class comes from the dynamic import, but
 * we define this narrow contract for type safety.
 *
 * Note: `data` is typed as Float32Array for the common case (model outputs).
 * For int64 inputs (input_ids, attention_mask, position_ids) we cast
 * BigInt64Array via `as unknown as Float32Array` — transformers.js
 * accepts both at runtime.
 */
interface OnnxTensor {
	readonly data: Float32Array;
	readonly dims: readonly number[];
	dispose?: () => void;
}

/** Constructor for creating new tensors.
 *  Accepts Float32Array for float32 or BigInt64Array (cast) for int64. */
interface TensorConstructor {
	new (type: string, data: Float32Array, dims: readonly number[]): OnnxTensor;
}

/**
 * The transformers.js bindings we need for generation — broader than
 * the embedding provider since we load model + tokenizer separately.
 */
interface GenerationBindings {
	readonly env: Record<string, unknown>;
	readonly AutoModelForCausalLM: {
		from_pretrained(
			model: string,
			opts: {
				dtype?: string;
				progress_callback?: (p: ProgressInfo) => void;
			},
		): Promise<CausalLMModel>;
	};
	readonly AutoTokenizer: {
		from_pretrained(model: string): Promise<Tokenizer>;
	};
	readonly Tensor: TensorConstructor;
}

/** Narrow interface for the loaded causal LM. */
interface CausalLMModel {
	(inputs: Record<string, OnnxTensor>): Promise<CausalLMOutput>;
	dispose?: () => Promise<void>;
	config?: Record<string, unknown>;
}

/** Output from a single forward pass. */
interface CausalLMOutput {
	readonly logits: OnnxTensor;
	readonly past_key_values?: PastKeyValues;
}

/**
 * past_key_values shape from transformers.js ONNX:
 * Array of layers, each containing { key: Tensor, value: Tensor }
 * with shape [batch, num_kv_heads, seq_len, head_dim].
 *
 * For hybrid architectures (Nemotron-H), non-attention layers may
 * contain Mamba SSM state (plain Tensor) or null (MLP layers).
 */
type PastKeyValues = ReadonlyArray<
	| { readonly key: OnnxTensor; readonly value: OnnxTensor }
	| OnnxTensor
	| null
>;

/** Tokenizer interface (subset of transformers.js AutoTokenizer). */
interface Tokenizer {
	(text: string, opts?: { return_tensor?: boolean }): {
		input_ids: { data: BigInt64Array; dims: readonly number[] } | BigInt64Array;
	};
	decode(ids: bigint[] | BigInt64Array, opts?: { skip_special_tokens?: boolean }): string;
	encode(text: string): bigint[];
}

// ---------------------------------------------------------------------------
// Model Registry
// ---------------------------------------------------------------------------

/** Default model if none specified. */
export const DEFAULT_MODEL_ID: NativeModelId = "qwen3.5-4b";

/** Registry of all supported native generation models. */
export const NATIVE_MODELS: ReadonlyMap<string, NativeModelConfig> = new Map([
	[
		"qwen3.5-4b",
		{
			id: "qwen3.5-4b",
			onnxId: "onnx-community/Qwen3.5-4B-ONNX",
			dtype: "q4f16",
			architecture: "qwen3_5",
			attentionLayerIndices: new Set([3, 7, 11, 15, 19, 23, 27, 31]),
			totalLayers: 32,
			headDim: 256,
			numKvHeads: 4,
			eosTokenId: 248044,
			displayName: "Qwen 3.5 4B",
		},
	],
	[
		"nemotron-3-nano-4b",
		{
			id: "nemotron-3-nano-4b",
			onnxId: "onnx-community/NVIDIA-Nemotron-3-Nano-4B-BF16-ONNX",
			dtype: "q4f16",
			architecture: "nemotron_h",
			attentionLayerIndices: new Set([12, 17, 24, 32]),
			totalLayers: 42,
			headDim: 128,
			numKvHeads: 8,
			eosTokenId: 2,
			displayName: "Nemotron 3 Nano 4B",
		},
	],
]);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default generation parameters. */
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TOP_P = 0.9;
const DEFAULT_TURBOQUANT_BITS = 4 as const;
const DEFAULT_RESIDUAL_WINDOW = 128;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Type guard for standard attention KV cache entries. */
function isKvEntry(
	entry: unknown,
): entry is { key: OnnxTensor; value: OnnxTensor } {
	return (
		isRecord(entry) &&
		"key" in entry &&
		"value" in entry &&
		isRecord(entry.key) &&
		isRecord(entry.value) &&
		"data" in (entry.key as Record<string, unknown>) &&
		"dims" in (entry.key as Record<string, unknown>)
	);
}

/** Best-effort dispose of an OnnxTensor to free ONNX runtime memory. */
function disposeTensor(tensor: OnnxTensor | null | undefined): void {
	if (tensor && typeof tensor.dispose === "function") {
		try {
			tensor.dispose();
		} catch {
			// best-effort — some tensors may already be disposed
		}
	}
}

/**
 * Dispose all tensors in a past_key_values array.
 *
 * @param pastKv - The past_key_values array to dispose
 * @param attentionOnly - If true, only dispose attention KV entries
 *   (not Mamba SSM state or other non-attention tensors). Use this
 *   during generation cleanup when non-attention state is still
 *   referenced by the ONNX runtime.
 * @param attentionIndices - Set of layer indices that are attention
 *   layers (required when attentionOnly=true).
 */
function disposePastKv(
	pastKv: PastKeyValues | undefined,
	attentionOnly = false,
	attentionIndices?: ReadonlySet<number>,
): void {
	if (!pastKv) return;
	for (let i = 0; i < pastKv.length; i++) {
		const entry = pastKv[i];
		if (isKvEntry(entry)) {
			if (!attentionOnly || attentionIndices?.has(i)) {
				disposeTensor(entry.key);
				disposeTensor(entry.value);
			}
		} else if (!attentionOnly && entry && isRecord(entry) && "data" in entry) {
			// Mamba SSM state or other non-attention tensor — only dispose
			// during full cleanup (not mid-generation).
			disposeTensor(entry as OnnxTensor);
		}
	}
}

// ---------------------------------------------------------------------------
// TransformersBindings loader (mirrors native-embedding.ts pattern)
// ---------------------------------------------------------------------------

function readGenerationBindings(value: unknown): GenerationBindings | null {
	if (!isRecord(value)) return null;
	const env = value.env;
	const autoModel = value.AutoModelForCausalLM;
	const autoTok = value.AutoTokenizer;
	const tensorCtor = value.Tensor;
	if (
		!isRecord(env) ||
		!isRecord(autoModel) ||
		typeof (autoModel as Record<string, unknown>).from_pretrained !== "function" ||
		!isRecord(autoTok) ||
		typeof (autoTok as Record<string, unknown>).from_pretrained !== "function" ||
		typeof tensorCtor !== "function"
	) {
		return null;
	}
	return value as unknown as GenerationBindings;
}

/**
 * Dynamically load @huggingface/transformers with the same candidate
 * ladder used by native-embedding.ts (bundled runtime → npm package →
 * web runtime).
 */
async function loadGenerationBindings(): Promise<GenerationBindings> {
	const importBySpecifier = (specifier: string): Promise<unknown> => {
		return import(specifier);
	};

	const resolveImportMetaSpecifier = (specifier: string): string => {
		const resolver = Reflect.get(import.meta, "resolve");
		if (typeof resolver !== "function") {
			throw new Error("import.meta.resolve is not available");
		}
		return String(Reflect.apply(resolver, import.meta, [specifier]));
	};

	const loadTransformersWebRuntime = async (): Promise<unknown> => {
		const packageJsonUrl = resolveImportMetaSpecifier(
			"@huggingface/transformers/package.json",
		);
		const packageJsonPath = fileURLToPath(packageJsonUrl);
		const webRuntimePath = join(
			dirname(packageJsonPath),
			"dist",
			"transformers.web.js",
		);
		return import(pathToFileURL(webRuntimePath).href);
	};

	const importCandidates: ReadonlyArray<{
		readonly source: string;
		readonly load: () => Promise<unknown>;
	}> = [
		{
			source: "bundled runtime",
			load: () => import("./transformers-runtime"),
		},
		{
			source: "@huggingface/transformers",
			load: () => importBySpecifier("@huggingface/transformers"),
		},
		{
			source: "@huggingface/transformers dist web runtime",
			load: () => loadTransformersWebRuntime(),
		},
	];

	const failures: string[] = [];

	for (const candidate of importCandidates) {
		let mod: unknown;
		try {
			mod = await candidate.load();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			failures.push(`${candidate.source}: ${message}`);
			continue;
		}

		const direct = readGenerationBindings(mod);
		if (direct !== null) return direct;

		if (isRecord(mod) && "default" in mod) {
			const fromDefault = readGenerationBindings(mod.default);
			if (fromDefault !== null) return fromDefault;
		}

		failures.push(
			`${candidate.source}: unsupported export shape (missing AutoModelForCausalLM/AutoTokenizer/Tensor)`,
		);
	}

	throw new Error(
		`Failed to load @huggingface/transformers for generation: ${failures.join("; ")}`,
	);
}

// ---------------------------------------------------------------------------
// Sampling utilities
// ---------------------------------------------------------------------------

/**
 * Sample a token index from logits using temperature + top-p (nucleus)
 * sampling. Returns the chosen token index.
 *
 * @param logits - Raw logits array (vocab-sized)
 * @param temperature - Sampling temperature. 0 = greedy argmax.
 * @param topP - Nucleus sampling probability cutoff.
 */
export function sampleToken(
	logits: Float32Array,
	temperature: number,
	topP: number,
): number {
	const vocabSize = logits.length;

	// Greedy: return argmax
	if (temperature <= 0) {
		let maxIdx = 0;
		let maxVal = logits[0];
		for (let i = 1; i < vocabSize; i++) {
			if (logits[i] > maxVal) {
				maxVal = logits[i];
				maxIdx = i;
			}
		}
		return maxIdx;
	}

	// Temperature scaling
	const scaled = new Float32Array(vocabSize);
	let maxLogit = -Infinity;
	for (let i = 0; i < vocabSize; i++) {
		scaled[i] = logits[i] / temperature;
		if (scaled[i] > maxLogit) maxLogit = scaled[i];
	}

	// Softmax
	let sumExp = 0;
	for (let i = 0; i < vocabSize; i++) {
		scaled[i] = Math.exp(scaled[i] - maxLogit);
		sumExp += scaled[i];
	}
	for (let i = 0; i < vocabSize; i++) {
		scaled[i] /= sumExp;
	}

	// Top-p filtering: sort by probability descending, keep cumulative ≤ topP
	if (topP < 1.0) {
		// Build index array sorted by probability descending
		const indices = new Uint32Array(vocabSize);
		for (let i = 0; i < vocabSize; i++) indices[i] = i;
		indices.sort((a, b) => scaled[b] - scaled[a]);

		let cumulative = 0;
		let cutoff = vocabSize;
		for (let i = 0; i < vocabSize; i++) {
			cumulative += scaled[indices[i]];
			if (cumulative > topP) {
				cutoff = i + 1;
				break;
			}
		}

		// Zero out everything outside the nucleus
		const kept = new Set<number>();
		for (let i = 0; i < cutoff; i++) kept.add(indices[i]);

		let newSum = 0;
		for (let i = 0; i < vocabSize; i++) {
			if (!kept.has(i)) {
				scaled[i] = 0;
			} else {
				newSum += scaled[i];
			}
		}

		// Renormalize
		if (newSum > 0) {
			for (let i = 0; i < vocabSize; i++) {
				scaled[i] /= newSum;
			}
		}
	}

	// Sample from the distribution
	const r = Math.random();
	let cumulative = 0;
	for (let i = 0; i < vocabSize; i++) {
		cumulative += scaled[i];
		if (r < cumulative) return i;
	}

	// Fallback: return last non-zero
	return vocabSize - 1;
}

// ---------------------------------------------------------------------------
// KV Cache management with TurboQuant
// ---------------------------------------------------------------------------

/**
 * Per-layer compressed KV state tracked across generation steps.
 * For attention layers, old tokens get compressed; recent tokens
 * stay as raw Float32Arrays in the residual window.
 */
interface LayerKvState {
	/** Compressed key vectors per head (tokens outside residual window). */
	readonly compressedKeys: CompressedKvEntry[][];
	/** Compressed value vectors per head (tokens outside residual window). */
	readonly compressedValues: CompressedKvEntry[][];
	/** Residual window key data per head — raw Float32Arrays, one per token. */
	readonly residualKeys: Float32Array[][];
	/** Residual window value data per head — raw Float32Arrays, one per token. */
	readonly residualValues: Float32Array[][];
}

/**
 * Manages compressed + residual KV cache state across all layers
 * during a generation run.
 *
 * Accepts a {@link NativeModelConfig} (or explicit attention layer
 * indices) to determine which layers should be compressed vs passed
 * through.
 */
export class KvCacheManager {
	private readonly _cache: TurboQuantKvCache;
	private readonly _numKvHeads: number;
	private readonly _headDim: number;
	private readonly _residualWindowSize: number;
	/** Set of layer indices that use standard attention KV cache. */
	private readonly _attentionLayerIndices: ReadonlySet<number>;
	/** Map from layer index → per-head KV state. */
	private readonly _layers: Map<number, LayerKvState>;
	private _totalTokens: number;

	constructor(
		cache: TurboQuantKvCache,
		numKvHeads: number,
		headDim: number,
		attentionLayerIndices?: ReadonlySet<number>,
	) {
		this._cache = cache;
		this._numKvHeads = numKvHeads;
		this._headDim = headDim;
		this._residualWindowSize = cache.config.residualWindowSize;
		this._attentionLayerIndices = attentionLayerIndices ??
			// Backward-compat default: Qwen 3.5 4B attention layer indices
			new Set([3, 7, 11, 15, 19, 23, 27, 31]);
		this._layers = new Map();
		this._totalTokens = 0;
	}

	/** Total tokens seen so far. */
	get totalTokens(): number {
		return this._totalTokens;
	}

	/** The underlying TurboQuant cache. */
	get turboQuantCache(): TurboQuantKvCache {
		return this._cache;
	}

	/** The attention layer indices used by this manager. */
	get attentionLayerIndices(): ReadonlySet<number> {
		return this._attentionLayerIndices;
	}

	/**
	 * Check whether a given layer index is an attention layer that
	 * should participate in KV cache compression.
	 */
	isAttentionLayer(layerIdx: number): boolean {
		return this._attentionLayerIndices.has(layerIdx);
	}

	/** Qwen 3.5 4B attention layer indices — hoisted to avoid per-call allocation. */
	private static readonly _QWEN_ATTN_LAYERS = new Set([3, 7, 11, 15, 19, 23, 27, 31]);

	/**
	 * @deprecated Use instance method `isAttentionLayer()` instead.
	 * Kept for backward compatibility — uses Qwen 3.5 4B defaults.
	 */
	static isFullAttentionLayer(layerIdx: number): boolean {
		return KvCacheManager._QWEN_ATTN_LAYERS.has(layerIdx);
	}

	/**
	 * Initialize state tracking for a layer after prefill.
	 * Extracts per-head vectors from the tensor and stores them in
	 * the residual window (nothing compressed yet on first call).
	 */
	initLayerFromPrefill(
		layerIdx: number,
		keyTensor: OnnxTensor,
		valueTensor: OnnxTensor,
	): void {
		const [_batch, tensorNumHeads, seqLen, tensorHeadDim] = keyTensor.dims;

		// Use config-driven values for consistency with appendAndCompress/
		// reconstructLayer.  Log a warning if the tensor shape disagrees
		// (could indicate a model config mismatch).
		const numHeads = this._numKvHeads;
		const headDim = this._headDim;

		if (tensorNumHeads !== numHeads || tensorHeadDim !== headDim) {
			// Non-fatal: the tensor might use different conventions (e.g.
			// broadcasting for GQA).  We trust the config but log for
			// debugging.
			logger.warn(
				"native-generation",
				`KV tensor shape mismatch in layer ${layerIdx}: ` +
					`tensor [heads=${tensorNumHeads}, dim=${tensorHeadDim}] vs ` +
					`config [heads=${numHeads}, dim=${headDim}]`,
			);
		}

		const state: LayerKvState = {
			compressedKeys: Array.from({ length: numHeads }, () => []),
			compressedValues: Array.from({ length: numHeads }, () => []),
			residualKeys: Array.from({ length: numHeads }, () => []),
			residualValues: Array.from({ length: numHeads }, () => []),
		};

		// Extract per-head, per-token vectors — MUST copy (.slice) since the
		// source tensor buffer may be reused/disposed by transformers.js on the
		// next forward pass.  Using a view (new Float32Array(buffer, offset, len))
		// would cause silent data corruption.
		for (let h = 0; h < numHeads; h++) {
			for (let t = 0; t < seqLen; t++) {
				const offset = (h * seqLen + t) * headDim;
				state.residualKeys[h].push(
					keyTensor.data.slice(offset, offset + headDim),
				);
				state.residualValues[h].push(
					valueTensor.data.slice(offset, offset + headDim),
				);
			}
		}

		this._layers.set(layerIdx, state);
	}

	/**
	 * Append a new token's KV entry for a given layer, then compress
	 * any tokens that have fallen outside the residual window.
	 *
	 * @param layerIdx - Layer index (must be an attention layer)
	 * @param keyTensor - Key tensor for the new token [1, numHeads, 1, headDim]
	 * @param valueTensor - Value tensor for the new token [1, numHeads, 1, headDim]
	 */
	appendAndCompress(
		layerIdx: number,
		keyTensor: OnnxTensor,
		valueTensor: OnnxTensor,
	): void {
		let state = this._layers.get(layerIdx);
		if (!state) {
			// First time seeing this layer — initialize empty
			state = {
				compressedKeys: Array.from({ length: this._numKvHeads }, () => []),
				compressedValues: Array.from({ length: this._numKvHeads }, () => []),
				residualKeys: Array.from({ length: this._numKvHeads }, () => []),
				residualValues: Array.from({ length: this._numKvHeads }, () => []),
			};
			this._layers.set(layerIdx, state);
		}

		// Use this._numKvHeads instead of tensor dims[1] for safety —
		// the tensor might report a different head count if the model
		// uses multi-query attention with broadcasting.
		const headDim = this._headDim;
		const numHeads = this._numKvHeads;

		// Append the new token's per-head vectors to the residual window
		for (let h = 0; h < numHeads; h++) {
			const offset = h * headDim;
			state.residualKeys[h].push(
				keyTensor.data.slice(offset, offset + headDim),
			);
			state.residualValues[h].push(
				valueTensor.data.slice(offset, offset + headDim),
			);
		}

		// Compress tokens that have fallen outside the residual window
		const totalPerHead = state.compressedKeys[0].length + state.residualKeys[0].length;
		const windowStart = totalPerHead - this._residualWindowSize;

		if (windowStart > 0) {
			for (let h = 0; h < numHeads; h++) {
				// How many tokens in the residual window need to be moved to compressed
				const toCompress = state.residualKeys[h].length - this._residualWindowSize;
				if (toCompress > 0) {
					for (let i = 0; i < toCompress; i++) {
						// Vectors in the residual window are already owned copies
						// (from .slice() in append), so no need to copy again.
						state.compressedKeys[h].push(this._cache.compressVector(state.residualKeys[h][i]));
						state.compressedValues[h].push(this._cache.compressVector(state.residualValues[h][i]));
					}
					// Remove the compressed tokens from the residual window
					state.residualKeys[h].splice(0, toCompress);
					state.residualValues[h].splice(0, toCompress);
				}
			}
		}
	}

	/**
	 * Advance the total token counter (call once per generated token,
	 * not per layer).
	 */
	advanceToken(count = 1): void {
		this._totalTokens += count;
	}

	/**
	 * Reconstruct a full past_key_values tensor for a layer by
	 * decompressing the compressed region and concatenating with
	 * the residual window.
	 *
	 * **Memory trade-off:** The reconstructed tensor is full float32
	 * for the forward pass. TurboQuant's savings come from the
	 * *persistent* compressed storage between steps (~4 bits/coord),
	 * not the transient reconstruction buffer. Peak memory per step
	 * includes one float32 reconstruction per attention layer, but
	 * the compressed storage (which dominates for long sequences)
	 * remains at ~4 bits/coord.
	 *
	 * @returns Tensors shaped [1, numHeads, totalSeqLen, headDim]
	 */
	reconstructLayer(
		layerIdx: number,
		TensorCtor: TensorConstructor,
	): { key: OnnxTensor; value: OnnxTensor } | null {
		const state = this._layers.get(layerIdx);
		if (!state) return null;

		const numHeads = state.residualKeys.length;
		if (numHeads === 0) return null;

		const headDim = this._headDim;
		const numCompressed = state.compressedKeys[0].length;
		const numResidual = state.residualKeys[0].length;
		const totalSeqLen = numCompressed + numResidual;

		if (totalSeqLen === 0) return null;

		const keyData = new Float32Array(numHeads * totalSeqLen * headDim);
		const valueData = new Float32Array(numHeads * totalSeqLen * headDim);

		for (let h = 0; h < numHeads; h++) {
			const headOffset = h * totalSeqLen * headDim;

			// Decompress the compressed region
			for (let t = 0; t < numCompressed; t++) {
				const tokenOffset = headOffset + t * headDim;
				const decompKey = this._cache.decompressVector(state.compressedKeys[h][t]);
				const decompVal = this._cache.decompressVector(state.compressedValues[h][t]);
				keyData.set(decompKey, tokenOffset);
				valueData.set(decompVal, tokenOffset);
			}

			// Copy the residual window
			for (let t = 0; t < numResidual; t++) {
				const tokenOffset = headOffset + (numCompressed + t) * headDim;
				keyData.set(state.residualKeys[h][t], tokenOffset);
				valueData.set(state.residualValues[h][t], tokenOffset);
			}
		}

		const dims = [1, numHeads, totalSeqLen, headDim] as const;
		return {
			key: new TensorCtor("float32", keyData, dims),
			value: new TensorCtor("float32", valueData, dims),
		};
	}

	/** Reset all state for a new generation. */
	reset(): void {
		this._layers.clear();
		this._totalTokens = 0;
		this._cache.reset();
	}

	/** Get compression stats. */
	getStats(): {
		totalTokens: number;
		compressedLayers: number;
		compressedTokensPerLayer: number;
		residualTokensPerLayer: number;
	} {
		let compressedLayers = 0;
		let compressedTokens = 0;
		let residualTokens = 0;

		for (const [, state] of this._layers) {
			compressedLayers++;
			if (state.compressedKeys.length > 0) {
				compressedTokens = Math.max(compressedTokens, state.compressedKeys[0].length);
			}
			if (state.residualKeys.length > 0) {
				residualTokens = Math.max(residualTokens, state.residualKeys[0].length);
			}
		}

		return {
			totalTokens: this._totalTokens,
			compressedLayers,
			compressedTokensPerLayer: compressedTokens,
			residualTokensPerLayer: residualTokens,
		};
	}
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let model: CausalLMModel | null = null;
let tokenizer: Tokenizer | null = null;
let tensorCtor: TensorConstructor | null = null;
let initPromise: Promise<void> | null = null;
let initError: string | null = null;
let modelCached = false;
/** Tracks which model config is currently loaded. */
let activeModelConfig: NativeModelConfig | null = null;
/**
 * Refcount of in-flight generation calls.  Hot-swapping is blocked
 * while any generation is active to prevent swapping the model out
 * from under an in-progress `runGeneration()`.
 */
let activeGenerations = 0;

// ---------------------------------------------------------------------------
// Cache directory
// ---------------------------------------------------------------------------

function getCacheDir(): string {
	const agentsDir = process.env.SIGNET_PATH || join(homedir(), ".agents");
	return join(agentsDir, ".models");
}

// ---------------------------------------------------------------------------
// Helper: resolve model config from id
// ---------------------------------------------------------------------------

function resolveModelConfig(modelId?: NativeModelId): NativeModelConfig {
	const id = modelId ?? DEFAULT_MODEL_ID;
	const config = NATIVE_MODELS.get(id);
	if (!config) {
		throw new Error(
			`Unknown native model: ${id}. Available: ${[...NATIVE_MODELS.keys()].join(", ")}`,
		);
	}
	return config;
}

// ---------------------------------------------------------------------------
// Lazy init
// ---------------------------------------------------------------------------

/** Tracks which model config is being initialized (set before doInit resolves). */
let pendingModelId: string | null = null;

async function ensureInitialized(modelId?: NativeModelId): Promise<void> {
	const targetConfig = resolveModelConfig(modelId);

	// If a different model is fully loaded, shut down first (hot-swap).
	// Block if there are in-flight generations using the current model.
	if (activeModelConfig && activeModelConfig.id !== targetConfig.id) {
		if (activeGenerations > 0) {
			throw new Error(
				`Cannot hot-swap from ${activeModelConfig.displayName} to ${targetConfig.displayName}: ` +
					`${activeGenerations} generation(s) in progress. Wait for them to complete first.`,
			);
		}
		logger.info(
			"native-generation",
			`Hot-swapping from ${activeModelConfig.displayName} to ${targetConfig.displayName}`,
		);
		await shutdownNativeGenerationProvider();
	}

	// If already initialized with the correct model, done.
	if (model && tokenizer && activeModelConfig?.id === targetConfig.id) return;

	// If an init is already in progress, either join it or wait for it
	// to finish before starting a new one (prevents concurrent doInit).
	if (initPromise) {
		if (pendingModelId === targetConfig.id) {
			// Same model — join the existing init.
			return initPromise;
		}
		// Different model is initializing — wait for it to finish
		// (or fail), then shut it down and start the new one.
		try {
			await initPromise;
		} catch {
			// The pending init failed — that's fine, we'll start fresh.
		}
		// Shut down whatever the previous init loaded (if anything).
		await shutdownNativeGenerationProvider();
	}

	// Start a new init.
	pendingModelId = targetConfig.id;
	initPromise = doInit(targetConfig);
	return initPromise;
}

async function doInit(modelConfig: NativeModelConfig): Promise<void> {
	try {
		initError = null;

		const cacheDir = getCacheDir();
		mkdirSync(cacheDir, { recursive: true });

		const transformers = await loadGenerationBindings();

		// Configure cache directory
		transformers.env.cacheDir = cacheDir;
		transformers.env.allowLocalModels = true;

		logger.info(
			"native-generation",
			`Initializing ${modelConfig.onnxId} (${modelConfig.dtype} quantization)`,
		);
		logger.info("native-generation", `Model cache: ${cacheDir}`);

		// Load tokenizer
		logger.info("native-generation", "Loading tokenizer...");
		tokenizer = await transformers.AutoTokenizer.from_pretrained(modelConfig.onnxId);

		// Load model
		logger.info("native-generation", "Loading model...");
		try {
			const loadedModel = await transformers.AutoModelForCausalLM.from_pretrained(
				modelConfig.onnxId,
				{
					dtype: modelConfig.dtype,
					progress_callback: (progress: ProgressInfo) => {
						if (
							progress.status === "download" &&
							typeof progress.progress === "number"
						) {
							logger.info(
								"native-generation",
								`Downloading ${progress.file ?? "model"}: ${Math.round(progress.progress)}%`,
							);
						} else if (progress.status === "ready") {
							logger.info("native-generation", "Model shard ready");
						}
					},
				},
			);
			model = loadedModel;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Check for unsupported model architecture
			if (
				msg.includes("is not supported") ||
				msg.includes("Unknown model class")
			) {
				const archName =
					modelConfig.architecture === "nemotron_h"
						? "NemotronHForCausalLM (Nemotron-H hybrid Mamba-Attention)"
						: "Qwen3_5ForCausalLM";
				throw new Error(
					`transformers.js does not yet support the ${archName} model architecture. ` +
						`Please update @huggingface/transformers to a version that includes ` +
						`support. Original error: ${msg}`,
				);
			}
			// Also catch the Qwen-specific error pattern for backward compat
			if (msg.includes("Qwen3_5")) {
				throw new Error(
					`transformers.js does not yet support the Qwen3.5 model architecture. ` +
						`Please update @huggingface/transformers to a version that includes ` +
						`Qwen3_5ForConditionalGeneration support. Original error: ${msg}`,
				);
			}
			throw err;
		}

		tensorCtor = transformers.Tensor;
		modelCached = true;
		activeModelConfig = modelConfig;

		const attnCount = modelConfig.attentionLayerIndices.size;
		logger.info(
			"native-generation",
			`Ready — ${modelConfig.displayName} loaded (${attnCount} attention layers ` +
				`with TurboQuant, ${modelConfig.totalLayers} total layers)`,
		);
	} catch (err) {
		initError = err instanceof Error ? err.message : String(err);
		initPromise = null; // allow retry on next call
		logger.error("native-generation", `Init failed: ${initError}`);
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Core generation loop
// ---------------------------------------------------------------------------

/**
 * Create a KvCacheManager configured for the given model.
 */
function createKvManager(
	modelConfig: NativeModelConfig,
	turboQuantBits: 1 | 2 | 3 | 4,
	residualWindowSize: number,
): KvCacheManager {
	const tqCache = TurboQuantKvCache.create({
		bits: turboQuantBits,
		headDim: modelConfig.headDim,
		numHeads: modelConfig.numKvHeads,
		residualWindowSize,
	});

	return new KvCacheManager(
		tqCache,
		modelConfig.numKvHeads,
		modelConfig.headDim,
		modelConfig.attentionLayerIndices,
	);
}

/**
 * Run a complete generation using the manual token-by-token loop with
 * TurboQuant KV cache compression.
 *
 * @param prompt - Input text to generate from
 * @param opts - Generation options
 * @returns The generated text and usage statistics
 */
async function runGeneration(
	prompt: string,
	opts: NativeGenerateOptions = {},
): Promise<LlmGenerateResult> {
	if (!model || !tokenizer || !tensorCtor || !activeModelConfig) {
		throw new Error("Native generation model not initialized");
	}

	const config = activeModelConfig;
	const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
	const topP = opts.topP ?? DEFAULT_TOP_P;
	const turboQuantBits = opts.turboQuantBits ?? DEFAULT_TURBOQUANT_BITS;
	const residualWindowSize = opts.residualWindowSize ?? DEFAULT_RESIDUAL_WINDOW;

	const startTime = Date.now();
	const eosTokenId = BigInt(config.eosTokenId);

	// Create config-driven KV cache manager
	const kvManager = createKvManager(config, turboQuantBits, residualWindowSize);

	// Tokenize
	const encoded = tokenizer(prompt);
	let inputIds: BigInt64Array;
	if (encoded.input_ids instanceof BigInt64Array) {
		inputIds = encoded.input_ids;
	} else if (
		isRecord(encoded.input_ids) &&
		"data" in encoded.input_ids
	) {
		inputIds = (encoded.input_ids as { data: BigInt64Array }).data;
	} else {
		throw new Error("Unexpected tokenizer output format");
	}

	const promptLen = inputIds.length;
	logger.info(
		"native-generation",
		`[${config.displayName}] Prompt tokenized: ${promptLen} tokens, generating up to ${maxTokens} tokens`,
	);

	// Build initial input tensor [1, seqLen] — use BigInt64Array for int64
	// to avoid precision loss for token IDs > 2^24.
	const inputInt64 = new BigInt64Array(promptLen);
	for (let i = 0; i < promptLen; i++) {
		inputInt64[i] = inputIds[i];
	}

	const TensorClass = tensorCtor;
	const generatedTokens: bigint[] = [];
	let pastKv: PastKeyValues | undefined;
	/** Running position counter for position_ids across decode steps. */
	let currentPosition = promptLen;

	activeGenerations++;
	try {  // Ensure cleanup of pastKv + kvManager even on errors

	// --- Step 1: Prefill ---
	const prefillInput: Record<string, OnnxTensor> = {
		input_ids: new TensorClass(
			"int64",
			inputInt64 as unknown as Float32Array, // transformers.js accepts BigInt64Array here
			[1, promptLen],
		),
	};

	// Build attention mask for prefill (int64)
	const prefillMask = new BigInt64Array(promptLen);
	prefillMask.fill(1n);
	prefillInput.attention_mask = new TensorClass(
		"int64",
		prefillMask as unknown as Float32Array,
		[1, promptLen],
	);

	// Build position_ids for prefill [1, seqLen]: 0, 1, 2, ..., seqLen-1
	// Required for models with rotary embeddings (Qwen M-ROPE, Nemotron).
	const prefillPositionIds = new BigInt64Array(promptLen);
	for (let i = 0; i < promptLen; i++) {
		prefillPositionIds[i] = BigInt(i);
	}
	prefillInput.position_ids = new TensorClass(
		"int64",
		prefillPositionIds as unknown as Float32Array,
		[1, promptLen],
	);

	const prefillOutput = await model(prefillInput);
	pastKv = prefillOutput.past_key_values;

	// Initialize KV cache manager from prefill output
	if (pastKv) {
		for (let layerIdx = 0; layerIdx < pastKv.length; layerIdx++) {
			if (kvManager.isAttentionLayer(layerIdx)) {
				const entry = pastKv[layerIdx];
				if (isKvEntry(entry)) {
					kvManager.initLayerFromPrefill(layerIdx, entry.key, entry.value);
				}
			}
			// Non-attention layers (mamba SSM state, MLP null) — pass through
		}
	}
	kvManager.advanceToken(promptLen);

	// Get logits for the last position and sample first token.
	// Use .slice() instead of a buffer view to avoid aliasing issues
	// if transformers.js reuses the underlying ArrayBuffer.
	const prefillLogits = prefillOutput.logits;
	const vocabSize = prefillLogits.dims[prefillLogits.dims.length - 1];
	const lastPosOffset = (promptLen - 1) * vocabSize;
	const lastLogits = prefillLogits.data.slice(lastPosOffset, lastPosOffset + vocabSize);

	// Dispose prefill logits — we've extracted what we need via .slice().
	// The prefill KV tensors for attention layers have been copied into
	// KvCacheManager; non-attention layer KV is still referenced via pastKv.
	disposeTensor(prefillOutput.logits);

	// Respect maxTokens=0 — skip generation entirely
	if (maxTokens <= 0) {
		return {
			text: "",
			usage: {
				inputTokens: promptLen,
				outputTokens: 0,
				cacheReadTokens: null,
				cacheCreationTokens: null,
				totalCost: null,
				totalDurationMs: Date.now() - startTime,
			},
		};
	}

	let nextTokenIdx = sampleToken(lastLogits, temperature, topP);
	let nextTokenId = BigInt(nextTokenIdx);

	if (nextTokenId === eosTokenId) {
		// Model immediately produced EOS — finally block handles cleanup
		return {
			text: "",
			usage: {
				inputTokens: promptLen,
				outputTokens: 0,
				cacheReadTokens: null,
				cacheCreationTokens: null,
				totalCost: null,
				totalDurationMs: Date.now() - startTime,
			},
		};
	}

	generatedTokens.push(nextTokenId);

	// --- Step 2: Decode loop ---
	for (let step = 1; step < maxTokens; step++) {
		// Check timeout
		if (Date.now() - startTime > timeoutMs) {
			logger.warn(
				"native-generation",
				`Generation timed out after ${step} tokens (${timeoutMs}ms)`,
			);
			break;
		}

		// Build single-token input (int64 via BigInt64Array)
		const stepInput: Record<string, OnnxTensor> = {
			input_ids: new TensorClass(
				"int64",
				new BigInt64Array([nextTokenId]) as unknown as Float32Array,
				[1, 1],
			),
		};

		// Attention mask: when using past_key_values the model only needs
		// the mask for the NEW tokens (length 1).  The ONNX runtime
		// infers the cached token count from past_key_values shape.
		// This avoids a growing O(seqLen) allocation every step.
		stepInput.attention_mask = new TensorClass(
			"int64",
			new BigInt64Array([1n]) as unknown as Float32Array,
			[1, 1],
		);

		// position_ids for this decode step — must be the correct absolute
		// position, not 0, so rotary embeddings compute the right frequencies.
		stepInput.position_ids = new TensorClass(
			"int64",
			new BigInt64Array([BigInt(currentPosition)]) as unknown as Float32Array,
			[1, 1],
		);

		// Reconstruct past_key_values:
		// - Attention layers: reconstruct from compressed + residual
		// - Mamba/linear_attention/MLP layers: pass through unchanged
		if (pastKv) {
			const reconstructed: Array<
				| { key: OnnxTensor; value: OnnxTensor }
				| OnnxTensor
				| null
			> = [];
			for (let layerIdx = 0; layerIdx < pastKv.length; layerIdx++) {
				const entry = pastKv[layerIdx];
				if (kvManager.isAttentionLayer(layerIdx) && isKvEntry(entry)) {
					const layer = kvManager.reconstructLayer(layerIdx, TensorClass);
					if (layer) {
						reconstructed.push(layer);
					} else {
						// Fallback: pass original
						reconstructed.push(entry);
					}
				} else {
					// Non-attention: mamba SSM state (Tensor), MLP (null),
					// or linear_attention — pass through unchanged
					reconstructed.push(entry as { key: OnnxTensor; value: OnnxTensor } | OnnxTensor | null);
				}
			}
			// transformers.js models accept past_key_values as a direct property
			// on the input object (not as a Tensor).
			(stepInput as Record<string, unknown>).past_key_values = reconstructed;
		}

		// Capture the reconstructed KV tensors we created so we can
		// dispose them AFTER the forward pass consumes them.
		const reconstructedToDispose: OnnxTensor[] = [];
		if ("past_key_values" in (stepInput as Record<string, unknown>)) {
			const inputKv = (stepInput as Record<string, unknown>).past_key_values as PastKeyValues;
			if (inputKv) {
				for (let i = 0; i < inputKv.length; i++) {
					if (kvManager.isAttentionLayer(i) && isKvEntry(inputKv[i])) {
						const kv = inputKv[i] as { key: OnnxTensor; value: OnnxTensor };
						reconstructedToDispose.push(kv.key, kv.value);
					}
				}
			}
		}

		// Forward pass
		const stepOutput = await model(stepInput);

		// NOW dispose the reconstructed input tensors — the forward pass
		// has consumed them and produced new outputs.
		for (const t of reconstructedToDispose) {
			disposeTensor(t);
		}

		// Update KV cache from the new output
		if (stepOutput.past_key_values) {
			for (let layerIdx = 0; layerIdx < stepOutput.past_key_values.length; layerIdx++) {
				if (kvManager.isAttentionLayer(layerIdx)) {
					const kvLayer = stepOutput.past_key_values[layerIdx];
					if (!isKvEntry(kvLayer)) continue;

					// The output has the full sequence; extract only the last position
					const seqLen = kvLayer.key.dims[2];
					const headDim = kvLayer.key.dims[3];
					const numHeads = kvLayer.key.dims[1];

					// Create tensors for just the last token
					const lastKeyData = new Float32Array(numHeads * headDim);
					const lastValData = new Float32Array(numHeads * headDim);

					for (let h = 0; h < numHeads; h++) {
						const srcOffset = (h * seqLen + (seqLen - 1)) * headDim;
						const dstOffset = h * headDim;
						lastKeyData.set(
							kvLayer.key.data.slice(srcOffset, srcOffset + headDim),
							dstOffset,
						);
						lastValData.set(
							kvLayer.value.data.slice(srcOffset, srcOffset + headDim),
							dstOffset,
						);
					}

					const lastKeyTensor = new TensorClass(
						"float32",
						lastKeyData,
						[1, numHeads, 1, headDim],
					);
					const lastValTensor = new TensorClass(
						"float32",
						lastValData,
						[1, numHeads, 1, headDim],
					);

					kvManager.appendAndCompress(layerIdx, lastKeyTensor, lastValTensor);

					// Dispose the temporary single-token tensors — appendAndCompress
					// has already .slice()'d the data it needs into owned copies.
					disposeTensor(lastKeyTensor);
					disposeTensor(lastValTensor);
				}
			}

			// Dispose old attention KV tensors from the previous pastKv
			// before overwriting the reference.  Non-attention layer
			// tensors (mamba SSM state) are managed by the ONNX runtime
			// and may be reused — only dispose attention entries we've
			// fully consumed into KvCacheManager.
			if (pastKv) {
				for (let i = 0; i < pastKv.length; i++) {
					if (kvManager.isAttentionLayer(i) && isKvEntry(pastKv[i])) {
						const old = pastKv[i] as { key: OnnxTensor; value: OnnxTensor };
						disposeTensor(old.key);
						disposeTensor(old.value);
					}
				}
			}

			// Keep reference to the full output for non-attention layers
			pastKv = stepOutput.past_key_values;
		}

		kvManager.advanceToken();
		currentPosition++;

		// Sample next token from the last logit position.
		// Use .slice() for safety (avoid buffer aliasing).
		const stepLogits = stepOutput.logits;
		const stepVocabSize = stepLogits.dims[stepLogits.dims.length - 1];
		// For single-token input, logits shape is [1, 1, vocabSize]
		const tokenLogits = stepLogits.data.slice(0, stepVocabSize);

		// Dispose step logits after extraction
		disposeTensor(stepLogits);

		nextTokenIdx = sampleToken(tokenLogits, temperature, topP);
		nextTokenId = BigInt(nextTokenIdx);

		if (nextTokenId === eosTokenId) {
			break;
		}

		generatedTokens.push(nextTokenId);

		// Periodic logging
		if (step % 100 === 0) {
			const stats = kvManager.getStats();
			logger.info(
				"native-generation",
				`[${config.displayName}] Step ${step}: ${generatedTokens.length} tokens generated, ` +
					`compressed=${stats.compressedTokensPerLayer}, ` +
					`residual=${stats.residualTokensPerLayer}`,
			);
		}
	}

	// Decode output
	const outputText = tokenizer.decode(
		new BigInt64Array(generatedTokens),
		{ skip_special_tokens: true },
	);

	const elapsed = Date.now() - startTime;
	const stats = kvManager.getStats();

	logger.info(
		"native-generation",
		`[${config.displayName}] Generation complete: ${generatedTokens.length} tokens in ${elapsed}ms ` +
			`(${((generatedTokens.length / elapsed) * 1000).toFixed(1)} tok/s), ` +
			`KV compressed=${stats.compressedTokensPerLayer} residual=${stats.residualTokensPerLayer}`,
	);

	return {
		text: outputText,
		usage: {
			inputTokens: promptLen,
			outputTokens: generatedTokens.length,
			cacheReadTokens: null,
			cacheCreationTokens: null,
			totalCost: null,
			totalDurationMs: elapsed,
		},
	};

	} finally {
		// Guaranteed cleanup — dispose remaining KV tensors and reset
		// manager even if a forward pass or tensor operation throws.
		activeGenerations = Math.max(0, activeGenerations - 1);
		disposePastKv(pastKv);
		pastKv = undefined;
		kvManager.reset();
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate text using a native ONNX model with TurboQuant KV cache
 * compression.
 *
 * Lazily initializes the model on first call.
 *
 * @param prompt - Input text prompt
 * @param opts - Generation options (temperature, maxTokens, modelId, etc.)
 * @returns Generated text string
 */
export async function nativeGenerate(
	prompt: string,
	opts?: NativeGenerateOptions,
): Promise<string> {
	await ensureInitialized(opts?.modelId);
	const result = await runGeneration(prompt, opts);
	return result.text;
}

/**
 * Generate text with full usage statistics.
 *
 * @param prompt - Input text prompt
 * @param opts - Generation options
 * @returns Generated text + usage info
 */
export async function nativeGenerateWithUsage(
	prompt: string,
	opts?: NativeGenerateOptions,
): Promise<LlmGenerateResult> {
	await ensureInitialized(opts?.modelId);
	return runGeneration(prompt, opts);
}

/**
 * Create an {@link LlmProvider} backed by a native ONNX model with
 * TurboQuant compression.
 *
 * @param opts - Default generation options applied to all calls
 *               (including modelId to select which model)
 * @returns An LlmProvider instance
 */
export function createNativeGenerationProvider(
	opts?: NativeGenerateOptions,
): LlmProvider {
	const defaults = opts ?? {};
	const modelId = defaults.modelId ?? DEFAULT_MODEL_ID;
	const providerName = `native-${modelId}`;

	return {
		name: providerName,

		async generate(
			prompt: string,
			callOpts?: { timeoutMs?: number; maxTokens?: number },
		): Promise<string> {
			return nativeGenerate(prompt, {
				...defaults,
				...(callOpts ?? {}),
			});
		},

		async generateWithUsage(
			prompt: string,
			callOpts?: { timeoutMs?: number; maxTokens?: number },
		): Promise<LlmGenerateResult> {
			return nativeGenerateWithUsage(prompt, {
				...defaults,
				...(callOpts ?? {}),
			});
		},

		async available(): Promise<boolean> {
			try {
				await ensureInitialized(modelId);
				return true;
			} catch {
				return false;
			}
		},
	};
}

/**
 * Convenience factory for a Qwen 3.5 4B provider.
 */
export function createQwenProvider(
	opts?: Omit<NativeGenerateOptions, "modelId">,
): LlmProvider {
	return createNativeGenerationProvider({ ...opts, modelId: "qwen3.5-4b" });
}

/**
 * Convenience factory for a Nemotron 3 Nano 4B provider.
 */
export function createNemotronProvider(
	opts?: Omit<NativeGenerateOptions, "modelId">,
): LlmProvider {
	return createNativeGenerationProvider({ ...opts, modelId: "nemotron-3-nano-4b" });
}

/**
 * Check whether the native generation provider is available and
 * the model is loaded.
 */
export async function checkNativeGenerationProvider(): Promise<NativeGenerationStatus> {
	// Passive check — does NOT call ensureInitialized() to avoid
	// accidentally hot-swapping the active model just by probing status.
	const currentId = activeModelConfig?.id ?? DEFAULT_MODEL_ID;
	const isReady = model !== null && tokenizer !== null;
	return {
		available: isReady,
		error: isReady ? undefined : (initError ?? "Native generation provider not initialized"),
		modelId: currentId,
		modelCached,
	};
}

/**
 * Shut down the native generation provider and release resources.
 */
export async function shutdownNativeGenerationProvider(): Promise<void> {
	if (model) {
		if (typeof model.dispose === "function") {
			try {
				await model.dispose();
			} catch {
				// best-effort
			}
		}
		model = null;
		tokenizer = null;
		tensorCtor = null;
		initPromise = null;
		initError = null;
		modelCached = false;
		activeModelConfig = null;
		pendingModelId = null;
		activeGenerations = 0;
		logger.info("native-generation", "Provider shut down");
	}
}

/**
 * Get a lightweight snapshot of the provider's current state
 * (non-async, no side effects).
 */
export function getNativeGenerationStatus(): NativeGenerationSnapshot {
	return {
		initialized: model !== null && tokenizer !== null,
		initializing: initPromise !== null && model === null,
		modelCached,
	};
}
