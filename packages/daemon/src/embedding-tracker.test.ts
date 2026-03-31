import { describe, expect, it } from "bun:test";
import { computeEmbeddingRetryBackoffMs } from "./embedding-tracker";

describe("computeEmbeddingRetryBackoffMs", () => {
	it("backs off aggressively for repeated failures", () => {
		expect(computeEmbeddingRetryBackoffMs(1, 1_000)).toBe(60_000);
		expect(computeEmbeddingRetryBackoffMs(2, 1_000)).toBe(5 * 60_000);
		expect(computeEmbeddingRetryBackoffMs(3, 1_000)).toBe(30 * 60_000);
		expect(computeEmbeddingRetryBackoffMs(4, 1_000)).toBe(60 * 60_000);
	});

	it("respects larger poll intervals when they exceed the floor", () => {
		expect(computeEmbeddingRetryBackoffMs(1, 20_000)).toBe(100_000);
		expect(computeEmbeddingRetryBackoffMs(2, 20_000)).toBe(500_000);
	});
});
