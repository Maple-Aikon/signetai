//! TurboQuant KV Cache Manager — napi-rs exports
//!
//! Provides the napi-rs exported functions for TurboQuant KV cache
//! compression, including the full cache manager with residual window
//! logic (recent tokens in full precision).
//!
//! ## Exported functions
//!
//! - `turboquantCompress(data, config)` — Compress a single vector
//! - `turboquantDecompress(compressed, config)` — Decompress a single vector
//! - `turboquantCreateCache(config)` — Create a new KV cache manager
//! - `turboquantCacheInsert(cache, layerIdx, headIdx, keyVec, valueVec)` — Insert KV pair
//! - `turboquantCacheGet(cache, layerIdx)` — Get all compressed+residual data for a layer
//! - `turboquantCacheAdvance(cache, count)` — Advance the sequence counter
//! - `turboquantCacheReset(cache)` — Reset the cache
//! - `turboquantComputeMemoryStats(...)` — Compute memory statistics
//! - `turboquantShouldCompress(cache, tokenPosition, currentSeqLen)` — Check if token should be compressed

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::turboquant::{CompressedKvEntry, TurboQuantEngine, compute_memory_stats};

// ---------------------------------------------------------------------------
// Config object (passed from JS)
// ---------------------------------------------------------------------------

/// Configuration for TurboQuant KV cache compression.
#[napi(object)]
pub struct TurboQuantConfig {
    /// Bits per coordinate (1-4).
    pub bits: u32,
    /// Head dimension of the model (e.g. 64, 128).
    pub head_dim: u32,
    /// Number of attention heads (key side).
    pub num_heads: u32,
    /// Number of recent tokens to keep in full precision.
    /// Defaults to 128 if not provided.
    pub residual_window_size: Option<u32>,
    /// Random seed for deterministic rotation matrix.
    /// Defaults to 42 if not provided.
    pub seed: Option<u32>,
}

// ---------------------------------------------------------------------------
// Compressed entry object (returned to JS)
// ---------------------------------------------------------------------------

/// A single compressed KV vector returned to JavaScript.
#[napi(object)]
pub struct CompressedKvEntryJs {
    /// Bit-packed quantization codes.
    pub packed_codes: Buffer,
    /// Original L2 norm of the vector.
    pub norm: f64,
    /// Original dimension.
    pub dim: u32,
    /// Bit width used.
    pub bits: u32,
}

impl From<&CompressedKvEntry> for CompressedKvEntryJs {
    fn from(entry: &CompressedKvEntry) -> Self {
        CompressedKvEntryJs {
            packed_codes: entry.packed_codes.clone().into(),
            norm: entry.norm as f64,
            dim: entry.dim as u32,
            bits: entry.bits,
        }
    }
}

// ---------------------------------------------------------------------------
// Per-layer, per-head KV state
// ---------------------------------------------------------------------------

/// Mutable internal representation for efficient append.
struct MutableKvLayer {
    compressed_keys: Vec<CompressedKvEntry>,
    compressed_values: Vec<CompressedKvEntry>,
    residual_keys: Vec<Vec<f32>>,   // per-token full-precision key vectors
    residual_values: Vec<Vec<f32>>, // per-token full-precision value vectors
}

impl MutableKvLayer {
    fn new() -> Self {
        MutableKvLayer {
            compressed_keys: Vec::new(),
            compressed_values: Vec::new(),
            residual_keys: Vec::new(),
            residual_values: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// TurboQuant KV Cache (internal state)
// ---------------------------------------------------------------------------

/// Internal cache state, wrapped in Arc<Mutex<>> for napi external.
pub(crate) struct TurboQuantCacheInner {
    engine: TurboQuantEngine,
    num_heads: usize,
    residual_window_size: usize,
    bits: u32,
    seq_len: usize,
    /// layer_idx -> (head_idx -> MutableKvLayer)
    layers: HashMap<usize, HashMap<usize, MutableKvLayer>>,
}

impl TurboQuantCacheInner {
    fn new(engine: TurboQuantEngine, num_heads: usize, residual_window_size: usize, bits: u32) -> Self {
        TurboQuantCacheInner {
            engine,
            num_heads,
            residual_window_size,
            bits,
            seq_len: 0,
            layers: HashMap::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// napi External wrapper
// ---------------------------------------------------------------------------

/// Opaque handle to a TurboQuant KV cache instance.
/// Passed between JS and Rust as an External<Arc<Mutex<TurboQuantCacheInner>>>.
type CacheHandle = Arc<Mutex<TurboQuantCacheInner>>;

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/// Compress a single float32 vector using TurboQuant.
///
/// @param data - Float32Array as Buffer (little-endian float32 values)
/// @param config - TurboQuant configuration
/// @returns Compressed entry with packed codes, norm, dim, bits
#[napi]
pub fn turboquant_compress(data: Buffer, config: TurboQuantConfig) -> napi::Result<CompressedKvEntryJs> {
    let bits = config.bits;
    if !matches!(bits, 1 | 2 | 3 | 4) {
        return Err(napi::Error::from_reason(format!(
            "Invalid bit width: {}. Must be 1, 2, 3, or 4", bits
        )));
    }
    let head_dim = config.head_dim as usize;
    if head_dim < 2 {
        return Err(napi::Error::from_reason(format!(
            "headDim must be >= 2, got {}", head_dim
        )));
    }
    let seed = config.seed.unwrap_or(42);

    // Parse float32 data from buffer
    let bytes: &[u8] = &data;
    if bytes.len() % 4 != 0 {
        return Err(napi::Error::from_reason(format!(
            "Buffer length {} is not a multiple of 4", bytes.len()
        )));
    }
    let vec = bytes_to_f32_vec(bytes);
    if vec.len() != head_dim {
        return Err(napi::Error::from_reason(format!(
            "Vector length {} != headDim {}", vec.len(), head_dim
        )));
    }

    let engine = TurboQuantEngine::new(head_dim, bits, seed);
    let compressed = engine.compress_vector(&vec);
    Ok(CompressedKvEntryJs::from(&compressed))
}

/// Decompress a single TurboQuant-compressed vector.
///
/// @param compressed - Compressed entry from turboquantCompress
/// @param config - TurboQuant configuration (must match compression config)
/// @returns Float32Array as Buffer
#[napi]
pub fn turboquant_decompress(compressed: CompressedKvEntryJs, config: TurboQuantConfig) -> napi::Result<Buffer> {
    let bits = config.bits;
    let head_dim = config.head_dim as usize;
    let seed = config.seed.unwrap_or(42);

    let engine = TurboQuantEngine::new(head_dim, bits, seed);
    let entry = CompressedKvEntry {
        packed_codes: compressed.packed_codes.to_vec(),
        norm: compressed.norm as f32,
        dim: compressed.dim as usize,
        bits: compressed.bits,
    };
    let vec = engine.decompress_vector(&entry);
    Ok(f32_vec_to_buffer(&vec))
}

/// Create a new TurboQuant KV cache manager.
///
/// Returns an opaque handle that must be passed to all cache operations.
///
/// @param config - Cache configuration
/// @returns External handle to the cache
#[napi]
pub fn turboquant_create_cache(config: TurboQuantConfig) -> napi::Result<External<CacheHandle>> {
    let bits = config.bits;
    if !matches!(bits, 1 | 2 | 3 | 4) {
        return Err(napi::Error::from_reason(format!(
            "Invalid bit width: {}. Must be 1, 2, 3, or 4", bits
        )));
    }
    let head_dim = config.head_dim as usize;
    if head_dim < 2 {
        return Err(napi::Error::from_reason(format!(
            "headDim must be >= 2, got {}", head_dim
        )));
    }
    let num_heads = config.num_heads as usize;
    if num_heads < 1 {
        return Err(napi::Error::from_reason(format!(
            "numHeads must be >= 1, got {}", num_heads
        )));
    }
    let residual_window_size = config.residual_window_size.unwrap_or(128) as usize;
    let seed = config.seed.unwrap_or(42);

    let engine = TurboQuantEngine::new(head_dim, bits, seed);
    let inner = TurboQuantCacheInner::new(engine, num_heads, residual_window_size, bits);
    let handle = Arc::new(Mutex::new(inner));

    Ok(External::new(handle))
}

/// Insert a key-value pair into the cache for a specific layer/head.
///
/// The key and value vectors are provided as Buffers of little-endian
/// float32 values. If the residual window is full, the oldest token(s)
/// are compressed automatically.
///
/// @param cache - Cache handle from turboquantCreateCache
/// @param layer_idx - Layer index
/// @param head_idx - Head index
/// @param key_vec - Key vector as Buffer (float32 LE)
/// @param value_vec - Value vector as Buffer (float32 LE)
#[napi]
pub fn turboquant_cache_insert(
    cache: External<CacheHandle>,
    layer_idx: u32,
    head_idx: u32,
    key_vec: Buffer,
    value_vec: Buffer,
) -> napi::Result<()> {
    let key_data = bytes_to_f32_vec(&key_vec);
    let value_data = bytes_to_f32_vec(&value_vec);

    let mut inner = cache.lock().map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {}", e)))?;

    let head_dim = inner.engine.head_dim;
    if key_data.len() != head_dim {
        return Err(napi::Error::from_reason(format!(
            "Key vector length {} != headDim {}", key_data.len(), head_dim
        )));
    }
    if value_data.len() != head_dim {
        return Err(napi::Error::from_reason(format!(
            "Value vector length {} != headDim {}", value_data.len(), head_dim
        )));
    }
    let num_heads = inner.num_heads;
    if (head_idx as usize) >= num_heads {
        return Err(napi::Error::from_reason(format!(
            "headIdx {} out of range [0, {})", head_idx, num_heads
        )));
    }

    // Read config values before taking mutable borrow on layers
    let residual_window_size = inner.residual_window_size;

    let layer_map = inner.layers.entry(layer_idx as usize).or_insert_with(HashMap::new);
    let kv_layer = layer_map.entry(head_idx as usize).or_insert_with(MutableKvLayer::new);

    // Append to residual window
    kv_layer.residual_keys.push(key_data);
    kv_layer.residual_values.push(value_data);

    // Compress tokens that have fallen outside the residual window
    let to_compress = if kv_layer.residual_keys.len() > residual_window_size {
        kv_layer.residual_keys.len() - residual_window_size
    } else {
        0
    };

    if to_compress > 0 {
        // Collect vectors to compress (clone to avoid borrow conflict with engine)
        let keys_to_compress: Vec<Vec<f32>> = kv_layer.residual_keys[..to_compress].to_vec();
        let vals_to_compress: Vec<Vec<f32>> = kv_layer.residual_values[..to_compress].to_vec();

        // Remove compressed tokens from residual window
        kv_layer.residual_keys.drain(0..to_compress);
        kv_layer.residual_values.drain(0..to_compress);

        // Release the layer borrows so we can access engine
        let _ = kv_layer;
        let _ = layer_map;

        // Compress using engine (no borrow conflict now)
        let mut compressed_keys = Vec::with_capacity(keys_to_compress.len());
        let mut compressed_vals = Vec::with_capacity(vals_to_compress.len());
        for key_vec in &keys_to_compress {
            compressed_keys.push(inner.engine.compress_vector(key_vec));
        }
        for val_vec in &vals_to_compress {
            compressed_vals.push(inner.engine.compress_vector(val_vec));
        }

        // Now push the compressed entries
        let layer_map = inner.layers.get_mut(&(layer_idx as usize)).unwrap();
        let kv_layer = layer_map.get_mut(&(head_idx as usize)).unwrap();
        kv_layer.compressed_keys.extend(compressed_keys);
        kv_layer.compressed_values.extend(compressed_vals);
    }

    Ok(())
}

/// Compressed layer data returned to JavaScript.
#[napi(object)]
pub struct CompressedLayerJs {
    /// Number of compressed tokens.
    pub num_compressed: u32,
    /// Number of residual (full-precision) tokens.
    pub num_residual: u32,
    /// Compressed key entries (array of CompressedKvEntryJs).
    pub compressed_keys: Vec<CompressedKvEntryJs>,
    /// Compressed value entries.
    pub compressed_values: Vec<CompressedKvEntryJs>,
    /// Residual key vectors concatenated as Buffer (float32 LE, headDim per token).
    pub residual_keys: Buffer,
    /// Residual value vectors concatenated as Buffer.
    pub residual_values: Buffer,
}

/// Retrieve all KV data for a specific layer from the cache.
///
/// Returns compressed entries plus residual window vectors for all heads.
/// Heads are interleaved: for each token position, head 0 comes first,
/// then head 1, etc. This matches the [numHeads, seqLen, headDim] layout.
///
/// @param cache - Cache handle
/// @param layer_idx - Layer index
/// @returns Compressed layer data, or null if layer not found
#[napi]
pub fn turboquant_cache_get(
    cache: External<CacheHandle>,
    layer_idx: u32,
) -> napi::Result<Option<CompressedLayerJs>> {
    let inner = cache.lock().map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {}", e)))?;

    let layer_map = match inner.layers.get(&(layer_idx as usize)) {
        Some(m) => m,
        None => return Ok(None),
    };

    if layer_map.is_empty() {
        return Ok(None);
    }

    // Aggregate across heads — use head 0's sizes as reference
    let first_head = match layer_map.get(&0) {
        Some(h) => h,
        None => return Ok(None),
    };

    let num_compressed = first_head.compressed_keys.len();
    let num_residual = first_head.residual_keys.len();
    let head_dim = inner.engine.head_dim;
    let num_heads = inner.num_heads;

    // Collect compressed entries across all heads
    let mut compressed_keys = Vec::with_capacity(num_compressed * num_heads);
    let mut compressed_values = Vec::with_capacity(num_compressed * num_heads);

    for h in 0..num_heads {
        if let Some(kv) = layer_map.get(&h) {
            for entry in &kv.compressed_keys {
                compressed_keys.push(CompressedKvEntryJs::from(entry));
            }
            for entry in &kv.compressed_values {
                compressed_values.push(CompressedKvEntryJs::from(entry));
            }
        }
    }

    // Collect residual vectors — concatenated [numHeads * numResidual * headDim]
    let mut residual_keys_data = Vec::with_capacity(num_heads * num_residual * head_dim * 4);
    let mut residual_values_data = Vec::with_capacity(num_heads * num_residual * head_dim * 4);

    for h in 0..num_heads {
        if let Some(kv) = layer_map.get(&h) {
            for vec in &kv.residual_keys {
                for &v in vec {
                    residual_keys_data.extend_from_slice(&v.to_le_bytes());
                }
            }
            for vec in &kv.residual_values {
                for &v in vec {
                    residual_values_data.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
    }

    Ok(Some(CompressedLayerJs {
        num_compressed: num_compressed as u32,
        num_residual: num_residual as u32,
        compressed_keys,
        compressed_values,
        residual_keys: residual_keys_data.into(),
        residual_values: residual_values_data.into(),
    }))
}

/// Reconstruct a full float32 tensor for a layer from compressed + residual data.
///
/// Returns a Buffer of float32 LE values laid out as
/// [numHeads, totalSeqLen, headDim] for both keys and values.
///
/// @param cache - Cache handle
/// @param layer_idx - Layer index
/// @returns { keys: Buffer, values: Buffer, numHeads: u32, seqLen: u32, headDim: u32 } or null
#[napi(object)]
pub struct ReconstructedLayerJs {
    pub keys: Buffer,
    pub values: Buffer,
    pub num_heads: u32,
    pub seq_len: u32,
    pub head_dim: u32,
}

#[napi]
pub fn turboquant_cache_reconstruct(
    cache: External<CacheHandle>,
    layer_idx: u32,
) -> napi::Result<Option<ReconstructedLayerJs>> {
    let inner = cache.lock().map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {}", e)))?;

    let layer_map = match inner.layers.get(&(layer_idx as usize)) {
        Some(m) => m,
        None => return Ok(None),
    };

    let first_head = match layer_map.get(&0) {
        Some(h) => h,
        None => return Ok(None),
    };

    let num_compressed = first_head.compressed_keys.len();
    let num_residual = first_head.residual_keys.len();
    let total_seq_len = num_compressed + num_residual;

    if total_seq_len == 0 {
        return Ok(None);
    }

    let head_dim = inner.engine.head_dim;
    let num_heads = inner.num_heads;

    let mut key_data = vec![0.0f32; num_heads * total_seq_len * head_dim];
    let mut value_data = vec![0.0f32; num_heads * total_seq_len * head_dim];

    for h in 0..num_heads {
        if let Some(kv) = layer_map.get(&h) {
            let head_offset = h * total_seq_len * head_dim;

            // Decompress compressed tokens
            for t in 0..num_compressed {
                let token_offset = head_offset + t * head_dim;
                let decompressed_key = inner.engine.decompress_vector(&kv.compressed_keys[t]);
                let decompressed_val = inner.engine.decompress_vector(&kv.compressed_values[t]);
                key_data[token_offset..token_offset + head_dim].copy_from_slice(&decompressed_key);
                value_data[token_offset..token_offset + head_dim].copy_from_slice(&decompressed_val);
            }

            // Copy residual tokens
            for t in 0..num_residual {
                let token_offset = head_offset + (num_compressed + t) * head_dim;
                key_data[token_offset..token_offset + head_dim].copy_from_slice(&kv.residual_keys[t]);
                value_data[token_offset..token_offset + head_dim].copy_from_slice(&kv.residual_values[t]);
            }
        }
    }

    Ok(Some(ReconstructedLayerJs {
        keys: f32_vec_to_buffer(&key_data),
        values: f32_vec_to_buffer(&value_data),
        num_heads: num_heads as u32,
        seq_len: total_seq_len as u32,
        head_dim: head_dim as u32,
    }))
}

/// Advance the sequence position counter.
///
/// @param cache - Cache handle
/// @param count - Number of tokens to advance (default 1)
#[napi]
pub fn turboquant_cache_advance(cache: External<CacheHandle>, count: Option<u32>) -> napi::Result<()> {
    let mut inner = cache.lock().map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {}", e)))?;
    inner.seq_len += count.unwrap_or(1) as usize;
    Ok(())
}

/// Reset the cache (e.g., on new generation).
///
/// @param cache - Cache handle
#[napi]
pub fn turboquant_cache_reset(cache: External<CacheHandle>) -> napi::Result<()> {
    let mut inner = cache.lock().map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {}", e)))?;
    inner.layers.clear();
    inner.seq_len = 0;
    Ok(())
}

/// Get the current sequence length.
///
/// @param cache - Cache handle
/// @returns Current sequence length
#[napi]
pub fn turboquant_cache_seq_len(cache: External<CacheHandle>) -> napi::Result<u32> {
    let inner = cache.lock().map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {}", e)))?;
    Ok(inner.seq_len as u32)
}

/// Check whether a token at the given position should be compressed.
///
/// @param cache - Cache handle
/// @param token_position - Position of the token
/// @param current_seq_len - Current total sequence length
/// @returns true if the token should be compressed
#[napi]
pub fn turboquant_should_compress(
    cache: External<CacheHandle>,
    token_position: u32,
    current_seq_len: u32,
) -> napi::Result<bool> {
    let inner = cache.lock().map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {}", e)))?;
    let window_start = (current_seq_len as i64) - (inner.residual_window_size as i64);
    Ok((token_position as i64) < window_start)
}

/// Get cache statistics.
#[napi(object)]
pub struct CacheStatsJs {
    pub seq_len: u32,
    pub num_layers: u32,
    pub bits: u32,
    pub head_dim: u32,
    pub num_heads: u32,
    pub residual_window_size: u32,
    /// Compressed tokens per layer (max across heads).
    pub compressed_tokens_per_layer: u32,
    /// Residual tokens per layer (max across heads).
    pub residual_tokens_per_layer: u32,
}

#[napi]
pub fn turboquant_cache_stats(cache: External<CacheHandle>) -> napi::Result<CacheStatsJs> {
    let inner = cache.lock().map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {}", e)))?;

    let mut compressed_tokens = 0usize;
    let mut residual_tokens = 0usize;

    for (_, layer_map) in &inner.layers {
        for (_, kv) in layer_map {
            compressed_tokens = compressed_tokens.max(kv.compressed_keys.len());
            residual_tokens = residual_tokens.max(kv.residual_keys.len());
        }
    }

    Ok(CacheStatsJs {
        seq_len: inner.seq_len as u32,
        num_layers: inner.layers.len() as u32,
        bits: inner.bits,
        head_dim: inner.engine.head_dim as u32,
        num_heads: inner.num_heads as u32,
        residual_window_size: inner.residual_window_size as u32,
        compressed_tokens_per_layer: compressed_tokens as u32,
        residual_tokens_per_layer: residual_tokens as u32,
    })
}

/// Get the codebook centroids for the cache's configuration.
///
/// @param cache - Cache handle
/// @returns Float32Array as Buffer
#[napi]
pub fn turboquant_cache_codebook(cache: External<CacheHandle>) -> napi::Result<Buffer> {
    let inner = cache.lock().map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {}", e)))?;
    Ok(f32_vec_to_buffer(&inner.engine.codebook))
}

/// Compute memory usage statistics for TurboQuant KV cache compression.
#[napi(object)]
pub struct MemoryStatsJs {
    pub compressed_bytes: f64,
    pub residual_bytes: f64,
    pub total_bytes: f64,
    pub uncompressed_bytes: f64,
    pub compression_ratio: f64,
    pub bits_per_element: f64,
}

#[napi]
pub fn turboquant_compute_memory_stats(
    head_dim: u32,
    bits: u32,
    num_heads: u32,
    num_layers: u32,
    compressed_tokens: u32,
    residual_tokens: u32,
) -> MemoryStatsJs {
    let stats = compute_memory_stats(
        head_dim as usize,
        bits,
        num_heads as usize,
        num_layers as usize,
        compressed_tokens as usize,
        residual_tokens as usize,
    );
    MemoryStatsJs {
        compressed_bytes: stats.compressed_bytes as f64,
        residual_bytes: stats.residual_bytes as f64,
        total_bytes: stats.total_bytes as f64,
        uncompressed_bytes: stats.uncompressed_bytes as f64,
        compression_ratio: stats.compression_ratio,
        bits_per_element: stats.bits_per_element,
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Convert a byte slice of little-endian float32 values to Vec<f32>.
fn bytes_to_f32_vec(bytes: &[u8]) -> Vec<f32> {
    let count = bytes.len() / 4;
    let mut result = Vec::with_capacity(count);
    for i in 0..count {
        let offset = i * 4;
        let value = f32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]);
        result.push(value);
    }
    result
}

/// Convert Vec<f32> to a Buffer of little-endian float32 bytes.
fn f32_vec_to_buffer(vec: &[f32]) -> Buffer {
    let bytes: Vec<u8> = vec.iter().flat_map(|&v| v.to_le_bytes()).collect();
    Buffer::from(bytes)
}
