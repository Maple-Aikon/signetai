/// RaBitQ napi-rs bindings — JS-facing functions for building indices and searching.
///
/// All data crosses the FFI boundary as Buffer (opaque bytes) to minimize
/// serialization overhead. The compressed index is serialized into a single
/// Buffer that JS holds as an opaque handle and passes back for search.
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::rabitq;

// ---------------------------------------------------------------------------
// Rotation Matrix + Codebook generation
// ---------------------------------------------------------------------------

/// Generate a deterministic random orthogonal rotation matrix.
///
/// Returns a Buffer containing dim×dim f32 values in row-major order (little-endian).
#[napi]
pub fn rabitq_generate_rotation_matrix(dim: u32, seed: u32) -> Buffer {
    let matrix = rabitq::generate_rotation_matrix(dim as usize, seed);
    let bytes: Vec<u8> = matrix.iter().flat_map(|v| v.to_le_bytes()).collect();
    Buffer::from(bytes)
}

/// Compute the RaBitQ codebook centroids.
///
/// Returns a Buffer containing 2^bits f32 values (little-endian).
#[napi]
pub fn rabitq_compute_codebook(bits: u32, dim: u32) -> Buffer {
    let codebook = rabitq::compute_codebook(bits, dim);
    let bytes: Vec<u8> = codebook.iter().flat_map(|v| v.to_le_bytes()).collect();
    Buffer::from(bytes)
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
    let bytes: &[u8] = &vectors_buf;
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
    if num_vectors != ids.len() {
        return Err(napi::Error::from_reason(format!(
            "Vector count ({}) must match ID count ({})",
            num_vectors,
            ids.len()
        )));
    }

    // Parse vectors from buffer
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

    // Generate rotation matrix and codebook
    let rotation_matrix = rabitq::generate_rotation_matrix(dim_usize, seed);
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
    let index =
        rabitq::deserialize_index(data).map_err(|e| napi::Error::from_reason(e))?;

    let results = rabitq::compressed_search(query, &index, k as usize)
        .map_err(|e| napi::Error::from_reason(e))?;

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
    let vec_bytes: &[u8] = &vectors_buf;
    let rot_bytes: &[u8] = &rotation_matrix_buf;
    let cb_bytes: &[u8] = &codebook_buf;
    let dim_usize = dim as usize;
    let float_bytes = dim_usize * 4;

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
    if vec_bytes.len() % float_bytes != 0 {
        return Err(napi::Error::from_reason(format!(
            "vectors_buf length {} is not a multiple of dim*4 ({})",
            vec_bytes.len(),
            float_bytes
        )));
    }
    let num_vectors = vec_bytes.len() / float_bytes;
    if num_vectors != ids.len() {
        return Err(napi::Error::from_reason(format!(
            "Vector count ({}) must match ID count ({})",
            num_vectors,
            ids.len()
        )));
    }

    let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(num_vectors);
    for i in 0..num_vectors {
        let base = i * float_bytes;
        let mut vec = Vec::with_capacity(dim_usize);
        for j in 0..dim_usize {
            let offset = base + j * 4;
            vec.push(f32::from_le_bytes([
                vec_bytes[offset],
                vec_bytes[offset + 1],
                vec_bytes[offset + 2],
                vec_bytes[offset + 3],
            ]));
        }
        vectors.push(vec);
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
    let bytes: &[u8] = &vectors_buf;
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
    if num_vectors != ids.len() {
        return Err(napi::Error::from_reason(format!(
            "Vector count ({}) must match ID count ({})",
            num_vectors,
            ids.len()
        )));
    }

    let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(num_vectors);
    for i in 0..num_vectors {
        let base = i * float_bytes;
        let mut vec = Vec::with_capacity(dim_usize);
        for j in 0..dim_usize {
            let offset = base + j * 4;
            vec.push(f32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ]));
        }
        vectors.push(vec);
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
