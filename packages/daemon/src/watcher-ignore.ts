import { isAbsolute, join, normalize, resolve } from "node:path";
import { loadMemoryConfig } from "./memory-config";
import { resolvePredictorCheckpointPath } from "./predictor-client";

function normalizePath(path: string): string {
	return normalize(path);
}

function resolveForComparison(path: string): string {
	return normalizePath(isAbsolute(path) ? path : resolve(path));
}

export function createAgentsWatcherIgnoreMatcher(agentsDir: string): (path: string) => boolean {
	const defaultPredictorCheckpoint = normalizePath(join(agentsDir, "memory", "predictor", "model.bin"));
	const configuredPredictorCheckpoint = resolveForComparison(
		resolvePredictorCheckpointPath(loadMemoryConfig(agentsDir).pipelineV2.predictor),
	);
	const agentRoot = resolveForComparison(join(agentsDir, "agents"));
	const ignoredPaths = new Set([defaultPredictorCheckpoint, configuredPredictorCheckpoint]);

	return (path: string): boolean => {
		const normalizedPath = resolveForComparison(path);
		const relativeToAgentsRoot = normalizedPath.startsWith(agentRoot) ? normalizedPath.slice(agentRoot.length) : "";
		const agentSegments = relativeToAgentsRoot.split(/[\\/]+/).filter(Boolean);
		const isGeneratedWorkspacePath =
			agentSegments.length >= 2 && agentSegments[1] === "workspace" && normalizedPath.endsWith("AGENTS.md");
		return (
			isGeneratedWorkspacePath ||
			ignoredPaths.has(normalizedPath) ||
			normalizedPath.endsWith(".db-wal") ||
			normalizedPath.endsWith(".db-shm") ||
			normalizedPath.endsWith(".db-journal")
		);
	};
}
