/// RaBitQ napi-rs bindings — JS-facing functions for building indices and searching.
///
/// All data crosses the FFI boundary as Buffer (opaque bytes) to minimize
/// serialization overhead. The compressed index is serialized into a single
/// Buffer that JS holds as an opaque handle and passes back for search.
///
/// Performance: a global LRU cache avoids re-deserializing the same index
/// buffer on every search call. The cache is keyed by a blake3 hash of the
/// buffer contents, so callers need not manage handles explicitly.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::Mutex;

use crate::rabitq;

// ---------------------------------------------------------------------------
// Index deserialization cache
// ---------------------------------------------------------------------------

/// Maximum number of deserialized indices to cache in memory.
const INDEX_CACHE_MAX: usize = 8;

struct CacheEntry {
    index: rabitq::CompressedIndex,
    /// Monotonically increasing access counter for LRU eviction.
    last_access: u64,
}

struct IndexCache {
    entries: HashMap<[u8; 32], CacheEntry>,
    access_counter: u64,
}

impl IndexCache {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            access_counter: 0,
        }
    }

    /// Get or insert a deserialized index, returning a reference via a callback.
    ///
    /// We can't return `&CompressedIndex` across the mutex boundary, so the
    /// caller provides a closure that operates on the borrowed index.
    fn with_index<F, R>(&mut self, data: &[u8], f: F) -> napi::Result<R>
    where
        F: FnOnce(&rabitq::CompressedIndex) -> napi::Result<R>,
    {
        let key = blake3_hash(data);
        self.access_counter += 1;
        let ac = self.access_counter;

        if let Some(entry) = self.entries.get_mut(&key) {
            entry.last_access = ac;
            return f(&entry.index);
        }

        // Deserialize
        let index = rabitq::deserialize_index(data)
            .map_err(|e| napi::Error::from_reason(e))?;

        // Evict LRU if at capacity
        if self.entries.len() >= INDEX_CACHE_MAX {
            let lru_key = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.last_access)
                .map(|(k, _)| *k)
                .unwrap();
            self.entries.remove(&lru_key);
        }

        let result = f(&index);
        // Only cache if the search succeeded — don't store on error
        if result.is_ok() {
            self.entries.insert(
                key,
                CacheEntry {
                    index,
                    last_access: ac,
                },
            );
        }
        result
    }
}

fn blake3_hash(data: &[u8]) -> [u8; 32] {
    // Use a simple FNV-1a style hash stretched to 32 bytes to avoid adding
    // a dependency. For cache keying this is sufficient — collisions just
    // cause a cache miss (correctness is unaffected).
    use sha2::Digest;
    let digest = sha2::Sha256::digest(data);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

static INDEX_CACHE: std::sync::LazyLock<Mutex<IndexCache>> =
    std::sync::LazyLock::new(|| Mutex::new(IndexCache::new()));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Validate that dim > 0, returning a friendly napi error.
#[inline]
fn validate_dim(dim: u32) -> napi::Result<()> {
    if dim == 0 {
        return Err(napi::Error::from_reason(
            "dim must be > 0".to_string(),
        ));
    }
    Ok(())
}

/// Parse a flat f32 buffer into Vec<Vec<f32>> given a known dim.
fn parse_vectors(bytes: &[u8], dim: u32) -> napi::Result<Vec<Vec<f32>>> {
    let dim_usize = dim as usize;
    let float_bytes = dim_usize * 4;

    if bytes.len() % float_bytes != 0 {
        return Err(napi::Error::from_reason(format!(
            "vectors_buf length {} is not a multiple of dim*4 ({})",
            bytes.len(),
            float_bytes
        )));
    }

    let num_vectors = bytes.len() / float_bytes;
    let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(num_vectors);
    for i in 0..num_vectors {
        let base = i * float_bytes;
        let mut vec = Vec::with_capacity(dim_usize);
        for j in 0..dim_usize {
            let offset = base + j * 4;
            let val = f32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ]);
            vec.push(val);
        }
        vectors.push(vec);
    }
    Ok(vectors)
}

// ---------------------------------------------------------------------------
// Rotation Matrix + Codebook generation
// ---------------------------------------------------------------------------

/// Generate a deterministic random orthogonal rotation matrix.
///
/// Returns a Buffer containing dim×dim f32 values in row-major order (little-endian).
#[napi]
pub fn rabitq_generate_rotation_matrix(dim: u32, seed: u32) -> napi::Result<Buffer> {
    validate_dim(dim)?;
    let matrix = rabitq::generate_rotation_matrix(dim as usize, seed);
    let bytes: Vec<u8> = matrix.iter().flat_map(|v| v.to_le_bytes()).collect();
    Ok(Buffer::from(bytes))
}

/// Compute the RaBitQ codebook centroids.
///
/// Returns a Buffer containing 2^bits f32 values (little-endian).
#[napi]
pub fn rabitq_compute_codebook(bits: u32, dim: u32) -> napi::Result<Buffer> {
    validate_dim(dim)?;
    if bits == 0 || bits > 8 {
        return Err(napi::Error::from_reason(format!(
            "bits must be 1..8, got {}",
            bits
        )));
    }
    let codebook = rabitq::compute_codebook(bits, dim);
    let bytes: Vec<u8> = codebook.iter().flat_map(|v| v.to_le_bytes()).collect();
    Ok(Buffer::from(bytes))
}

// ---------------------------------------------------------------------------
// Index Build
// ---------------------------------------------------------------------------

/// Build a compressed RaBitQ index from vectors.
///
/// @param vectors_buf - Buffer of concatenated f32 vectors (little-endian, each dim floats)
/// @param ids - Array of string IDs corresponding to each vector
/// @param bits - Quantization bits per coordinate (typically 4)
/// @param dim - Vector dimensionality
/// @param seed - PRNG seed for rotation matrix
/// @returns Buffer containing the serialized CompressedIndex
#[napi]
pub fn rabitq_build_index(
    vectors_buf: Buffer,
    ids: Vec<String>,
    bits: u32,
    dim: u32,
    seed: u32,
) -> napi::Result<Buffer> {
    validate_dim(dim)?;

    let bytes: &[u8] = &vectors_buf;
    let vectors = parse_vectors(bytes, dim)?;

    if vectors.len() != ids.len() {
        return Err(napi::Error::from_reason(format!(
            "Vector count ({}) must match ID count ({})",
            vectors.len(),
            ids.len()
        )));
    }

    // Generate rotation matrix and codebook
    let rotation_matrix = rabitq::generate_rotation_matrix(dim as usize, seed);
    let codebook = rabitq::compute_codebook(bits, dim);

    // Build index
    let index = rabitq::quantize(&vectors, &ids, &rotation_matrix, &codebook, bits)
        .map_err(|e| napi::Error::from_reason(e))?;

    // Serialize to buffer
    let serialized = rabitq::serialize_index(&index);
    Ok(Buffer::from(serialized))
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/// Search result from compressed search, exported as a JS object.
#[napi(object)]
pub struct RabitqSearchResult {
    pub id: String,
    pub score: f64,
}

/// Search a compressed RaBitQ index for approximate nearest neighbours.
///
/// Uses an internal LRU cache so repeated searches against the same index
/// buffer skip deserialization entirely.
///
/// @param index_buf - Buffer containing the serialized CompressedIndex (from rabitqBuildIndex)
/// @param query - Float32Array query vector
/// @param k - Number of results to return
/// @returns Array of {id, score} sorted by descending score
#[napi]
pub fn rabitq_search(
    index_buf: Buffer,
    query: &[f32],
    k: u32,
) -> napi::Result<Vec<RabitqSearchResult>> {
    let data: &[u8] = &index_buf;
    let query_owned: Vec<f32> = query.to_vec();

    let mut cache = INDEX_CACHE
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Cache lock poisoned: {}", e)))?;

    let results = cache
        .with_index(data, |index| {
            rabitq::compressed_search(&query_owned, index, k as usize)
                .map_err(|e| napi::Error::from_reason(e))
        })?;

    Ok(results
        .into_iter()
        .map(|r| RabitqSearchResult {
            id: r.id,
            score: r.score,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Compress / Decompress individual operations (exposed for flexibility)
// ---------------------------------------------------------------------------

/// Quantize vectors into a compressed index buffer.
///
/// Unlike `rabitqBuildIndex`, this takes pre-computed rotation matrix and codebook
/// buffers, allowing the caller to cache and reuse them.
///
/// @param vectors_buf - Concatenated f32 vectors (little-endian)
/// @param ids - String IDs
/// @param rotation_matrix_buf - Buffer of dim×dim f32 rotation matrix
/// @param codebook_buf - Buffer of 2^bits f32 codebook centroids
/// @param bits - Quantization bits
/// @param dim - Vector dimensionality
/// @returns Serialized CompressedIndex buffer
#[napi]
pub fn rabitq_compress(
    vectors_buf: Buffer,
    ids: Vec<String>,
    rotation_matrix_buf: Buffer,
    codebook_buf: Buffer,
    bits: u32,
    dim: u32,
) -> napi::Result<Buffer> {
    validate_dim(dim)?;

    let vec_bytes: &[u8] = &vectors_buf;
    let rot_bytes: &[u8] = &rotation_matrix_buf;
    let cb_bytes: &[u8] = &codebook_buf;
    let dim_usize = dim as usize;

    // Parse rotation matrix
    let expected_rot_bytes = dim_usize * dim_usize * 4;
    if rot_bytes.len() != expected_rot_bytes {
        return Err(napi::Error::from_reason(format!(
            "rotation_matrix_buf length {} != expected {} (dim={})",
            rot_bytes.len(),
            expected_rot_bytes,
            dim
        )));
    }
    let rotation_matrix: Vec<f32> = (0..dim_usize * dim_usize)
        .map(|i| {
            let o = i * 4;
            f32::from_le_bytes([rot_bytes[o], rot_bytes[o + 1], rot_bytes[o + 2], rot_bytes[o + 3]])
        })
        .collect();

    // Parse codebook
    let num_centroids = (1usize << bits) * 4;
    if cb_bytes.len() != num_centroids {
        return Err(napi::Error::from_reason(format!(
            "codebook_buf length {} != expected {} (bits={})",
            cb_bytes.len(),
            num_centroids,
            bits
        )));
    }
    let codebook: Vec<f32> = (0..(1usize << bits))
        .map(|i| {
            let o = i * 4;
            f32::from_le_bytes([cb_bytes[o], cb_bytes[o + 1], cb_bytes[o + 2], cb_bytes[o + 3]])
        })
        .collect();

    // Parse vectors
    let vectors = parse_vectors(vec_bytes, dim)?;
    if vectors.len() != ids.len() {
        return Err(napi::Error::from_reason(format!(
            "Vector count ({}) must match ID count ({})",
            vectors.len(),
            ids.len()
        )));
    }

    let index = rabitq::quantize(&vectors, &ids, &rotation_matrix, &codebook, bits)
        .map_err(|e| napi::Error::from_reason(e))?;

    Ok(Buffer::from(rabitq::serialize_index(&index)))
}

/// Dequantize (decompress) a compressed index back to approximate vectors.
///
/// @param index_buf - Serialized CompressedIndex buffer
/// @returns Buffer of concatenated f32 vectors (dim floats per vector, little-endian)
#[napi]
pub fn rabitq_decompress(index_buf: Buffer) -> napi::Result<Buffer> {
    let data: &[u8] = &index_buf;
    let index =
        rabitq::deserialize_index(data).map_err(|e| napi::Error::from_reason(e))?;

    let vectors = rabitq::dequantize(&index);
    let dim = index.dim as usize;

    let mut bytes = Vec::with_capacity(vectors.len() * dim * 4);
    for vec in &vectors {
        for &v in vec {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
    }

    Ok(Buffer::from(bytes))
}

/// Get metadata about a serialized compressed index.
#[napi(object)]
pub struct RabitqIndexInfo {
    pub bits: u32,
    pub dim: u32,
    pub count: u32,
    pub codebook_size: u32,
}

#[napi]
pub fn rabitq_index_info(index_buf: Buffer) -> napi::Result<RabitqIndexInfo> {
    let data: &[u8] = &index_buf;
    let index =
        rabitq::deserialize_index(data).map_err(|e| napi::Error::from_reason(e))?;

    Ok(RabitqIndexInfo {
        bits: index.bits,
        dim: index.dim,
        count: index.count,
        codebook_size: index.codebook.len() as u32,
    })
}

/// Brute-force cosine search for ground truth / recall evaluation.
///
/// @param query - Float32Array query vector
/// @param vectors_buf - Concatenated f32 vectors buffer
/// @param ids - String IDs
/// @param dim - Vector dimensionality
/// @param k - Number of results
#[napi]
pub fn rabitq_brute_force_search(
    query: &[f32],
    vectors_buf: Buffer,
    ids: Vec<String>,
    dim: u32,
    k: u32,
) -> napi::Result<Vec<RabitqSearchResult>> {
    validate_dim(dim)?;

    let bytes: &[u8] = &vectors_buf;
    let vectors = parse_vectors(bytes, dim)?;

    if vectors.len() != ids.len() {
        return Err(napi::Error::from_reason(format!(
            "Vector count ({}) must match ID count ({})",
            vectors.len(),
            ids.len()
        )));
    }

    let results = rabitq::brute_force_search(query, &vectors, &ids, k as usize);

    Ok(results
        .into_iter()
        .map(|r| RabitqSearchResult {
            id: r.id,
            score: r.score,
        })
        .collect())
}
