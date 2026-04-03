/**
 * Daemon-wide LLM provider registry keyed by workload role.
 *
 * Keeps extraction and synthesis as separate runtime profiles while
 * sharing one singleton-style manager. Widget generation reads from the
 * synthesis role instead of maintaining its own duplicate holder.
 */

import type { LlmProvider } from "@signet/core";
import { logger, type LogCategory } from "./logger";

export const LLM_ROLES = ["extraction", "synthesis"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

const ROLE_LABELS: Record<LlmRole, string> = {
	extraction: "LlmProvider",
	synthesis: "Synthesis LlmProvider",
};

const ROLE_LOG_CATEGORIES: Record<LlmRole, LogCategory> = {
	extraction: "pipeline",
	synthesis: "synthesis",
};

const providers: Partial<Record<LlmRole, LlmProvider>> = {};

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

function closeProvider(role: LlmRole): void {
	delete providers[role];
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

export function getWidgetProvider(): LlmProvider {
	return getProvider("synthesis");
}

export function getInteractiveLlmProvider(): LlmProvider {
	return providers.synthesis ?? providers.extraction ?? getProvider("synthesis");
}
