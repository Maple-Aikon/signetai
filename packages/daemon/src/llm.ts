/**
 * Daemon-wide LLM provider registry keyed by workload role.
 *
 * Keeps extraction and synthesis as separate runtime profiles while
 * sharing one singleton-style manager. Widget generation reads from the
 * synthesis role instead of maintaining its own duplicate holder.
 */

import type { LlmProvider } from "@signet/core";
import { type LogCategory, logger } from "./logger";
import { getSecret } from "./secrets.js";

export const LLM_ROLES = ["extraction", "synthesis", "widget"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

export class MissingOpenAiApiKeyError extends Error {
	constructor() {
		super("OPENAI_API_KEY not found in env or secrets");
		this.name = "MissingOpenAiApiKeyError";
	}
}

export interface OpenAiChatMessage {
	readonly role: "system" | "user" | "assistant";
	readonly content: string;
}

interface OpenAiChatOptions {
	readonly maxTokens?: number;
	readonly model?: string;
	readonly temperature?: number;
}

const ROLE_LABELS: Record<LlmRole, string> = {
	extraction: "LlmProvider",
	synthesis: "Synthesis LlmProvider",
	widget: "Widget LlmProvider",
};

const ROLE_LOG_CATEGORIES: Record<LlmRole, LogCategory> = {
	extraction: "pipeline",
	synthesis: "synthesis",
	widget: "widget",
};

const providers: Partial<Record<LlmRole, LlmProvider>> = {};
let cachedOpenAiApiKey: string | null | undefined;

function initProvider(role: LlmRole, instance: LlmProvider): void {
	if (providers[role]) {
		logger.warn(ROLE_LOG_CATEGORIES[role], `${ROLE_LABELS[role]} already initialised, skipping`);
		return;
	}
	providers[role] = instance;
}

export function getProvider(role: LlmRole): LlmProvider {
	const provider = providers[role];
	if (!provider) {
		throw new Error(`${ROLE_LABELS[role]} not initialised — call initProvider() first`);
	}
	return provider;
}

export function getInteractiveLlmProviderOrNull(): LlmProvider | null {
	return providers.synthesis ?? providers.extraction ?? null;
}

function closeProvider(role: LlmRole): void {
	delete providers[role];
	if (!providers.extraction && !providers.synthesis && !providers.widget) {
		cachedOpenAiApiKey = undefined;
	}
}

async function getOpenAiApiKey(): Promise<string> {
	if (cachedOpenAiApiKey !== undefined) {
		if (cachedOpenAiApiKey) return cachedOpenAiApiKey;
		throw new MissingOpenAiApiKeyError();
	}
	cachedOpenAiApiKey = process.env.OPENAI_API_KEY || (await getSecret("OPENAI_API_KEY").catch(() => ""));
	if (cachedOpenAiApiKey) return cachedOpenAiApiKey;
	throw new MissingOpenAiApiKeyError();
}

export async function callLegacyOpenAiChat(
	messages: readonly OpenAiChatMessage[],
	opts: OpenAiChatOptions = {},
): Promise<string> {
	const apiKey = await getOpenAiApiKey();
	const res = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: opts.model ?? "gpt-4o",
			max_tokens: opts.maxTokens ?? 2048,
			...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
			messages,
		}),
	});
	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`OpenAI API ${res.status}: ${errText.slice(0, 200)}`);
	}
	const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
	return data.choices?.[0]?.message?.content ?? "";
}

export function initLlmProvider(instance: LlmProvider): void {
	initProvider("extraction", instance);
}

export function getLlmProvider(): LlmProvider {
	return getProvider("extraction");
}

export function closeLlmProvider(): void {
	closeProvider("extraction");
}

export function initSynthesisProvider(instance: LlmProvider): void {
	initProvider("synthesis", instance);
}

export function getSynthesisProvider(): LlmProvider {
	return getProvider("synthesis");
}

export function closeSynthesisProvider(): void {
	closeProvider("synthesis");
}

export function initWidgetProvider(instance: LlmProvider): void {
	initProvider("widget", instance);
}

export function getWidgetProvider(): LlmProvider {
	return providers.widget ?? getProvider("synthesis");
}

export function closeWidgetProvider(): void {
	closeProvider("widget");
}

export function getInteractiveLlmProvider(): LlmProvider {
	const provider = getInteractiveLlmProviderOrNull();
	if (provider) return provider;
	throw new Error("Interactive LLM provider not initialised — neither synthesis nor extraction provider is available");
}
