import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatYaml, parseSimpleYaml } from "./yaml";

export const PIPELINE_CONFIG_FILES = ["agent.yaml", "AGENT.yaml", "config.yaml"] as const;

export interface PipelinePauseState {
	readonly file: string | null;
	readonly exists: boolean;
	readonly enabled: boolean;
	readonly paused: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function findPipelineConfigFile(dir: string): string | null {
	for (const name of PIPELINE_CONFIG_FILES) {
		const file = join(dir, name);
		if (existsSync(file)) {
			return file;
		}
	}
	return null;
}

function readCfg(dir: string): { readonly cfg: Record<string, unknown> | null; readonly file: string | null } {
	const file = findPipelineConfigFile(dir);
	if (file === null) {
		return { file: null, cfg: null };
	}
	const parsed = parseSimpleYaml(readFileSync(file, "utf-8"));
	return { file, cfg: isRecord(parsed) ? parsed : {} };
}

function readMem(cfg: Record<string, unknown>): Record<string, unknown> | null {
	return isRecord(cfg.memory) ? cfg.memory : null;
}

function readPipeline(cfg: Record<string, unknown>): Record<string, unknown> | null {
	const mem = readMem(cfg);
	return mem && isRecord(mem.pipelineV2) ? mem.pipelineV2 : null;
}

export function readPipelinePauseState(dir: string): PipelinePauseState {
	const { cfg, file } = readCfg(dir);
	if (cfg === null) {
		return { file: null, exists: false, enabled: false, paused: false };
	}

	const p2 = readPipeline(cfg);
	return {
		file,
		exists: true,
		enabled: p2?.enabled !== false,
		paused: p2?.paused === true,
	};
}

export function setPipelinePaused(dir: string, paused: boolean): PipelinePauseState {
	const { cfg, file } = readCfg(dir);
	if (file === null) {
		throw new Error("No Signet config file found. Run `signet setup` first.");
	}

	const root = cfg ?? {};
	const mem = isRecord(root.memory) ? root.memory : {};
	const p2 = isRecord(mem.pipelineV2) ? mem.pipelineV2 : {};
	const nextP2 = { ...p2, paused };
	const nextMem = { ...mem, pipelineV2: nextP2 };
	const next = { ...root, memory: nextMem };

	writeFileSync(file, formatYaml(next));

	return {
		file,
		exists: true,
		enabled: p2.enabled !== false,
		paused,
	};
}
