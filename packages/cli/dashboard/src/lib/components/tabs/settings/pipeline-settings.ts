import {
	type PipelineProviderChoice,
	defaultPipelineModel,
	isPipelineProvider,
} from "@signet/core/pipeline-providers";

function toRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: null;
}

function readPipeline(agent: unknown): Record<string, unknown> | null {
	const root = toRecord(agent);
	const mem = toRecord(root?.memory);
	return toRecord(mem?.pipelineV2);
}

function readString(root: Record<string, unknown> | null, ...path: string[]): string | undefined {
	let node: unknown = root;
	for (const part of path) {
		const record = toRecord(node);
		if (!record) return undefined;
		node = record[part];
	}
	return typeof node === "string" && node.trim().length > 0 ? node : undefined;
}

function readNumber(root: Record<string, unknown> | null, ...path: string[]): number | undefined {
	let node: unknown = root;
	for (const part of path) {
		const record = toRecord(node);
		if (!record) return undefined;
		node = record[part];
	}
	return typeof node === "number" && Number.isFinite(node) ? node : undefined;
}

export function hasExplicitSynthesisConfig(agent: unknown): boolean {
	return toRecord(readPipeline(agent)?.synthesis) !== null;
}

export function resolveSynthesisProvider(agent: unknown): PipelineProviderChoice {
	const pipeline = readPipeline(agent);
	const explicit = readString(pipeline, "synthesis", "provider");
	if (isPipelineProvider(explicit)) return explicit;
	const flat = readString(pipeline, "extractionProvider");
	if (isPipelineProvider(flat)) return flat;
	const nested = readString(pipeline, "extraction", "provider");
	if (isPipelineProvider(nested)) return nested;
	return "ollama";
}

export function resolveSynthesisModel(agent: unknown): string {
	const pipeline = readPipeline(agent);
	const provider = resolveSynthesisProvider(agent);
	const explicit = readString(pipeline, "synthesis", "model");
	if (explicit) return explicit;
	if (hasExplicitSynthesisConfig(agent)) return defaultPipelineModel(provider);
	return (
		readString(pipeline, "extractionModel") ??
		readString(pipeline, "extraction", "model") ??
		defaultPipelineModel(provider)
	);
}

export function resolveSynthesisEndpoint(agent: unknown): string {
	const pipeline = readPipeline(agent);
	const explicit = readString(pipeline, "synthesis", "endpoint") ?? readString(pipeline, "synthesis", "base_url");
	if (explicit) return explicit;
	if (hasExplicitSynthesisConfig(agent)) return "";
	return (
		readString(pipeline, "extraction", "endpoint") ??
		readString(pipeline, "extraction", "base_url") ??
		readString(pipeline, "extractionEndpoint") ??
		readString(pipeline, "extractionBaseUrl") ??
		""
	);
}

export function resolveSynthesisTimeout(agent: unknown): number {
	const pipeline = readPipeline(agent);
	const explicit = readNumber(pipeline, "synthesis", "timeout");
	if (explicit !== undefined) return explicit;
	if (hasExplicitSynthesisConfig(agent)) return 120000;
	return readNumber(pipeline, "extraction", "timeout") ?? readNumber(pipeline, "extractionTimeout") ?? 90000;
}
