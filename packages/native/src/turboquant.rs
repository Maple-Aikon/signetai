//! TurboQuant KV Cache Compression — Core Algorithm
//!
//! Pure Rust implementation of Google's TurboQuant algorithm
//! (arXiv:2504.19874, ICLR 2026) adapted for KV cache compression
//! in local generative model inference.
//!
//! Compresses key/value cache tensors to 3-4 bits per coordinate with
//! near-zero accuracy loss, enabling ~6x memory reduction for long
//! context windows.
//!
//! ## Algorithm overview
//!
//! 1. Generate a deterministic random rotation matrix via QR decomposition
//! 2. Compute an optimal codebook from the Beta((d-1)/2, (d-1)/2) distribution
//! 3. Quantize: rotate each KV vector, find nearest centroid per coordinate
//! 4. Dequantize: centroid lookup → inverse rotation → rescale by norm
//!
//! The PRNG (xoshiro128**), Householder QR, and Beta distribution codebook
//! are faithful reproductions of the TypeScript implementation, ensuring
//! identical outputs for the same seed.

use std::f64::consts::PI;

// ---------------------------------------------------------------------------
// PRNG — splitmix32 + xoshiro128**
// ---------------------------------------------------------------------------

/// splitmix32 for seed expansion (Fix C from the TS impl).
fn splitmix32(s: u32) -> u32 {
    let mut t = s.wrapping_add(0x9e3779b9);
    t = (t ^ (t >> 16)).wrapping_mul(0x21f0aaad);
    t = (t ^ (t >> 15)).wrapping_mul(0x735a2d97);
    t ^ (t >> 15)
}

/// Seeded xoshiro128** PRNG returning values in [0, 1).
/// Identical to the TypeScript implementation.
pub(crate) struct Xoshiro128ss {
    s0: u32,
    s1: u32,
    s2: u32,
    s3: u32,
}

impl Xoshiro128ss {
    pub fn new(seed: u32) -> Self {
        let s0 = splitmix32(seed);
        let s1 = splitmix32(s0);
        let s2 = splitmix32(s1);
        let s3 = splitmix32(s2);

        let mut rng = Xoshiro128ss { s0, s1, s2, s3 };

        // Warm up (same as TS: 20 iterations)
        for _ in 0..20 {
            rng.advance();
        }

        rng
    }

    /// Advance the internal state without producing output.
    fn advance(&mut self) {
        let t = self.s1 << 9;
        self.s2 ^= self.s0;
        self.s3 ^= self.s1;
        self.s1 ^= self.s2;
        self.s0 ^= self.s3;
        self.s2 ^= t;
        self.s3 = self.s3.rotate_left(11);
    }

    /// Generate the next random f64 in [0, 1).
    pub fn next_f64(&mut self) -> f64 {
        let mul5 = self.s1.wrapping_mul(5);
        let rotl7 = mul5.rotate_left(7);
        let result = rotl7.wrapping_mul(9);
        self.advance();
        (result as f64) / 4294967296.0
    }
}

// ---------------------------------------------------------------------------
// Matrix utilities — random Gaussian, QR, mat-vec
// ---------------------------------------------------------------------------

/// Generate a flat row-major matrix of standard normal samples (Box-Muller).
pub(crate) fn randn_matrix(rows: usize, cols: usize, rng: &mut Xoshiro128ss) -> Vec<f32> {
    let len = rows * cols;
    let mut data = vec![0.0f32; len];

    let mut i = 0;
    while i + 1 < len {
        let u1 = rng.next_f64().max(1e-10);
        let u2 = rng.next_f64();
        let r = (-2.0 * u1.ln()).sqrt();
        let theta = 2.0 * PI * u2;
        data[i] = (r * theta.cos()) as f32;
        data[i + 1] = (r * theta.sin()) as f32;
        i += 2;
    }
    if len % 2 != 0 {
        let u1 = rng.next_f64().max(1e-10);
        let u2 = rng.next_f64();
        data[len - 1] = ((-2.0 * u1.ln()).sqrt() * (2.0 * PI * u2).cos()) as f32;
    }

    data
}

/// QR decomposition via modified Gram-Schmidt.
/// Returns Q (orthogonal) as a flat Vec<f32> (rows × cols, row-major).
pub(crate) fn qr_q(matrix: &[f32], rows: usize, cols: usize) -> Vec<f32> {
    let mut q = matrix.to_vec();

    let get_col = |q: &[f32], c: usize| -> Vec<f32> {
        let mut col = vec![0.0f32; rows];
        for r in 0..rows {
            col[r] = q[r * cols + c];
        }
        col
    };

    let set_col = |q: &mut [f32], c: usize, col: &[f32]| {
        for r in 0..rows {
            q[r * cols + c] = col[r];
        }
    };

    let dot = |a: &[f32], b: &[f32]| -> f64 {
        let mut s = 0.0f64;
        for i in 0..a.len() {
            s += a[i] as f64 * b[i] as f64;
        }
        s
    };

    for j in 0..cols {
        let mut col = get_col(&q, j);

        for k in 0..j {
            let qk = get_col(&q, k);
            let proj = dot(&col, &qk);
            for i in 0..rows {
                col[i] -= (proj * qk[i] as f64) as f32;
            }
        }

        let norm = (dot(&col, &col)).sqrt();
        if norm > 1e-10 {
            let inv_norm = 1.0 / norm;
            for i in 0..rows {
                col[i] = (col[i] as f64 * inv_norm) as f32;
            }
        }

        set_col(&mut q, j, &col);
    }

    q
}

/// Matrix-vector multiply: result = M @ v. M is (rows × cols) row-major.
pub(crate) fn mat_vec_mul(m: &[f32], v: &[f32], rows: usize, cols: usize) -> Vec<f32> {
    let mut result = vec![0.0f32; rows];
    for r in 0..rows {
        let mut sum = 0.0f64;
        let off = r * cols;
        for c in 0..cols {
            sum += m[off + c] as f64 * v[c] as f64;
        }
        result[r] = sum as f32;
    }
    result
}

/// Transpose-multiply: result = M^T @ v. M is (rows × cols) row-major.
pub(crate) fn mat_t_vec_mul(m: &[f32], v: &[f32], rows: usize, cols: usize) -> Vec<f32> {
    let mut result = vec![0.0f32; cols];
    for r in 0..rows {
        let vi = v[r] as f64;
        let off = r * cols;
        for c in 0..cols {
            result[c] = (result[c] as f64 + m[off + c] as f64 * vi) as f32;
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Bit packing utilities
// ---------------------------------------------------------------------------

/// Pack an array of centroid indices into a compact byte vector.
/// For 4-bit: two indices per byte (high nibble, low nibble).
/// For other bit widths: generic bit-stream packing.
pub(crate) fn pack_indices(indices: &[u8], bits: u32) -> Vec<u8> {
    let total_bits = indices.len() * bits as usize;
    let mut packed = vec![0u8; (total_bits + 7) / 8];

    if bits == 4 {
        // Fast path: two indices per byte
        let mut i = 0;
        while i + 1 < indices.len() {
            packed[i >> 1] = (indices[i] << 4) | indices[i + 1];
            i += 2;
        }
        if indices.len() % 2 != 0 {
            let last_idx = packed.len() - 1;
            packed[last_idx] = indices[indices.len() - 1] << 4;
        }
        return packed;
    }

    // Generic bit-stream packing for 1, 2, 3 bit widths
    let mut bit_pos: usize = 0;
    for &val in indices {
        let byte_idx = bit_pos >> 3;
        let bit_offset = bit_pos & 7;
        packed[byte_idx] |= (val << bit_offset) & 0xff;
        if bit_offset as u32 + bits > 8 {
            if byte_idx + 1 < packed.len() {
                packed[byte_idx + 1] |= val >> (8 - bit_offset);
            }
        }
        bit_pos += bits as usize;
    }
    packed
}

/// Unpack centroid indices from a compact byte vector.
/// Inverse of pack_indices.
pub(crate) fn unpack_indices(packed: &[u8], dim: usize, bits: u32) -> Vec<u8> {
    let mut indices = vec![0u8; dim];
    let mask = ((1u16 << bits) - 1) as u8;

    if bits == 4 {
        // Fast path: two indices per byte
        let mut i = 0;
        while i + 1 < dim {
            let byte = packed[i >> 1];
            indices[i] = (byte >> 4) & 0xf;
            indices[i + 1] = byte & 0xf;
            i += 2;
        }
        if dim % 2 != 0 {
            indices[dim - 1] = (packed[packed.len() - 1] >> 4) & 0xf;
        }
        return indices;
    }

    // Generic bit-stream unpacking for 1, 2, 3 bit widths
    let mut bit_pos: usize = 0;
    for i in 0..dim {
        let byte_idx = bit_pos >> 3;
        let bit_offset = bit_pos & 7;
        let mut val = (packed[byte_idx] >> bit_offset) & mask;
        if bit_offset as u32 + bits > 8 {
            if byte_idx + 1 < packed.len() {
                val |= (packed[byte_idx + 1] << (8 - bit_offset)) & mask;
            }
        }
        indices[i] = val;
        bit_pos += bits as usize;
    }
    indices
}

// ---------------------------------------------------------------------------
// Binary search for nearest centroid
// ---------------------------------------------------------------------------

/// Find the nearest centroid index using binary search on a sorted codebook.
pub(crate) fn find_nearest_centroid(value: f32, codebook: &[f32]) -> u8 {
    let mut lo: usize = 0;
    let mut hi: usize = codebook.len() - 1;
    while lo < hi {
        let mid = (lo + hi) >> 1;
        let boundary = (codebook[mid] as f64 + codebook[mid + 1] as f64) / 2.0;
        if (value as f64) <= boundary {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo as u8
}

// ---------------------------------------------------------------------------
// Beta distribution utilities (codebook computation)
// ---------------------------------------------------------------------------

/// Log-gamma via Lanczos approximation.
fn lgamma(x: f64) -> f64 {
    const C: [f64; 9] = [
        0.99999999999980993,
        676.5203681218851,
        -1259.1392167224028,
        771.32342877765313,
        -176.61502916214059,
        12.507343278686905,
        -0.13857109526572012,
        9.9843695780195716e-6,
        1.5056327351493116e-7,
    ];

    if x < 0.5 {
        return (PI / (PI * x).sin()).ln() - lgamma(1.0 - x);
    }
    let xm = x - 1.0;
    let mut a = C[0];
    let t = xm + 7.5;
    for i in 1..9 {
        a += C[i] / (xm + i as f64);
    }
    0.5 * (2.0 * PI).ln() + (xm + 0.5) * t.ln() - t + a.ln()
}

/// Regularized incomplete beta I_x(a, b) via Lentz continued fraction.
fn beta_inc(x: f64, a: f64, b: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    if x > (a + 1.0) / (a + b + 2.0) {
        return 1.0 - beta_inc(1.0 - x, b, a);
    }

    let ln_beta = lgamma(a) + lgamma(b) - lgamma(a + b);
    let front = (x.ln() * a + (1.0 - x).ln() * b - ln_beta).exp() / a;

    let mut d = 1.0 - ((a + b) * x) / (a + 1.0);
    if d.abs() < 1e-30 {
        d = 1e-30;
    }
    d = 1.0 / d;
    let mut f = d;
    let mut c = 1.0;

    for m in 1..=200 {
        let m_f = m as f64;
        // First numerator
        let num1 = (m_f * (b - m_f) * x) / ((a + 2.0 * m_f - 1.0) * (a + 2.0 * m_f));
        d = 1.0 + num1 * d;
        if d.abs() < 1e-30 {
            d = 1e-30;
        }
        c = 1.0 + num1 / c;
        if c.abs() < 1e-30 {
            c = 1e-30;
        }
        d = 1.0 / d;
        f *= c * d;

        // Second numerator
        let num2 = (-(a + m_f) * (a + b + m_f) * x) / ((a + 2.0 * m_f) * (a + 2.0 * m_f + 1.0));
        d = 1.0 + num2 * d;
        if d.abs() < 1e-30 {
            d = 1e-30;
        }
        c = 1.0 + num2 / c;
        if c.abs() < 1e-30 {
            c = 1e-30;
        }
        d = 1.0 / d;
        let delta = c * d;
        f *= delta;
        if (delta - 1.0).abs() < 1e-10 {
            break;
        }
    }

    front * f
}

/// Beta PDF on [0, 1].
fn beta_pdf(x: f64, a: f64, b: f64) -> f64 {
    if x <= 0.0 || x >= 1.0 {
        return 0.0;
    }
    let ln_b = lgamma(a) + lgamma(b) - lgamma(a + b);
    ((a - 1.0) * x.ln() + (b - 1.0) * (1.0 - x).ln() - ln_b).exp()
}

/// Inverse regularized incomplete beta via Newton's method.
fn beta_incinv(a: f64, b: f64, p: f64) -> f64 {
    if p <= 0.0 {
        return 0.0;
    }
    if p >= 1.0 {
        return 1.0;
    }
    let mut x = 0.5;
    for _ in 0..100 {
        let fx = beta_inc(x, a, b) - p;
        if fx.abs() < 1e-12 {
            break;
        }
        let ln_b = lgamma(a) + lgamma(b) - lgamma(a + b);
        let pdf = ((a - 1.0) * (x + 1e-15).ln() + (b - 1.0) * (1.0 - x + 1e-15).ln() - ln_b).exp();
        if pdf < 1e-15 {
            break;
        }
        x = (x - fx / pdf).clamp(1e-10, 1.0 - 1e-10);
    }
    x
}

// ---------------------------------------------------------------------------
// Codebook
// ---------------------------------------------------------------------------

/// Compute the optimal TurboQuant codebook for Beta((d-1)/2, (d-1)/2).
pub(crate) fn compute_codebook(dim: usize, bits: u32) -> Vec<f32> {
    let n_centroids = 1usize << bits;
    let alpha = (dim as f64 - 1.0) / 2.0;

    if bits == 1 {
        let c = (2.0 / (PI * dim as f64)).sqrt();
        return vec![(-c) as f32, c as f32];
    }

    // Compute quantile boundaries
    let mut boundaries = Vec::with_capacity(n_centroids - 1);
    for i in 1..n_centroids {
        let q = beta_incinv(alpha, alpha, i as f64 / n_centroids as f64);
        boundaries.push(2.0 * q - 1.0);
    }

    // Compute centroids as conditional expectations within each quantile bin
    let mut centroids = vec![0.0f32; n_centroids];
    let n_points = 500;

    for i in 0..n_centroids {
        let lower = if i == 0 { -1.0 } else { boundaries[i - 1] };
        let upper = if i < boundaries.len() { boundaries[i] } else { 1.0 };
        let a01 = ((lower + 1.0) / 2.0).max(1e-10);
        let b01 = ((upper + 1.0) / 2.0).min(1.0 - 1e-10);

        let mut sum_x_pdf = 0.0f64;
        let mut sum_pdf = 0.0f64;
        let dx = (b01 - a01) / n_points as f64;

        for j in 0..=n_points {
            let x01 = a01 + j as f64 * dx;
            let pdf = beta_pdf(x01, alpha, alpha);
            let w = if j == 0 || j == n_points { 0.5 } else { 1.0 };
            sum_x_pdf += w * x01 * pdf;
            sum_pdf += w * pdf;
        }

        let exp01 = if sum_pdf > 1e-15 {
            sum_x_pdf / sum_pdf
        } else {
            (a01 + b01) / 2.0
        };
        centroids[i] = (2.0 * exp01 - 1.0) as f32;
    }

    centroids
}

// ---------------------------------------------------------------------------
// Compressed KV entry
// ---------------------------------------------------------------------------

/// A single compressed KV vector (one head, one token).
#[derive(Clone)]
pub struct CompressedKvEntry {
    /// Bit-packed quantization codes.
    pub packed_codes: Vec<u8>,
    /// Original L2 norm of the vector.
    pub norm: f32,
    /// Original dimension (needed for unpacking).
    pub dim: usize,
    /// Bit width used for packing.
    pub bits: u32,
}

// ---------------------------------------------------------------------------
// TurboQuant engine — stateless compress/decompress with precomputed state
// ---------------------------------------------------------------------------

/// Core TurboQuant engine. Precomputes rotation matrix and codebook
/// for a given configuration, then provides compress/decompress operations.
pub struct TurboQuantEngine {
    pub(crate) head_dim: usize,
    pub(crate) bits: u32,
    pub(crate) rotation: Vec<f32>,
    pub(crate) codebook: Vec<f32>,
    #[allow(dead_code)]
    pub(crate) num_centroids: usize,
}

impl TurboQuantEngine {
    /// Create a new TurboQuantEngine with the given parameters.
    ///
    /// # Panics
    /// Panics if bits is not 1, 2, 3, or 4, or head_dim < 2.
    pub fn new(head_dim: usize, bits: u32, seed: u32) -> Self {
        assert!(matches!(bits, 1 | 2 | 3 | 4), "bits must be 1, 2, 3, or 4");
        assert!(head_dim >= 2, "head_dim must be >= 2");

        let mut rng = Xoshiro128ss::new(seed);
        let gaussian = randn_matrix(head_dim, head_dim, &mut rng);
        let rotation = qr_q(&gaussian, head_dim, head_dim);
        let codebook = compute_codebook(head_dim, bits);
        let num_centroids = 1 << bits;

        TurboQuantEngine {
            head_dim,
            bits,
            rotation,
            codebook,
            num_centroids,
        }
    }

    /// Compress a single KV vector.
    ///
    /// Steps:
    /// 1. Compute and store the L2 norm
    /// 2. Normalize to unit vector
    /// 3. Apply random rotation
    /// 4. Find nearest codebook centroid per coordinate (binary search)
    /// 5. Pack indices into compact bit representation
    pub fn compress_vector(&self, vector: &[f32]) -> CompressedKvEntry {
        let dim = self.head_dim;
        assert_eq!(vector.len(), dim, "Vector length {} != headDim {}", vector.len(), dim);

        // Compute norm
        let mut norm_sq = 0.0f64;
        for &v in vector {
            norm_sq += (v as f64) * (v as f64);
        }
        let norm = norm_sq.sqrt();

        // Normalize
        let inv_norm = if norm > 1e-10 { 1.0 / norm } else { 0.0 };
        let mut unit = vec![0.0f32; dim];
        for i in 0..dim {
            unit[i] = (vector[i] as f64 * inv_norm) as f32;
        }

        // Rotate: y = rotation @ unit
        let rotated = mat_vec_mul(&self.rotation, &unit, dim, dim);

        // Quantize: find nearest centroid per coordinate using binary search
        let mut indices = vec![0u8; dim];
        for i in 0..dim {
            indices[i] = find_nearest_centroid(rotated[i], &self.codebook);
        }

        // Pack
        let packed_codes = pack_indices(&indices, self.bits);

        CompressedKvEntry {
            packed_codes,
            norm: norm as f32,
            dim,
            bits: self.bits,
        }
    }

    /// Decompress a single KV vector from its compressed representation.
    ///
    /// Steps:
    /// 1. Unpack indices from packed codes
    /// 2. Look up codebook centroids from indices
    /// 3. Apply inverse rotation (rotation^T)
    /// 4. Rescale by stored norm
    pub fn decompress_vector(&self, entry: &CompressedKvEntry) -> Vec<f32> {
        let dim = entry.dim;

        // Unpack indices
        let indices = unpack_indices(&entry.packed_codes, dim, entry.bits);

        // Centroid lookup
        let mut rotated = vec![0.0f32; dim];
        for i in 0..dim {
            rotated[i] = self.codebook[indices[i] as usize];
        }

        // Inverse rotation: x_hat = rotation^T @ rotated
        let mut vec_out = mat_t_vec_mul(&self.rotation, &rotated, dim, dim);

        // Rescale
        let norm = entry.norm;
        for v in &mut vec_out {
            *v *= norm;
        }

        vec_out
    }
}

// ---------------------------------------------------------------------------
// Memory statistics
// ---------------------------------------------------------------------------

/// Memory usage statistics for TurboQuant KV cache compression.
pub struct MemoryStats {
    pub compressed_bytes: u64,
    pub residual_bytes: u64,
    pub total_bytes: u64,
    pub uncompressed_bytes: u64,
    pub compression_ratio: f64,
    pub bits_per_element: f64,
}

/// Compute memory usage statistics.
pub fn compute_memory_stats(
    head_dim: usize,
    bits: u32,
    num_heads: usize,
    num_layers: usize,
    compressed_tokens: usize,
    residual_tokens: usize,
) -> MemoryStats {
    // Compressed: packed indices (bits per dim) + norm (f32) per head per layer per token
    // For keys + values (2x)
    let indices_per_token = (head_dim as u64 * bits as u64) / 8;
    let norm_per_token = 4u64; // float32
    let bytes_per_comp_token =
        (indices_per_token + norm_per_token) * num_heads as u64 * num_layers as u64 * 2;
    let compressed_bytes = bytes_per_comp_token * compressed_tokens as u64;

    // Residual: full fp32 per dim per head per layer per token (keys + values)
    let bytes_per_residual_token =
        head_dim as u64 * 4 * num_heads as u64 * num_layers as u64 * 2;
    let residual_bytes = bytes_per_residual_token * residual_tokens as u64;

    let total_bytes = compressed_bytes + residual_bytes;

    // Uncompressed baseline: all tokens at fp16
    let total_tokens = (compressed_tokens + residual_tokens) as u64;
    let uncompressed_bytes =
        head_dim as u64 * 2 * num_heads as u64 * num_layers as u64 * 2 * total_tokens;

    let compression_ratio = if uncompressed_bytes > 0 {
        uncompressed_bytes as f64 / total_bytes as f64
    } else {
        0.0
    };

    let bits_per_element = if total_tokens > 0 {
        (total_bytes as f64 * 8.0)
            / (total_tokens as f64
                * head_dim as f64
                * num_heads as f64
                * num_layers as f64
                * 2.0)
    } else {
        0.0
    };

    MemoryStats {
        compressed_bytes,
        residual_bytes,
        total_bytes,
        uncompressed_bytes,
        compression_ratio,
        bits_per_element,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn random_vector(length: usize, seed: u32) -> Vec<f32> {
        let mut vec = vec![0.0f32; length];
        let mut state = seed;
        for i in 0..length {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            vec[i] = (state as f64 / 4294967296.0) as f32 * 2.0 - 1.0;
        }
        vec
    }

    fn cosine_sim(a: &[f32], b: &[f32]) -> f64 {
        let mut dot = 0.0f64;
        let mut na = 0.0f64;
        let mut nb = 0.0f64;
        for i in 0..a.len() {
            dot += a[i] as f64 * b[i] as f64;
            na += a[i] as f64 * a[i] as f64;
            nb += b[i] as f64 * b[i] as f64;
        }
        let denom = na.sqrt() * nb.sqrt();
        if denom > 0.0 { dot / denom } else { 0.0 }
    }

    fn mse(a: &[f32], b: &[f32]) -> f64 {
        let mut sum = 0.0f64;
        for i in 0..a.len() {
            let diff = a[i] as f64 - b[i] as f64;
            sum += diff * diff;
        }
        sum / a.len() as f64
    }

    #[test]
    fn test_codebook_sorted_ascending() {
        for bits in [1, 2, 3, 4] {
            let cb = compute_codebook(64, bits);
            for i in 1..cb.len() {
                assert!(cb[i] > cb[i - 1], "codebook not sorted for bits={}", bits);
            }
        }
    }

    #[test]
    fn test_codebook_symmetric() {
        let cb = compute_codebook(64, 2);
        for i in 0..cb.len() {
            let sum = cb[i] + cb[cb.len() - 1 - i];
            assert!(
                sum.abs() < 1e-4,
                "codebook not symmetric: cb[{}]={}, cb[{}]={}",
                i, cb[i], cb.len() - 1 - i, cb[cb.len() - 1 - i]
            );
        }
    }

    #[test]
    fn test_codebook_in_range() {
        let cb = compute_codebook(128, 4);
        for &c in &cb {
            assert!(c >= -1.0 && c <= 1.0, "centroid {} out of range [-1, 1]", c);
        }
    }

    #[test]
    fn test_compress_decompress_4bit() {
        let engine = TurboQuantEngine::new(64, 4, 42);
        for seed in 1..=10 {
            let vec = random_vector(64, seed);
            let compressed = engine.compress_vector(&vec);
            let restored = engine.decompress_vector(&compressed);
            let sim = cosine_sim(&vec, &restored);
            assert!(sim > 0.95, "4-bit cosine sim {} too low for seed {}", sim, seed);
        }
    }

    #[test]
    fn test_compress_decompress_3bit() {
        let engine = TurboQuantEngine::new(64, 3, 42);
        for seed in 1..=10 {
            let vec = random_vector(64, seed);
            let compressed = engine.compress_vector(&vec);
            let restored = engine.decompress_vector(&compressed);
            let sim = cosine_sim(&vec, &restored);
            assert!(sim > 0.9, "3-bit cosine sim {} too low for seed {}", sim, seed);
        }
    }

    #[test]
    fn test_higher_bits_lower_mse() {
        let vec = random_vector(64, 99);
        let mut mse_by_bits = Vec::new();
        for bits in [1, 2, 3, 4] {
            let engine = TurboQuantEngine::new(64, bits, 42);
            let compressed = engine.compress_vector(&vec);
            let restored = engine.decompress_vector(&compressed);
            mse_by_bits.push(mse(&vec, &restored));
        }
        for i in 1..mse_by_bits.len() {
            assert!(mse_by_bits[i] < mse_by_bits[i - 1],
                "bits {} MSE {} not less than bits {} MSE {}",
                i + 1, mse_by_bits[i], i, mse_by_bits[i - 1]);
        }
    }

    #[test]
    fn test_packed_codes_length() {
        let engine = TurboQuantEngine::new(64, 4, 42);
        let vec = random_vector(64, 7);
        let compressed = engine.compress_vector(&vec);
        assert_eq!(compressed.packed_codes.len(), (64 * 4 + 7) / 8);
        assert_eq!(compressed.dim, 64);
        assert_eq!(compressed.bits, 4);
    }

    #[test]
    fn test_zero_vector() {
        let engine = TurboQuantEngine::new(64, 4, 42);
        let zero = vec![0.0f32; 64];
        let compressed = engine.compress_vector(&zero);
        assert!((compressed.norm).abs() < 1e-6);
        let restored = engine.decompress_vector(&compressed);
        for v in &restored {
            assert!(v.abs() < 1e-6);
        }
    }

    #[test]
    fn test_determinism() {
        let e1 = TurboQuantEngine::new(64, 4, 123);
        let e2 = TurboQuantEngine::new(64, 4, 123);
        let vec = random_vector(64, 7);
        let r1 = e1.compress_vector(&vec);
        let r2 = e2.compress_vector(&vec);
        assert_eq!(r1.norm, r2.norm);
        assert_eq!(r1.packed_codes, r2.packed_codes);
    }

    #[test]
    fn test_different_seeds_differ() {
        let e1 = TurboQuantEngine::new(64, 4, 1);
        let e2 = TurboQuantEngine::new(64, 4, 999);
        let vec = random_vector(64, 7);
        let r1 = e1.compress_vector(&vec);
        let r2 = e2.compress_vector(&vec);
        assert!((r1.norm - r2.norm).abs() < 1e-5);
        assert_ne!(r1.packed_codes, r2.packed_codes);
    }

    #[test]
    fn test_dim128_4bit_quality() {
        let engine = TurboQuantEngine::new(128, 4, 42);
        let mut total_mse = 0.0;
        let trials = 50;
        for i in 0..trials {
            let vec = random_vector(128, i as u32 + 1000);
            let compressed = engine.compress_vector(&vec);
            let restored = engine.decompress_vector(&compressed);
            total_mse += mse(&vec, &restored);
        }
        let avg_mse = total_mse / trials as f64;
        assert!(avg_mse < 0.01, "avg MSE {} too high at dim=128, 4-bit", avg_mse);
    }

    #[test]
    fn test_pack_unpack_roundtrip() {
        for bits in [1u32, 2, 3, 4] {
            let mask = ((1u16 << bits) - 1) as u8;
            let indices: Vec<u8> = (0..64).map(|i| (i % (mask as usize + 1)) as u8).collect();
            let packed = pack_indices(&indices, bits);
            let unpacked = unpack_indices(&packed, 64, bits);
            assert_eq!(indices, unpacked, "pack/unpack roundtrip failed for bits={}", bits);
        }
    }
}
