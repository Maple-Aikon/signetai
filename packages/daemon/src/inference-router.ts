import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
	LlmGenerateResult,
	LlmProvider,
	LlmUsage,
	RouteDecision,
	RouteRequest,
	RouterResult,
	RoutingConfig,
	RoutingOperationKind,
	RoutingRuntimeSnapshot,
	RoutingRuntimeState,
} from "@signet/core";
import {
	allTargetRefs,
	compileLegacyRoutingConfig,
	parseRoutingConfig,
	parseRoutingTargetRef,
	parseYamlDocument,
	resolveRoutingDecision,
} from "@signet/core";
import { logger } from "./logger";
import { loadMemoryConfig } from "./memory-config";
import {
	createAnthropicProvider,
	createClaudeCodeProvider,
	createCodexProvider,
	createOllamaProvider,
	createOpenCodeProvider,
	createOpenRouterProvider,
	generateWithTracking,
} from "./pipeline/provider";
import { resolveDefaultOllamaFallbackMaxContextTokens } from "./pipeline/provider";
import { getSecret } from "./secrets";

const SNAPSHOT_TTL_MS = 15_000;
const DEFAULT_OPENCODE_BASE_URL = "http://127.0.0.1:4096";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "http://127.0.0.1:1234/v1";

export interface InferenceExecutionAttempt {
	readonly targetRef: string;
	readonly ok: boolean;
	readonly durationMs: number;
	readonly error?: string;
	readonly usage?: LlmUsage | null;
}

export interface InferenceExecutionResult {
	readonly text: string;
	readonly usage: LlmUsage | null;
	readonly decision: RouteDecision;
	readonly attempts: readonly InferenceExecutionAttempt[];
}

export interface InferenceAccountSummary {
	readonly kind: string;
	readonly providerFamily: string;
	readonly label?: string;
}

export interface InferenceTargetSummary {
	readonly kind: string;
	readonly executor: string;
	readonly account?: string;
	readonly privacy?: string;
	readonly models: Readonly<Record<string, { readonly model: string; readonly label?: string }>>;
}

export interface InferenceStatusSummary {
	readonly enabled: boolean;
	readonly source: RoutingConfig["source"] | "disabled";
	readonly defaultPolicy?: string;
	readonly defaultAgentId: string;
	readonly policies: readonly string[];
	readonly taskClasses: readonly string[];
	readonly targetRefs: readonly string[];
	readonly workloadBindings: {
		readonly interactive?: string;
		readonly memoryExtraction?: string;
		readonly sessionSynthesis?: string;
	};
	readonly accounts: Readonly<Record<string, InferenceAccountSummary>>;
	readonly targets: Readonly<Record<string, InferenceTargetSummary>>;
	readonly agents: readonly string[];
	readonly runtimeSnapshot: RoutingRuntimeSnapshot;
}

interface LoadedRoutingConfig {
	readonly config: RoutingConfig;
	readonly signature: string;
	readonly path: string | null;
}

interface SnapshotCacheEntry {
	readonly signature: string;
	readonly expiresAt: number;
	readonly snapshot: RoutingRuntimeSnapshot;
}

interface OpenAiCompatibleProviderConfig {
	readonly name: string;
	readonly model: string;
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly defaultTimeoutMs: number;
}

function createOpenAiCompatibleProvider(config: OpenAiCompatibleProviderConfig): LlmProvider {
	const baseUrl = config.baseUrl.replace(/\/+$/, "");
	const headers = (): Record<string, string> => ({
		"Content-Type": "application/json",
		...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
	});

	async function call(prompt: string, opts?: { timeoutMs?: number; maxTokens?: number }): Promise<LlmGenerateResult> {
		const res = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				model: config.model,
				messages: [{ role: "user", content: prompt }],
				max_tokens: opts?.maxTokens ?? 4096,
			}),
			signal: AbortSignal.timeout(opts?.timeoutMs ?? config.defaultTimeoutMs),
		});
		if (!res.ok) {
			const detail = (await res.text().catch(() => "")).slice(0, 300);
			throw new Error(`${config.name} HTTP ${res.status}: ${detail}`);
		}
		const body = (await res.json()) as {
			choices?: Array<{ message?: { content?: string | Array<{ text?: string; type?: string }> } }>;
			usage?: {
				prompt_tokens?: number;
				completion_tokens?: number;
				total_tokens?: number;
			};
		};
		const content = body.choices?.[0]?.message?.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
							.join("\n")
					: "";
		if (!text.trim()) {
			throw new Error(`${config.name} returned empty response`);
		}
		return {
			text,
			usage: body.usage
				? {
						inputTokens: body.usage.prompt_tokens ?? null,
						outputTokens: body.usage.completion_tokens ?? null,
						cacheReadTokens: null,
						cacheCreationTokens: null,
						totalCost: null,
						totalDurationMs: null,
					}
				: null,
		};
	}

	return {
		name: config.name,
		async generate(prompt, opts): Promise<string> {
			const result = await call(prompt, opts);
			return result.text;
		},
		async generateWithUsage(prompt, opts): Promise<LlmGenerateResult> {
			return call(prompt, opts);
		},
		async available(): Promise<boolean> {
			try {
				const res = await fetch(`${baseUrl}/models`, {
					headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
					signal: AbortSignal.timeout(5_000),
				});
				return res.ok;
			} catch {
				return false;
			}
		},
	};
}

function isLocalBaseUrl(value: string | undefined): boolean {
	if (!value) return true;
	try {
		const url = new URL(value);
		return ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
	} catch {
		return false;
	}
}

function normalizePromptPreview(prompt: string): string {
	return prompt.slice(0, 8000);
}

function readRoutingPath(agentsDir: string): string | null {
	for (const name of ["agent.yaml", "AGENT.yaml"]) {
		const path = join(agentsDir, name);
		if (existsSync(path)) return path;
	}
	return null;
}

function defaultAgentIdForConfig(config: RoutingConfig): string {
	if (config.agents.default) return "default";
	const ids = Object.keys(config.agents);
	if (ids.length === 1) return ids[0];
	return "default";
}

function formatExecutionError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function buildPromptFromMessages(
	messages: readonly Array<{ readonly role: string; readonly content: string }>,
): string {
	return messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
}

export class InferenceRouter {
	private snapshotCache: SnapshotCacheEntry | null = null;
	private readonly providerCache = new Map<string, Promise<LlmProvider>>();
	private providerCacheSignature: string | null = null;

	constructor(private readonly agentsDir: string) {}

	private async loadConfig(): Promise<RouterResult<LoadedRoutingConfig>> {
		let raw: unknown = {};
		const path = readRoutingPath(this.agentsDir);
		let signature = "no-config";
		if (path) {
			try {
				const stat = statSync(path);
				signature = `${path}:${stat.mtimeMs}:${stat.size}`;
				raw = parseYamlDocument(readFileSync(path, "utf-8"));
			} catch (error) {
				return {
					ok: false,
					error: {
						code: "invalid-config",
						message: `Failed to parse routing config: ${formatExecutionError(error)}`,
					},
				};
			}
		}

		let legacy: RoutingConfig;
		try {
			const memoryCfg = loadMemoryConfig(this.agentsDir);
			legacy = compileLegacyRoutingConfig({
				extraction: memoryCfg.pipelineV2.extraction,
				synthesis: memoryCfg.pipelineV2.synthesis,
			});
		} catch (error) {
			return {
				ok: false,
				error: {
					code: "invalid-config",
					message: `Failed to resolve legacy routing config: ${formatExecutionError(error)}`,
				},
			};
		}

		const parsed = parseRoutingConfig(raw, legacy);
		if (!parsed.ok) return parsed;

		if (this.providerCacheSignature !== signature) {
			this.providerCache.clear();
			this.providerCacheSignature = signature;
			this.snapshotCache = null;
		}

		return {
			ok: true,
			value: {
				config: parsed.value,
				signature,
				path,
			},
		};
	}

	async hasExplicitRouting(): Promise<boolean> {
		const loaded = await this.loadConfig();
		return loaded.ok && loaded.value.config.source === "explicit" && loaded.value.config.enabled;
	}

	async hasWorkload(operation: RoutingOperationKind): Promise<boolean> {
		const loaded = await this.loadConfig();
		if (!loaded.ok || !loaded.value.config.enabled) return false;
		const config = loaded.value.config;
		switch (operation) {
			case "memory_extraction":
				return Boolean(config.workloads?.memoryExtraction ?? config.defaultPolicy);
			case "session_synthesis":
				return Boolean(config.workloads?.sessionSynthesis ?? config.defaultPolicy);
			default:
				return Boolean(config.workloads?.interactive ?? config.defaultPolicy);
		}
	}

	private async resolveCredential(credentialRef: string | undefined): Promise<string | undefined> {
		if (!credentialRef) return undefined;
		const envValue = process.env[credentialRef];
		if (typeof envValue === "string" && envValue.trim().length > 0) {
			return envValue.trim();
		}
		try {
			return await getSecret(credentialRef);
		} catch {
			return undefined;
		}
	}

	private async createProvider(loaded: LoadedRoutingConfig, targetId: string, modelId: string): Promise<LlmProvider> {
		const cacheKey = `${loaded.signature}:${targetId}/${modelId}`;
		const cached = this.providerCache.get(cacheKey);
		if (cached) return cached;

		const build = (async (): Promise<LlmProvider> => {
			const target = loaded.config.targets[targetId];
			const model = target?.models[modelId];
			if (!target || !model) {
				throw new Error(`Unknown routing target ${targetId}/${modelId}`);
			}
			const account = target.account ? loaded.config.accounts[target.account] : undefined;
			const credential = await this.resolveCredential(account?.credentialRef);
			switch (target.executor) {
				case "anthropic":
					if (!credential) throw new Error(`Missing credential for account ${target.account ?? "anthropic"}`);
					return createAnthropicProvider({
						model: model.model,
						apiKey: credential,
						baseUrl: target.endpoint ?? "https://api.anthropic.com",
					});
				case "openrouter":
					if (!credential) throw new Error(`Missing credential for account ${target.account ?? "openrouter"}`);
					return createOpenRouterProvider({
						model: model.model,
						apiKey: credential,
						baseUrl: target.endpoint ?? "https://openrouter.ai/api/v1",
						referer: process.env.OPENROUTER_HTTP_REFERER,
						title: process.env.OPENROUTER_TITLE,
					});
				case "ollama":
					return createOllamaProvider({
						model: model.model,
						baseUrl: target.endpoint ?? DEFAULT_OLLAMA_BASE_URL,
					});
				case "claude-code":
					return createClaudeCodeProvider({ model: model.model });
				case "codex":
					return createCodexProvider({ model: model.model });
				case "opencode":
					return createOpenCodeProvider({
						model: model.model,
						baseUrl: target.endpoint ?? DEFAULT_OPENCODE_BASE_URL,
						ollamaFallbackBaseUrl: DEFAULT_OLLAMA_BASE_URL,
						ollamaFallbackMaxContextTokens: resolveDefaultOllamaFallbackMaxContextTokens(),
					});
				case "openai-compatible":
					return createOpenAiCompatibleProvider({
						name: `openai-compatible:${model.model}`,
						model: model.model,
						baseUrl: target.endpoint ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
						apiKey: credential,
						defaultTimeoutMs: 60_000,
					});
			}
		})();

		this.providerCache.set(cacheKey, build);
		return build;
	}

	private async runtimeStateForTarget(loaded: LoadedRoutingConfig, targetRef: string): Promise<RoutingRuntimeState> {
		const parsed = parseRoutingTargetRef(targetRef);
		if (!parsed.ok) {
			return {
				available: false,
				health: "blocked",
				circuitOpen: false,
				accountState: "missing",
				unavailableReason: parsed.error.message,
			};
		}
		const target = loaded.config.targets[parsed.value.targetId];
		const model = target?.models[parsed.value.modelId];
		if (!target || !model) {
			return {
				available: false,
				health: "blocked",
				circuitOpen: false,
				accountState: "missing",
				unavailableReason: "target not found",
			};
		}
		const account = target.account ? loaded.config.accounts[target.account] : undefined;
		const needsCredential =
			target.executor === "anthropic" ||
			target.executor === "openrouter" ||
			(target.executor === "openai-compatible" && !isLocalBaseUrl(target.endpoint));
		if (target.account && !account) {
			return {
				available: false,
				health: "blocked",
				circuitOpen: false,
				accountState: "missing",
				unavailableReason: `account ${target.account} not found`,
			};
		}
		if (needsCredential) {
			const credential = await this.resolveCredential(account?.credentialRef);
			if (!credential) {
				return {
					available: false,
					health: "blocked",
					circuitOpen: false,
					accountState: "missing",
					unavailableReason: `missing credential${target.account ? ` for ${target.account}` : ""}`,
				};
			}
		}

		try {
			const provider = await this.createProvider(loaded, parsed.value.targetId, parsed.value.modelId);
			const available = await provider.available();
			return {
				available,
				health: available ? "healthy" : "blocked",
				circuitOpen: false,
				accountState: available ? "ready" : target.kind === "subscription_session" ? "expired" : "unknown",
				...(available ? {} : { unavailableReason: "executor unavailable" }),
			};
		} catch (error) {
			return {
				available: false,
				health: "blocked",
				circuitOpen: false,
				accountState: target.kind === "subscription_session" ? "expired" : needsCredential ? "missing" : "unknown",
				unavailableReason: formatExecutionError(error),
			};
		}
	}

	private async runtimeSnapshot(loaded: LoadedRoutingConfig, refresh = false): Promise<RoutingRuntimeSnapshot> {
		if (
			!refresh &&
			this.snapshotCache &&
			this.snapshotCache.signature === loaded.signature &&
			this.snapshotCache.expiresAt > Date.now()
		) {
			return this.snapshotCache.snapshot;
		}
		const entries = await Promise.all(
			allTargetRefs(loaded.config).map(async (targetRef) => {
				const state = await this.runtimeStateForTarget(loaded, targetRef);
				return [targetRef, state] as const;
			}),
		);
		const snapshot: RoutingRuntimeSnapshot = {
			targets: Object.fromEntries(entries),
		};
		this.snapshotCache = {
			signature: loaded.signature,
			expiresAt: Date.now() + SNAPSHOT_TTL_MS,
			snapshot,
		};
		return snapshot;
	}

	async explain(request: RouteRequest, refresh = false): Promise<RouterResult<RouteDecision>> {
		const loaded = await this.loadConfig();
		if (!loaded.ok) return loaded;
		const snapshot = await this.runtimeSnapshot(loaded.value, refresh);
		return resolveRoutingDecision(
			loaded.value.config,
			{
				...request,
				agentId: request.agentId ?? defaultAgentIdForConfig(loaded.value.config),
			},
			snapshot,
		);
	}

	async execute(
		request: RouteRequest,
		prompt: string,
		opts?: { readonly timeoutMs?: number; readonly maxTokens?: number; readonly refresh?: boolean },
	): Promise<RouterResult<InferenceExecutionResult>> {
		const loaded = await this.loadConfig();
		if (!loaded.ok) return loaded;
		const decision = await this.explain(request, opts?.refresh ?? false);
		if (!decision.ok) return decision;
		const attempts: InferenceExecutionAttempt[] = [];
		for (const targetRef of [decision.value.targetRef, ...decision.value.fallbackTargetRefs]) {
			const parsed = parseRoutingTargetRef(targetRef);
			if (!parsed.ok) {
				attempts.push({
					targetRef,
					ok: false,
					durationMs: 0,
					error: parsed.error.message,
				});
				continue;
			}
			const startedAt = Date.now();
			try {
				const provider = await this.createProvider(loaded.value, parsed.value.targetId, parsed.value.modelId);
				const result = await generateWithTracking(provider, prompt, {
					timeoutMs: opts?.timeoutMs,
					maxTokens: opts?.maxTokens,
				});
				attempts.push({
					targetRef,
					ok: true,
					durationMs: Date.now() - startedAt,
					usage: result.usage,
				});
				return {
					ok: true,
					value: {
						text: result.text,
						usage: result.usage,
						decision: decision.value,
						attempts,
					},
				};
			} catch (error) {
				const message = formatExecutionError(error);
				logger.warn("routing", `Inference target ${targetRef} failed`, {
					targetRef,
					error: message.slice(0, 200),
				});
				attempts.push({
					targetRef,
					ok: false,
					durationMs: Date.now() - startedAt,
					error: message,
				});
			}
		}
		return {
			ok: false,
			error: {
				code: "execution-failed",
				message: "All routed targets failed.",
				details: { attempts },
			},
		};
	}

	createWorkloadProvider(operation: RoutingOperationKind, defaultAgentId?: string): LlmProvider {
		const router = this;
		return {
			name: `routing:${operation}`,
			async generate(prompt, opts): Promise<string> {
				const result = await router.execute(
					{
						agentId: defaultAgentId,
						operation,
						promptPreview: normalizePromptPreview(prompt),
					},
					prompt,
					opts,
				);
				if (!result.ok) {
					throw new Error(result.error.message);
				}
				return result.value.text;
			},
			async generateWithUsage(prompt, opts): Promise<LlmGenerateResult> {
				const result = await router.execute(
					{
						agentId: defaultAgentId,
						operation,
						promptPreview: normalizePromptPreview(prompt),
					},
					prompt,
					opts,
				);
				if (!result.ok) {
					throw new Error(result.error.message);
				}
				return { text: result.value.text, usage: result.value.usage };
			},
			async available(): Promise<boolean> {
				return router.hasWorkload(operation);
			},
		};
	}

	async status(refresh = false): Promise<RouterResult<InferenceStatusSummary>> {
		const loaded = await this.loadConfig();
		if (!loaded.ok) return loaded;
		const snapshot = await this.runtimeSnapshot(loaded.value, refresh);
		const accounts = Object.fromEntries(
			Object.entries(loaded.value.config.accounts).map(([accountId, account]) => [
				accountId,
				{
					kind: account.kind,
					providerFamily: account.providerFamily,
					...(account.label ? { label: account.label } : {}),
				},
			]),
		) as Record<string, InferenceAccountSummary>;
		const targets = Object.fromEntries(
			Object.entries(loaded.value.config.targets).map(([targetId, target]) => [
				targetId,
				{
					kind: target.kind,
					executor: target.executor,
					...(target.account ? { account: target.account } : {}),
					...(target.privacy ? { privacy: target.privacy } : {}),
					models: Object.fromEntries(
						Object.entries(target.models).map(([modelId, model]) => [
							modelId,
							{ model: model.model, ...(model.label ? { label: model.label } : {}) },
						]),
					),
				},
			]),
		) as Record<string, InferenceTargetSummary>;
		return {
			ok: true,
			value: {
				enabled: loaded.value.config.enabled,
				source: loaded.value.config.enabled ? loaded.value.config.source : "disabled",
				...(loaded.value.config.defaultPolicy ? { defaultPolicy: loaded.value.config.defaultPolicy } : {}),
				defaultAgentId: defaultAgentIdForConfig(loaded.value.config),
				policies: Object.keys(loaded.value.config.policies),
				taskClasses: Object.keys(loaded.value.config.taskClasses),
				targetRefs: allTargetRefs(loaded.value.config),
				workloadBindings: {
					interactive:
						loaded.value.config.workloads?.interactive?.policy ?? loaded.value.config.workloads?.interactive?.target,
					memoryExtraction:
						loaded.value.config.workloads?.memoryExtraction?.policy ??
						loaded.value.config.workloads?.memoryExtraction?.target,
					sessionSynthesis:
						loaded.value.config.workloads?.sessionSynthesis?.policy ??
						loaded.value.config.workloads?.sessionSynthesis?.target,
				},
				accounts,
				targets,
				agents: Object.keys(loaded.value.config.agents),
				runtimeSnapshot: snapshot,
			},
		};
	}

	async gatewayModels(refresh = false): Promise<RouterResult<readonly string[]>> {
		const status = await this.status(refresh);
		if (!status.ok) return status;
		return {
			ok: true,
			value: [
				"signet:auto",
				...status.value.policies.map((policyId) => `policy:${policyId}`),
				...status.value.targetRefs,
			],
		};
	}

	parseGatewayModel(model: string | undefined): Pick<RouteRequest, "explicitPolicy" | "explicitTargets"> {
		const trimmed = model?.trim();
		if (!trimmed || trimmed === "signet:auto" || trimmed === "auto") return {};
		if (trimmed.startsWith("policy:")) {
			return { explicitPolicy: trimmed.slice("policy:".length) };
		}
		if (trimmed.includes("/")) {
			return { explicitTargets: [trimmed] };
		}
		return {};
	}

	buildGatewayPrompt(messages: readonly Array<{ readonly role: string; readonly content: string }>): string {
		return buildPromptFromMessages(messages);
	}
}

let inferenceRouter: InferenceRouter | null = null;
let inferenceRouterAgentsDir: string | null = null;

export function getOrCreateInferenceRouter(agentsDir: string): InferenceRouter {
	if (!inferenceRouter || inferenceRouterAgentsDir !== agentsDir) {
		inferenceRouter = new InferenceRouter(agentsDir);
		inferenceRouterAgentsDir = agentsDir;
	}
	return inferenceRouter;
}

export function getInferenceRouterOrNull(): InferenceRouter | null {
	return inferenceRouter;
}

export function resetInferenceRouterForTests(): void {
	inferenceRouter = null;
	inferenceRouterAgentsDir = null;
}
