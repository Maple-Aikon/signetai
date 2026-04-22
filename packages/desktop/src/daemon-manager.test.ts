import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { healthWorkspaceMismatch } from "./daemon-workspace.js";

describe("desktop daemon workspace matching", () => {
	test("accepts matching health agentsDir", () => {
		expect(healthWorkspaceMismatch("/tmp/signet", "/tmp/signet")).toBeNull();
	});

	test("reports mismatched daemon workspaces", () => {
		expect(healthWorkspaceMismatch("/tmp/expected", "/tmp/actual")).toEqual({
			expected: resolve("/tmp/expected"),
			actual: resolve("/tmp/actual"),
		});
	});

	test("treats missing agentsDir as a mismatch", () => {
		expect(healthWorkspaceMismatch("/tmp/expected", null)).toEqual({
			expected: resolve("/tmp/expected"),
			actual: "unknown",
		});
	});
});
