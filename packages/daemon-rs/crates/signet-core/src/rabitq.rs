//! RaBitQ compressed vector search — daemon-rs stubs.
//!
//! The full RaBitQ implementation lives in `packages/native/src/rabitq.rs`
//! (napi-rs, callable from Node). This module provides Rust-native type
//! definitions and placeholder functions so that daemon-rs crates can
//! reference compressed-search types without depending on napi.
//!
//! When daemon-rs gains its own vector store, these stubs will be replaced
//! with the real implementation (shared via a common `signet-rabitq` crate).

/// Metadata for a single compressed vector.
#[derive(Debug, Clone)]
pub struct CompressedVector {
    pub id: String,
    pub norm: f32,
    pub mean: f32,
    pub max_dev: f32,
    pub codes: Vec<u8>,
}

/// Compressed index holding all quantized vectors and search metadata.
#[derive(Debug, Clone)]
pub struct CompressedIndex {
    pub bits: u32,
    pub dim: u32,
    pub count: u32,
    pub vectors: Vec<CompressedVector>,
    pub codebook: Vec<f32>,
    pub rotation_matrix: Vec<f32>,
}

/// Result from compressed search.
#[derive(Debug, Clone)]
pub struct CompressedSearchResult {
    pub id: String,
    pub score: f64,
}

/// Serialize a `CompressedIndex` to bytes (RBQ v1 format).
///
/// Stub — delegates to the napi implementation at build time;
/// returns an error until the shared crate is wired up.
pub fn serialize_index(_index: &CompressedIndex) -> Result<Vec<u8>, String> {
    Err("rabitq::serialize_index not yet implemented in daemon-rs — use packages/native".into())
}

/// Deserialize a `CompressedIndex` from bytes (RBQ v1 format).
///
/// Stub — returns an error until the shared crate is wired up.
pub fn deserialize_index(_data: &[u8]) -> Result<CompressedIndex, String> {
    Err("rabitq::deserialize_index not yet implemented in daemon-rs — use packages/native".into())
}

/// Compressed approximate nearest-neighbour search.
///
/// Stub — returns an error until the shared crate is wired up.
pub fn compressed_search(
    _query: &[f32],
    _index: &CompressedIndex,
    _top_k: usize,
) -> Result<Vec<CompressedSearchResult>, String> {
    Err("rabitq::compressed_search not yet implemented in daemon-rs — use packages/native".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stubs_return_not_implemented() {
        let idx = CompressedIndex {
            bits: 4,
            dim: 16,
            count: 0,
            vectors: vec![],
            codebook: vec![],
            rotation_matrix: vec![],
        };

        assert!(serialize_index(&idx).is_err());
        assert!(deserialize_index(&[]).is_err());
        assert!(compressed_search(&[], &idx, 10).is_err());
    }
}
