pub const DEFAULT_EMBEDDING_DIMENSIONS: usize = 768;
pub const DEFAULT_HYBRID_ALPHA: f64 = 0.7;
pub const DEFAULT_REPLAY_WINDOW_MS: u64 = 5 * 60 * 1000;
pub const SCHEMA_VERSION: u32 = 3;
pub const SPEC_VERSION: &str = "1.0";
pub const SCHEMA_ID: &str = "signet/v1";
pub const DEFAULT_PORT: u16 = 3850;
pub const DEFAULT_HOST: &str = "localhost";

// Read pool size for concurrent readers
pub const READ_POOL_SIZE: u32 = 4;

// Writer channel capacities
pub const HIGH_PRIORITY_CAPACITY: usize = 64;
pub const LOW_PRIORITY_CAPACITY: usize = 256;
