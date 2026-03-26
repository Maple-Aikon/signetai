/// RaBitQ — Random Bit Quantization for compressed vector search.
///
/// Rust port of the pure-TypeScript RaBitQ implementation. Provides:
/// - Seeded xoshiro128** PRNG (deterministic, matches TS output bit-for-bit)
/// - Householder QR decomposition for random orthogonal rotation matrices
/// - Beta distribution codebook via inverse CDF (Newton-bisection hybrid)
/// - 4-bit packed quantization / dequantization
/// - Fast approximate dot-product search via centroid lookup tables

// ---------------------------------------------------------------------------
// Seeded PRNG — xoshiro128** (deterministic, matches TS implementation)
// ---------------------------------------------------------------------------

/// Internal state for xoshiro128** PRNG.
pub struct Xoshiro128ss {
    s0: u32,
    s1: u32,
    s2: u32,
    s3: u32,
}

impl Xoshiro128ss {
    /// Create a new PRNG from a single seed, expanded via splitmix32.
    pub fn new(seed: u32) -> Self {
        let s0 = splitmix32(seed);
        let s1 = splitmix32(s0);
        let s2 = splitmix32(s1);
        let s3 = splitmix32(s2);
        Self { s0, s1, s2, s3 }
    }

    /// Generate the next random u32.
    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let result = (self.s1.wrapping_mul(5)).rotate_left(7).wrapping_mul(9);
        let t = self.s1 << 9;

        self.s2 ^= self.s0;
        self.s3 ^= self.s1;
        self.s1 ^= self.s2;
        self.s0 ^= self.s3;

        self.s2 ^= t;
        self.s3 = self.s3.rotate_left(11);

        result
    }

    /// Generate a uniform float in [0, 1).
    #[inline]
    pub fn next_f64(&mut self) -> f64 {
        self.next_u32() as f64 / 4294967296.0 // 2^32
    }

    /// Box-Muller transform: generate a standard normal variate.
    pub fn gaussian(&mut self) -> f64 {
        let u = loop {
            let v = self.next_f64();
            if v != 0.0 {
                break v;
            }
        };
        let v = self.next_f64();
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
    }
}

/// splitmix32 — expand a single u32 seed into a good state word.
fn splitmix32(input: u32) -> u32 {
    let s = input.wrapping_add(0x9e3779b9);
    let mut t = s;
    t = (t ^ (t >> 16)).wrapping_mul(0x21f0aaad);
    t = (t ^ (t >> 15)).wrapping_mul(0x735a2d97);
    t ^ (t >> 15)
}

// ---------------------------------------------------------------------------
// QR Decomposition (Householder)
// ---------------------------------------------------------------------------

/// Generate a random orthogonal rotation matrix via Householder QR
/// decomposition of a random Gaussian matrix.
///
/// Returns a row-major `Vec<f32>` of size dim×dim.
pub fn generate_rotation_matrix(dim: usize, seed: u32) -> Vec<f32> {
    let mut rng = Xoshiro128ss::new(seed);

    // Generate random Gaussian matrix (dim × dim) — row-major for QR
    let n = dim * dim;
    let mut a = vec![0.0f64; n];
    for v in a.iter_mut() {
        *v = rng.gaussian();
    }

    // Householder QR decomposition (in-place on A)
    let mut tau = vec![0.0f64; dim];

    for k in 0..dim {
        // Compute norm of sub-column k from row k..dim
        let mut norm_sq = 0.0f64;
        for i in k..dim {
            let v = a[i * dim + k];
            norm_sq += v * v;
        }
        let norm = norm_sq.sqrt();

        if norm < 1e-14 {
            tau[k] = 0.0;
            continue;
        }

        let akk = a[k * dim + k];
        let sign: f64 = if akk >= 0.0 { 1.0 } else { -1.0 };
        let _alpha = -sign * norm;

        // v[k] = A[k,k] - alpha
        a[k * dim + k] = akk - _alpha;

        // Compute tau
        let vk = a[k * dim + k];
        let mut v_norm_sq = vk * vk;
        for i in (k + 1)..dim {
            v_norm_sq += a[i * dim + k] * a[i * dim + k];
        }
        tau[k] = if v_norm_sq > 0.0 {
            2.0 / v_norm_sq
        } else {
            0.0
        };

        // Apply reflector to remaining columns
        for j in (k + 1)..dim {
            let mut dot = 0.0f64;
            for i in k..dim {
                dot += a[i * dim + k] * a[i * dim + j];
            }
            dot *= tau[k];
            for i in k..dim {
                a[i * dim + j] -= dot * a[i * dim + k];
            }
        }
    }

    // Reconstruct Q = H_0 * H_1 * ... * H_{n-1}
    // Start with identity and apply reflectors in reverse
    let mut q = vec![0.0f64; n];
    for i in 0..dim {
        q[i * dim + i] = 1.0;
    }

    for k in (0..dim).rev() {
        if tau[k] == 0.0 {
            continue;
        }

        for j in k..dim {
            let mut dot = 0.0f64;
            for i in k..dim {
                dot += a[i * dim + k] * q[i * dim + j];
            }
            dot *= tau[k];
            for i in k..dim {
                q[i * dim + j] -= dot * a[i * dim + k];
            }
        }
    }

    // Convert to f32
    q.iter().map(|&v| v as f32).collect()
}

// ---------------------------------------------------------------------------
// Beta Distribution Inverse CDF
// ---------------------------------------------------------------------------

/// Log-gamma function via Lanczos approximation.
fn log_gamma(z_input: f64) -> f64 {
    if z_input < 0.5 {
        // Reflection formula
        return (std::f64::consts::PI / (std::f64::consts::PI * z_input).sin()).ln()
            - log_gamma(1.0 - z_input);
    }

    let z = z_input - 1.0;
    let g = 7.0;
    let c: [f64; 9] = [
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

    let mut x = c[0];
    for i in 1..9 {
        x += c[i] / (z + i as f64);
    }

    let t = z + g + 0.5;
    0.5 * (2.0 * std::f64::consts::PI).ln() + (z + 0.5) * t.ln() - t + x.ln()
}

/// Log-beta function.
fn log_beta(a: f64, b: f64) -> f64 {
    log_gamma(a) + log_gamma(b) - log_gamma(a + b)
}

/// Regularized incomplete beta function I_x(a, b) via continued fraction (Lentz's method).
fn regularized_beta(x: f64, a: f64, b: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }

    // Use symmetry relation when x > (a+1)/(a+b+2)
    if x > (a + 1.0) / (a + b + 2.0) {
        return 1.0 - regularized_beta(1.0 - x, b, a);
    }

    // TS: a * ln(x) + b * ln(1-x) - ln(a) - logBeta(a,b)
    let log_prefix = a * x.ln() + b * (1.0 - x).ln() - a.ln() - log_beta(a, b);
    let prefix = log_prefix.exp();

    let max_iter = 200;
    let eps = 1e-14;
    let tiny = 1e-30;

    let mut c = 1.0f64;
    let mut d = 1.0 - ((a + b) * x) / (a + 1.0);
    if d.abs() < tiny {
        d = tiny;
    }
    d = 1.0 / d;
    let mut h = d;

    for m in 1..=max_iter {
        let m_f = m as f64;
        let m2 = 2.0 * m_f;

        // Even step
        let num_even = (m_f * (b - m_f) * x) / ((a + m2 - 1.0) * (a + m2));
        d = 1.0 + num_even * d;
        if d.abs() < tiny {
            d = tiny;
        }
        c = 1.0 + num_even / c;
        if c.abs() < tiny {
            c = tiny;
        }
        d = 1.0 / d;
        h *= d * c;

        // Odd step
        let num_odd =
            -((a + m_f) * (a + b + m_f) * x) / ((a + m2) * (a + m2 + 1.0));
        d = 1.0 + num_odd * d;
        if d.abs() < tiny {
            d = tiny;
        }
        c = 1.0 + num_odd / c;
        if c.abs() < tiny {
            c = tiny;
        }
        d = 1.0 / d;
        let delta = d * c;
        h *= delta;

        if (delta - 1.0).abs() < eps {
            break;
        }
    }

    prefix * h
}

/// Inverse CDF of the Beta(a, b) distribution via Newton-bisection hybrid.
fn beta_inverse_cdf(p: f64, a: f64, b: f64) -> f64 {
    if p <= 0.0 {
        return 0.0;
    }
    if p >= 1.0 {
        return 1.0;
    }

    let eps = 1e-10;
    let mut lo = 0.0f64;
    let mut hi = 1.0f64;

    // Initial guess
    let mut x = if (a - b).abs() < 1e-10 {
        // Symmetric Beta — median ~0.5
        0.5 + (p - 0.5) * 0.5
    } else {
        p
    };

    for _iter in 0..100 {
        let cdf = regularized_beta(x, a, b);
        let err = cdf - p;

        if err.abs() < eps {
            break;
        }

        // Beta PDF for Newton step
        let log_pdf = (a - 1.0) * x.max(1e-300).ln()
            + (b - 1.0) * (1.0 - x).max(1e-300).ln()
            - log_beta(a, b);
        let pdf = log_pdf.exp();

        if pdf > 1e-14 {
            let step = err / pdf;
            let x_new = x - step;
            if x_new > lo && x_new < hi {
                x = x_new;
            } else {
                x = (lo + hi) / 2.0;
            }
        } else {
            x = (lo + hi) / 2.0;
        }

        // Update bracket
        let cdf_new = regularized_beta(x, a, b);
        if cdf_new < p {
            lo = x;
        } else {
            hi = x;
        }
    }

    x
}

/// Compute the RaBitQ codebook: 2^bits centroids from the Beta(d/2, d/2) distribution.
///
/// For dimension d, the marginal distribution of each coordinate of a
/// uniformly-distributed unit vector is approximately Beta(d/2, d/2)
/// shifted to [-1, 1]. We compute quantile centroids to minimize
/// expected quantization error.
pub fn compute_codebook(bits: u32, dim: u32) -> Vec<f32> {
    let num_centroids = 1u32 << bits;
    let mut centroids = vec![0.0f32; num_centroids as usize];
    let a = dim as f64 / 2.0;
    let b = dim as f64 / 2.0;

    for i in 0..num_centroids {
        let p_mid = (i as f64 + 0.5) / num_centroids as f64;
        let beta_val = beta_inverse_cdf(p_mid, a, b);
        centroids[i as usize] = (2.0 * beta_val - 1.0) as f32;
    }

    centroids
}

// ---------------------------------------------------------------------------
// Vector Rotation
// ---------------------------------------------------------------------------

/// Rotate a vector: result = R × vec (row-major matrix-vector product).
fn rotate_vector(vec: &[f32], rotation: &[f32], dim: usize) -> Vec<f32> {
    let mut result = vec![0.0f32; dim];
    for i in 0..dim {
        let mut sum = 0.0f32;
        let row_offset = i * dim;
        for j in 0..dim {
            sum += rotation[row_offset + j] * vec[j];
        }
        result[i] = sum;
    }
    result
}

/// Inverse-rotate a vector: result = R^T × vec (transpose = inverse for orthogonal).
fn inverse_rotate_vector(vec: &[f32], rotation: &[f32], dim: usize) -> Vec<f32> {
    let mut result = vec![0.0f32; dim];
    for i in 0..dim {
        let mut sum = 0.0f32;
        for j in 0..dim {
            sum += rotation[j * dim + i] * vec[j]; // Transposed access
        }
        result[i] = sum;
    }
    result
}

// ---------------------------------------------------------------------------
// Quantization Helpers
// ---------------------------------------------------------------------------

/// Find the nearest centroid index for a scalar value (binary search).
fn find_nearest_centroid(value: f32, codebook: &[f32]) -> u8 {
    let mut lo: usize = 0;
    let mut hi: usize = codebook.len() - 1;

    while lo < hi {
        let mid = (lo + hi) >> 1;
        let boundary = (codebook[mid] + codebook[mid + 1]) / 2.0;
        if value <= boundary {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }

    lo as u8
}

/// Pack two 4-bit indices into a single byte.
#[inline]
fn pack_4bit_pair(high: u8, low: u8) -> u8 {
    ((high & 0xf) << 4) | (low & 0xf)
}

/// Unpack a byte into two 4-bit indices: (high, low).
#[inline]
fn unpack_4bit_pair(byte: u8) -> (u8, u8) {
    ((byte >> 4) & 0xf, byte & 0xf)
}

// ---------------------------------------------------------------------------
// Compressed Vector Metadata
// ---------------------------------------------------------------------------

/// Metadata for a single compressed vector.
pub struct CompressedVector {
    /// Original vector ID.
    pub id: String,
    /// L2 norm of the original vector (pre-rotation).
    pub norm: f32,
    /// Mean of the rotated vector components.
    pub mean: f32,
    /// Max absolute deviation from mean (per-vector scale factor).
    pub max_dev: f32,
    /// Packed quantized indices (2 indices per byte for 4-bit).
    pub codes: Vec<u8>,
}

/// Immutable compressed index holding all quantized vectors and metadata.
pub struct CompressedIndex {
    /// Number of bits per coordinate (e.g. 4 → 16 centroids).
    pub bits: u32,
    /// Dimensionality of the original vectors.
    pub dim: u32,
    /// Number of vectors in the index.
    pub count: u32,
    /// All compressed vectors.
    pub vectors: Vec<CompressedVector>,
    /// Codebook centroids (2^bits values).
    pub codebook: Vec<f32>,
    /// Row-major rotation matrix (dim × dim).
    pub rotation_matrix: Vec<f32>,
}

/// Search result from compressed search.
pub struct CompressedSearchResult {
    pub id: String,
    pub score: f64,
}

// ---------------------------------------------------------------------------
// Quantize
// ---------------------------------------------------------------------------

/// Quantize a batch of vectors into a CompressedIndex.
///
/// Algorithm:
/// 1. Rotate each vector using the orthogonal rotation matrix
/// 2. Compute norm and mean of rotated vector
/// 3. Normalize rotated coordinates to [-1, 1]
/// 4. Find nearest codebook centroid for each coordinate
/// 5. Pack centroid indices into bytes
pub fn quantize(
    vectors: &[Vec<f32>],
    ids: &[String],
    rotation_matrix: &[f32],
    codebook: &[f32],
    bits: u32,
) -> Result<CompressedIndex, String> {
    if vectors.len() != ids.len() {
        return Err(format!(
            "Vector count ({}) must match ID count ({})",
            vectors.len(),
            ids.len()
        ));
    }

    if vectors.is_empty() {
        return Ok(CompressedIndex {
            bits,
            dim: 0,
            count: 0,
            vectors: Vec::new(),
            codebook: codebook.to_vec(),
            rotation_matrix: rotation_matrix.to_vec(),
        });
    }

    let dim = vectors[0].len();
    let bytes_per_vector = if bits == 4 {
        (dim + 1) / 2
    } else {
        (dim * bits as usize + 7) / 8
    };
    let mut compressed = Vec::with_capacity(vectors.len());

    for (vi, vec) in vectors.iter().enumerate() {
        if vec.len() != dim {
            return Err(format!(
                "Vector {} has dimension {}, expected {}",
                vi,
                vec.len(),
                dim
            ));
        }

        // 1. Compute original norm
        let norm_sq: f32 = vec.iter().map(|v| v * v).sum();
        let norm = norm_sq.sqrt();

        // 2. Rotate the vector
        let rotated = rotate_vector(vec, rotation_matrix, dim);

        // 3. Compute mean of rotated coordinates
        let mean: f32 = rotated.iter().sum::<f32>() / dim as f32;

        // 4. Normalize: center and scale to [-1, 1]
        let mut max_dev: f32 = 0.0;
        for &r in &rotated {
            let dev = (r - mean).abs();
            if dev > max_dev {
                max_dev = dev;
            }
        }
        let scale = if max_dev > 0.0 { max_dev } else { 1.0 };

        // 5. Quantize each coordinate and pack
        let mut codes = vec![0u8; bytes_per_vector];

        if bits == 4 {
            let mut i = 0;
            while i < dim {
                let val0 = (rotated[i] - mean) / scale;
                let idx0 = find_nearest_centroid(val0, codebook);

                let idx1 = if i + 1 < dim {
                    let val1 = (rotated[i + 1] - mean) / scale;
                    find_nearest_centroid(val1, codebook)
                } else {
                    0
                };

                codes[i >> 1] = pack_4bit_pair(idx0, idx1);
                i += 2;
            }
        } else {
            let mut bit_pos: usize = 0;
            for i in 0..dim {
                let val = (rotated[i] - mean) / scale;
                let idx = find_nearest_centroid(val, codebook) as usize;
                let byte_idx = bit_pos >> 3;
                let bit_offset = bit_pos & 7;
                codes[byte_idx] |= ((idx << bit_offset) & 0xff) as u8;
                if bit_offset + bits as usize > 8 && byte_idx + 1 < codes.len() {
                    codes[byte_idx + 1] |= ((idx >> (8 - bit_offset)) & 0xff) as u8;
                }
                bit_pos += bits as usize;
            }
        }

        compressed.push(CompressedVector {
            id: ids[vi].clone(),
            norm,
            mean,
            max_dev: scale,
            codes,
        });
    }

    Ok(CompressedIndex {
        bits,
        dim: dim as u32,
        count: compressed.len() as u32,
        vectors: compressed,
        codebook: codebook.to_vec(),
        rotation_matrix: rotation_matrix.to_vec(),
    })
}

// ---------------------------------------------------------------------------
// Dequantize
// ---------------------------------------------------------------------------

/// Dequantize a CompressedIndex back to approximate f32 vectors.
///
/// This is lossy — the dequantized vectors approximate the originals.
pub fn dequantize(index: &CompressedIndex) -> Vec<Vec<f32>> {
    let dim = index.dim as usize;
    let bits = index.bits;
    let codebook = &index.codebook;
    let rotation_matrix = &index.rotation_matrix;
    let mut result = Vec::with_capacity(index.vectors.len());

    for cv in &index.vectors {
        // 1. Unpack indices and look up centroids
        let mut rotated = vec![0.0f32; dim];

        if bits == 4 {
            let mut i = 0;
            while i < dim {
                let (hi, lo) = unpack_4bit_pair(cv.codes[i >> 1]);
                rotated[i] = codebook[hi as usize];
                if i + 1 < dim {
                    rotated[i + 1] = codebook[lo as usize];
                }
                i += 2;
            }
        } else {
            let mut bit_pos: usize = 0;
            let mask = ((1u32 << bits) - 1) as u8;
            for i in 0..dim {
                let byte_idx = bit_pos >> 3;
                let bit_offset = bit_pos & 7;
                let mut idx = (cv.codes[byte_idx] >> bit_offset) & mask;
                if bit_offset + bits as usize > 8 && byte_idx + 1 < cv.codes.len() {
                    idx |= (cv.codes[byte_idx + 1] << (8 - bit_offset)) & mask;
                }
                rotated[i] = codebook[idx as usize];
                bit_pos += bits as usize;
            }
        }

        // 2. Rescale from [-1, 1] back to original rotated space
        let scale = cv.max_dev;
        for r in rotated.iter_mut() {
            *r = *r * scale + cv.mean;
        }

        // 3. Inverse-rotate to original space
        let mut original = inverse_rotate_vector(&rotated, rotation_matrix, dim);

        // 4. Rescale to match original norm
        let cur_norm_sq: f32 = original.iter().map(|v| v * v).sum();
        let cur_norm = cur_norm_sq.sqrt();
        if cur_norm > 1e-12 {
            let rescale = cv.norm / cur_norm;
            for o in original.iter_mut() {
                *o *= rescale;
            }
        }

        result.push(original);
    }

    result
}

// ---------------------------------------------------------------------------
// Compressed Vector Search
// ---------------------------------------------------------------------------

/// Fast approximate nearest-neighbour search using compressed vectors.
///
/// Instead of decompressing all vectors, this computes approximate dot
/// products using centroid lookup tables, avoiding the full inverse
/// rotation per vector.
pub fn compressed_search(
    query: &[f32],
    index: &CompressedIndex,
    top_k: usize,
) -> Result<Vec<CompressedSearchResult>, String> {
    if index.count == 0 || top_k == 0 {
        return Ok(Vec::new());
    }

    let dim = index.dim as usize;
    let bits = index.bits;
    let codebook = &index.codebook;
    let rotation_matrix = &index.rotation_matrix;
    let vectors = &index.vectors;

    if query.len() != dim {
        return Err(format!(
            "Query dimension ({}) must match index dimension ({})",
            query.len(),
            dim
        ));
    }

    // 1. Compute query norm
    let query_norm_sq: f64 = query.iter().map(|&v| (v as f64) * (v as f64)).sum();
    let query_norm = query_norm_sq.sqrt();
    if query_norm < 1e-12 {
        return Ok(Vec::new());
    }

    // 2. Rotate query
    let rotated_query = rotate_vector(query, rotation_matrix, dim);

    // 3. Build per-dimension lookup tables
    let num_centroids = 1usize << bits;
    let mut lut = vec![0.0f32; dim * num_centroids];
    for i in 0..dim {
        let qr = rotated_query[i];
        let offset = i * num_centroids;
        for c in 0..num_centroids {
            lut[offset + c] = qr * codebook[c];
        }
    }

    // Pre-compute sum of rotated query components
    let query_rotated_sum: f32 = rotated_query.iter().sum();

    // 4. Score each compressed vector
    let mut scores: Vec<(usize, f64)> = Vec::with_capacity(vectors.len());

    for (vi, cv) in vectors.iter().enumerate() {
        let mut dot_approx = 0.0f32;

        if bits == 4 {
            // Fast path: 4-bit packed, 2 indices per byte
            let mut i = 0;
            while i < dim {
                let byte = cv.codes[i >> 1];
                let hi = ((byte >> 4) & 0xf) as usize;
                let lo = (byte & 0xf) as usize;

                dot_approx += lut[i * num_centroids + hi];
                if i + 1 < dim {
                    dot_approx += lut[(i + 1) * num_centroids + lo];
                }
                i += 2;
            }
        } else {
            let mut bit_pos: usize = 0;
            let mask = ((1u32 << bits) - 1) as u8;
            for i in 0..dim {
                let byte_idx = bit_pos >> 3;
                let bit_offset = bit_pos & 7;
                let mut idx = (cv.codes[byte_idx] >> bit_offset) & mask;
                if bit_offset + bits as usize > 8 && byte_idx + 1 < cv.codes.len() {
                    idx |= (cv.codes[byte_idx + 1] << (8 - bit_offset)) & mask;
                }
                dot_approx += lut[i * num_centroids + idx as usize];
                bit_pos += bits as usize;
            }
        }

        let scale = cv.max_dev;
        let approx_dot = scale * dot_approx + cv.mean * query_rotated_sum;

        // Approximate cosine similarity
        let cosine = approx_dot as f64 / (query_norm * cv.norm as f64);

        scores.push((vi, cosine));
    }

    // 5. Sort and return top-K
    scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let k = top_k.min(scores.len());
    let results: Vec<CompressedSearchResult> = scores[..k]
        .iter()
        .map(|&(idx, score)| CompressedSearchResult {
            id: vectors[idx].id.clone(),
            score,
        })
        .collect();

    Ok(results)
}

// ---------------------------------------------------------------------------
// Brute-force cosine search (for recall evaluation)
// ---------------------------------------------------------------------------

/// Brute-force cosine similarity search (ground truth baseline).
pub fn brute_force_search(
    query: &[f32],
    vectors: &[Vec<f32>],
    ids: &[String],
    top_k: usize,
) -> Vec<CompressedSearchResult> {
    let mut query_norm_sq = 0.0f64;
    for &q in query {
        query_norm_sq += (q as f64) * (q as f64);
    }
    let query_norm = query_norm_sq.sqrt();

    let mut scores: Vec<CompressedSearchResult> = Vec::with_capacity(vectors.len());

    for (vi, vec) in vectors.iter().enumerate() {
        let mut dot = 0.0f64;
        let mut vec_norm_sq = 0.0f64;
        let len = query.len().min(vec.len());
        for i in 0..len {
            dot += query[i] as f64 * vec[i] as f64;
            vec_norm_sq += vec[i] as f64 * vec[i] as f64;
        }
        let vec_norm = vec_norm_sq.sqrt();
        let cosine = if query_norm > 0.0 && vec_norm > 0.0 {
            dot / (query_norm * vec_norm)
        } else {
            0.0
        };
        scores.push(CompressedSearchResult {
            id: ids[vi].clone(),
            score: cosine,
        });
    }

    scores.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scores.truncate(top_k);
    scores
}

// ---------------------------------------------------------------------------
// Serialization helpers — for passing through napi Buffer
// ---------------------------------------------------------------------------

/// Serialize a CompressedIndex to a self-contained byte buffer.
///
/// Layout (little-endian):
/// ```text
/// [4 bytes] magic = 0x52425100 ("RBQ\0")
/// [4 bytes] version = 1
/// [4 bytes] bits
/// [4 bytes] dim
/// [4 bytes] count (number of vectors)
/// [4 bytes] codebook_len (number of centroids)
/// [codebook_len * 4 bytes] codebook f32 values
/// [dim * dim * 4 bytes] rotation_matrix f32 values
/// For each vector:
///   [4 bytes] id_len (byte length of UTF-8 id)
///   [id_len bytes] id (UTF-8)
///   [4 bytes] norm (f32)
///   [4 bytes] mean (f32)
///   [4 bytes] max_dev (f32)
///   [4 bytes] codes_len
///   [codes_len bytes] codes
/// ```
pub fn serialize_index(index: &CompressedIndex) -> Vec<u8> {
    let mut buf = Vec::new();

    // Header
    buf.extend_from_slice(&0x52425100u32.to_le_bytes()); // magic
    buf.extend_from_slice(&1u32.to_le_bytes()); // version
    buf.extend_from_slice(&index.bits.to_le_bytes());
    buf.extend_from_slice(&index.dim.to_le_bytes());
    buf.extend_from_slice(&index.count.to_le_bytes());

    // Codebook
    let codebook_len = index.codebook.len() as u32;
    buf.extend_from_slice(&codebook_len.to_le_bytes());
    for &c in &index.codebook {
        buf.extend_from_slice(&c.to_le_bytes());
    }

    // Rotation matrix
    for &r in &index.rotation_matrix {
        buf.extend_from_slice(&r.to_le_bytes());
    }

    // Vectors
    for cv in &index.vectors {
        let id_bytes = cv.id.as_bytes();
        buf.extend_from_slice(&(id_bytes.len() as u32).to_le_bytes());
        buf.extend_from_slice(id_bytes);
        buf.extend_from_slice(&cv.norm.to_le_bytes());
        buf.extend_from_slice(&cv.mean.to_le_bytes());
        buf.extend_from_slice(&cv.max_dev.to_le_bytes());
        buf.extend_from_slice(&(cv.codes.len() as u32).to_le_bytes());
        buf.extend_from_slice(&cv.codes);
    }

    buf
}

/// Deserialize a CompressedIndex from a byte buffer produced by `serialize_index`.
pub fn deserialize_index(data: &[u8]) -> Result<CompressedIndex, String> {
    if data.len() < 24 {
        return Err("Buffer too short for header".to_string());
    }

    let mut pos = 0;

    let read_u32 = |data: &[u8], pos: &mut usize| -> Result<u32, String> {
        if *pos + 4 > data.len() {
            return Err("Unexpected end of buffer".to_string());
        }
        let val = u32::from_le_bytes([data[*pos], data[*pos + 1], data[*pos + 2], data[*pos + 3]]);
        *pos += 4;
        Ok(val)
    };

    let read_f32 = |data: &[u8], pos: &mut usize| -> Result<f32, String> {
        if *pos + 4 > data.len() {
            return Err("Unexpected end of buffer".to_string());
        }
        let val = f32::from_le_bytes([data[*pos], data[*pos + 1], data[*pos + 2], data[*pos + 3]]);
        *pos += 4;
        Ok(val)
    };

    let magic = read_u32(data, &mut pos)?;
    if magic != 0x52425100 {
        return Err(format!("Invalid magic: 0x{:08X}", magic));
    }

    let version = read_u32(data, &mut pos)?;
    if version != 1 {
        return Err(format!("Unsupported version: {}", version));
    }

    let bits = read_u32(data, &mut pos)?;
    let dim = read_u32(data, &mut pos)?;
    let count = read_u32(data, &mut pos)?;

    // Codebook
    let codebook_len = read_u32(data, &mut pos)? as usize;
    let mut codebook = Vec::with_capacity(codebook_len);
    for _ in 0..codebook_len {
        codebook.push(read_f32(data, &mut pos)?);
    }

    // Rotation matrix
    let rot_len = (dim as usize) * (dim as usize);
    let mut rotation_matrix = Vec::with_capacity(rot_len);
    for _ in 0..rot_len {
        rotation_matrix.push(read_f32(data, &mut pos)?);
    }

    // Vectors
    let mut vectors = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let id_len = read_u32(data, &mut pos)? as usize;
        if pos + id_len > data.len() {
            return Err("Unexpected end of buffer reading id".to_string());
        }
        let id = String::from_utf8(data[pos..pos + id_len].to_vec())
            .map_err(|e| format!("Invalid UTF-8 in id: {}", e))?;
        pos += id_len;

        let norm = read_f32(data, &mut pos)?;
        let mean = read_f32(data, &mut pos)?;
        let max_dev = read_f32(data, &mut pos)?;

        let codes_len = read_u32(data, &mut pos)? as usize;
        if pos + codes_len > data.len() {
            return Err("Unexpected end of buffer reading codes".to_string());
        }
        let codes = data[pos..pos + codes_len].to_vec();
        pos += codes_len;

        vectors.push(CompressedVector {
            id,
            norm,
            mean,
            max_dev,
            codes,
        });
    }

    Ok(CompressedIndex {
        bits,
        dim,
        count,
        vectors,
        codebook,
        rotation_matrix,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_rng(seed: u32) -> impl FnMut() -> f64 {
        let mut s = seed;
        move || {
            s = (s.wrapping_mul(1664525).wrapping_add(1013904223)) & 0x7fffffff;
            s as f64 / 0x7fffffff as f64
        }
    }

    fn random_vector(dim: usize, rng: &mut dyn FnMut() -> f64) -> Vec<f32> {
        let mut vec = vec![0.0f32; dim];
        for v in vec.iter_mut() {
            let u = rng().max(0.001);
            let vv = rng();
            *v = ((-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * vv).cos()) as f32;
        }
        vec
    }

    fn normalize(vec: &mut Vec<f32>) {
        let norm: f32 = vec.iter().map(|v| v * v).sum::<f32>().sqrt();
        if norm > 0.0 {
            for v in vec.iter_mut() {
                *v /= norm;
            }
        }
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

    #[test]
    fn test_rotation_matrix_orthogonal() {
        let dim = 16;
        let r = generate_rotation_matrix(dim, 42);
        assert_eq!(r.len(), dim * dim);

        for i in 0..dim {
            for j in 0..dim {
                let mut dot = 0.0f64;
                for k in 0..dim {
                    dot += r[i * dim + k] as f64 * r[j * dim + k] as f64;
                }
                let expected = if i == j { 1.0 } else { 0.0 };
                assert!(
                    (dot - expected).abs() < 1e-4,
                    "R*R^T[{},{}] = {}, expected {}",
                    i,
                    j,
                    dot,
                    expected
                );
            }
        }
    }

    #[test]
    fn test_rotation_matrix_deterministic() {
        let dim = 32;
        let r1 = generate_rotation_matrix(dim, 123);
        let r2 = generate_rotation_matrix(dim, 123);
        assert_eq!(r1, r2);
    }

    #[test]
    fn test_codebook_properties() {
        let cb = compute_codebook(4, 768);
        assert_eq!(cb.len(), 16);

        // Sorted ascending
        for i in 1..cb.len() {
            assert!(cb[i] >= cb[i - 1]);
        }

        // In [-1, 1]
        for &c in &cb {
            assert!(c >= -1.0 && c <= 1.0);
        }

        // Symmetric around 0 for high dimensions
        for i in 0..cb.len() / 2 {
            let j = cb.len() - 1 - i;
            assert!(
                (cb[i] + cb[j]).abs() < 0.01,
                "Asymmetry: cb[{}]={} + cb[{}]={} = {}",
                i,
                cb[i],
                j,
                cb[j],
                cb[i] + cb[j]
            );
        }
    }

    #[test]
    fn test_round_trip_preserves_direction() {
        let dim = 64;
        let r = generate_rotation_matrix(dim, 42);
        let cb = compute_codebook(4, dim as u32);
        let mut rng = make_rng(100);

        let mut vectors = Vec::new();
        let mut ids = Vec::new();
        for i in 0..10 {
            let mut v = random_vector(dim, &mut rng);
            normalize(&mut v);
            vectors.push(v);
            ids.push(format!("vec-{}", i));
        }

        let index = quantize(&vectors, &ids, &r, &cb, 4).unwrap();
        let restored = dequantize(&index);

        assert_eq!(restored.len(), vectors.len());
        for i in 0..vectors.len() {
            let sim = cosine_sim(&vectors[i], &restored[i]);
            assert!(
                sim > 0.85,
                "Round-trip cosine for vector {} = {} (expected > 0.85)",
                i,
                sim
            );
        }
    }

    #[test]
    fn test_compressed_search_finds_exact_match() {
        let dim = 16;
        let r = generate_rotation_matrix(dim, 42);
        let cb = compute_codebook(4, dim as u32);
        let mut rng = make_rng(800);

        let mut vectors = Vec::new();
        let mut ids = Vec::new();
        for i in 0..20 {
            let mut v = random_vector(dim, &mut rng);
            normalize(&mut v);
            vectors.push(v);
            ids.push(format!("v{}", i));
        }

        let index = quantize(&vectors, &ids, &r, &cb, 4).unwrap();
        let results = compressed_search(&vectors[5], &index, 5).unwrap();

        let found_ids: Vec<&str> = results.iter().map(|r| r.id.as_str()).collect();
        assert!(
            found_ids.contains(&"v5"),
            "Expected v5 in top-5, got {:?}",
            found_ids
        );
    }

    #[test]
    fn test_serialize_deserialize_round_trip() {
        let dim = 16;
        let r = generate_rotation_matrix(dim, 42);
        let cb = compute_codebook(4, dim as u32);
        let mut rng = make_rng(100);

        let mut vectors = Vec::new();
        let mut ids = Vec::new();
        for i in 0..5 {
            let mut v = random_vector(dim, &mut rng);
            normalize(&mut v);
            vectors.push(v);
            ids.push(format!("v{}", i));
        }

        let index = quantize(&vectors, &ids, &r, &cb, 4).unwrap();
        let serialized = serialize_index(&index);
        let deserialized = deserialize_index(&serialized).unwrap();

        assert_eq!(deserialized.bits, index.bits);
        assert_eq!(deserialized.dim, index.dim);
        assert_eq!(deserialized.count, index.count);
        assert_eq!(deserialized.codebook, index.codebook);
        assert_eq!(deserialized.rotation_matrix, index.rotation_matrix);

        for i in 0..index.vectors.len() {
            assert_eq!(deserialized.vectors[i].id, index.vectors[i].id);
            assert_eq!(deserialized.vectors[i].norm, index.vectors[i].norm);
            assert_eq!(deserialized.vectors[i].mean, index.vectors[i].mean);
            assert_eq!(deserialized.vectors[i].max_dev, index.vectors[i].max_dev);
            assert_eq!(deserialized.vectors[i].codes, index.vectors[i].codes);
        }
    }

    #[test]
    fn test_empty_index() {
        let dim = 16;
        let r = generate_rotation_matrix(dim, 42);
        let cb = compute_codebook(4, dim as u32);

        let index = quantize(&[], &[], &r, &cb, 4).unwrap();
        assert_eq!(index.count, 0);

        let results = compressed_search(&vec![0.0f32; dim], &index, 10).unwrap();
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_dimension_mismatch_errors() {
        let dim = 16;
        let r = generate_rotation_matrix(dim, 42);
        let cb = compute_codebook(4, dim as u32);

        let v16 = vec![0.0f32; 16];
        let v32 = vec![0.0f32; 32];
        let result = quantize(
            &[v16, v32],
            &["a".to_string(), "b".to_string()],
            &r,
            &cb,
            4,
        );
        assert!(result.is_err());
    }
}
