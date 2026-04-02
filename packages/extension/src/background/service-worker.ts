/**
 * Signet background service worker
 * Handles: context menus, health polling, badge updates, and message routing
 */

import { checkHealth, dispatchBrowserTool, rememberMemory } from "../shared/api.js";
import { getConfig } from "../shared/config.js";

type HealthState = "healthy" | "degraded" | "offline";

interface InjectResult {
	readonly ok: boolean;
	readonly tabId?: number;
	readonly error?: string;
}

interface AskOverlayResponse {
	readonly ok: boolean;
	readonly error?: string;
}

interface AskOverlayOptions {
	readonly text?: string;
	readonly presetAction?: "transcribe";
	readonly autoSubmit?: boolean;
	readonly promptText?: string;
}

interface AskSignetModelOption {
	readonly id: string;
	readonly label: string;
}

interface PageContext {
	readonly pageTitle: string;
	readonly pageUrl: string;
	readonly selectedText: string;
	readonly links: readonly string[];
	readonly images: readonly string[];
	readonly videos: readonly string[];
	readonly audio: readonly string[];
	readonly files: readonly { name: string; type: string; size: number }[];
}

const MENU_IDS = {
	root: "signet-tools",
	askSignet: "signet-ask-signet",
	rememberSelection: "signet-remember-selection",
	transcribe: "signet-transcribe",
	sendToSignet: "signet-send-to-signet",
	viewMcpServers: "signet-view-mcp-servers",
	bookmark: "signet-bookmark",
} as const;

const BADGE_COLORS: Record<HealthState, string> = {
	healthy: "#4a7a5e",
	degraded: "#8a7a4a",
	offline: "#8a4a48",
};

const BADGE_TEXT: Record<HealthState, string> = {
	healthy: "",
	degraded: "!",
	offline: "X",
};

const MAX_TRANSCRIBE_CHARS = 10_000;

let currentState: HealthState = "offline";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/$/, "");
}

function buildAuthHeaders(authToken: string): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (authToken) {
		headers.Authorization = `Bearer ${authToken}`;
	}
	return headers;
}

function resolveDaemonCandidates(primaryDaemonUrl: string): string[] {
	const normalizedPrimary = normalizeBaseUrl(primaryDaemonUrl);
	const candidates = [normalizedPrimary];

	try {
		const parsed = new URL(normalizedPrimary);
		const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
		if (isLocal) {
			const altHost = parsed.hostname === "localhost" ? "127.0.0.1" : "localhost";
			const protocol = parsed.protocol || "http:";
			if (parsed.port !== "3850") {
				candidates.push(`${protocol}//${parsed.hostname}:3850`);
			}
			candidates.push(`${protocol}//${altHost}${parsed.port ? `:${parsed.port}` : ""}`);
			candidates.push(`${protocol}//${altHost}:3850`);
		}
	} catch {
		// Ignore invalid user-supplied URL and fall back to default localhost candidates below.
	}

	candidates.push("http://127.0.0.1:3850", "http://localhost:3850");
	return [...new Set(candidates.map((url) => normalizeBaseUrl(url)).filter(Boolean))];
}

async function fetchDaemonWithFallback(
	path: string,
	init: RequestInit,
): Promise<{ ok: true; response: Response } | { ok: false; error: string }> {
	const config = await getConfig();
	const attempts: string[] = [];
	const candidates = resolveDaemonCandidates(config.daemonUrl);

	for (const baseUrl of candidates) {
		try {
			const response = await fetch(`${baseUrl}${path}`, init);
			if (response.ok) return { ok: true, response };
			if (response.status < 500 && response.status !== 404) {
				return { ok: true, response };
			}
			const detail = (await response.text().catch(() => "")).trim();
			attempts.push(`${baseUrl} (${response.status}${detail ? `: ${detail}` : ""})`);
		} catch (error) {
			attempts.push(`${baseUrl} (${error instanceof Error ? error.message : "request failed"})`);
		}
	}

	return {
		ok: false,
		error: `Unable to reach Signet daemon. Tried: ${attempts.join("; ") || "no endpoints"}`,
	};
}


async function fetchAskSignetModels(): Promise<{
	ok: boolean;
	options?: AskSignetModelOption[];
	defaultModelId?: string;
	error?: string;
}> {
	const config = await getConfig();
	const request = await fetchDaemonWithFallback("/api/os/chat/models", {
		method: "GET",
		headers: buildAuthHeaders(config.authToken),
	});
	if (!request.ok) {
		return { ok: false, error: request.error };
	}
	const response = request.response;
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		return { ok: false, error: detail || `Model request failed (${response.status})` };
	}

	const data = (await response.json()) as {
		options?: AskSignetModelOption[];
		defaultModelId?: string;
	};
	const options = Array.isArray(data.options) ? data.options.filter((m) => m && m.id && m.label) : [];
	if (options.length === 0) {
		return { ok: false, error: "No providers found." };
	}
	return { ok: true, options, defaultModelId: data.defaultModelId };
}

async function askSignetChat(message: string, modelId: string): Promise<{ ok: boolean; response?: string; error?: string }> {
	const config = await getConfig();
	const request = await fetchDaemonWithFallback("/api/os/chat", {
		method: "POST",
		headers: buildAuthHeaders(config.authToken),
		body: JSON.stringify({ message, modelId }),
	});
	if (!request.ok) {
		return { ok: false, error: request.error };
	}
	const response = request.response;
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		return { ok: false, error: detail || `Request failed (${response.status})` };
	}

	const data = (await response.json()) as { response?: string };
	const text = (data.response ?? "").trim();
	if (!text) {
		return { ok: false, error: "Signet returned an empty response." };
	}
	return { ok: true, response: text };
}

function buildDashboardUrl(baseUrl: string, hash = ""): string {
	const cleaned = normalizeBaseUrl(baseUrl);
	if (!hash) return cleaned;
	return `${cleaned}/#${hash}`;
}

function createContextMenus(): void {
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({
			id: MENU_IDS.root,
			title: "Signet",
			contexts: ["all"],
		});

		chrome.contextMenus.create({
			id: MENU_IDS.askSignet,
			parentId: MENU_IDS.root,
			title: "Ask Signet",
			contexts: ["all"],
		});

		chrome.contextMenus.create({
			id: MENU_IDS.transcribe,
			parentId: MENU_IDS.root,
			title: "Transcribe",
			contexts: ["all"],
		});

		chrome.contextMenus.create({
			id: MENU_IDS.sendToSignet,
			parentId: MENU_IDS.root,
			title: "Send to Signet Os",
			contexts: ["all"],
		});

		chrome.contextMenus.create({
			id: MENU_IDS.viewMcpServers,
			parentId: MENU_IDS.root,
			title: "View MCP Servers",
			contexts: ["all"],
		});

		chrome.contextMenus.create({
			id: MENU_IDS.bookmark,
			parentId: MENU_IDS.root,
			title: "Bookmark",
			contexts: ["all"],
		});

		chrome.contextMenus.create({
			id: MENU_IDS.rememberSelection,
			parentId: MENU_IDS.root,
			title: "Remember Selection",
			contexts: ["all"],
		});
	});
}

chrome.runtime.onInstalled.addListener(() => {
	createContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
	createContextMenus();
});

// --- Keyboard shortcut ---

chrome.commands.onCommand.addListener((command) => {
	if (command !== "save-selection") return;

	chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
		const tab = tabs[0];
		if (!tab?.id) return;

		chrome.tabs.sendMessage(tab.id, {
			action: "trigger-save-shortcut",
		});
	});
});

async function sendTabMessage<T>(tabId: number, message: unknown): Promise<T | null> {
	return new Promise((resolve) => {
		chrome.tabs.sendMessage(tabId, message, (response) => {
			if (chrome.runtime.lastError) {
				resolve(null);
				return;
			}
			resolve((response as T | null) ?? null);
		});
	});
}

function formatSelectionBundle(context: PageContext): string {
	const lines: string[] = [
		"--- signet-selection-bundle.txt ---",
		`source_title: ${context.pageTitle || "Untitled"}`,
		`source_url: ${context.pageUrl || "unknown"}`,
		`created_at: ${new Date().toISOString()}`,
		"",
		"## Text",
		context.selectedText || "(none)",
		"",
		"## Links",
		...(context.links.length > 0 ? context.links : ["(none)"]),
		"",
		"## Images",
		...(context.images.length > 0 ? context.images : ["(none)"]),
		"",
		"## Videos",
		...(context.videos.length > 0 ? context.videos : ["(none)"]),
		"",
		"## Audio",
		...(context.audio.length > 0 ? context.audio : ["(none)"]),
		"",
		"## Files",
		...(context.files.length > 0
			? context.files.map((file) => `${file.name} (${file.type || "unknown"}, ${file.size} bytes)`)
			: ["(none)"]),
	];

	return lines.join("\n");
}

function buildFallbackContext(tab: chrome.tabs.Tab, selectedText: string): PageContext {
	return {
		pageTitle: tab.title ?? "Untitled page",
		pageUrl: tab.url ?? "",
		selectedText,
		links: [],
		images: [],
		videos: [],
		audio: [],
		files: [],
	};
}

async function getPageContext(tab: chrome.tabs.Tab, selectedText: string): Promise<PageContext> {
	if (!tab.id) return buildFallbackContext(tab, selectedText);

	const context = await sendTabMessage<PageContext>(tab.id, { action: "collect-page-context" });
	if (!context) return buildFallbackContext(tab, selectedText);

	return {
		...context,
		pageTitle: context.pageTitle || tab.title || "Untitled page",
		pageUrl: context.pageUrl || tab.url || "",
		selectedText: selectedText || context.selectedText || "",
	};
}

async function createTab(url: string): Promise<chrome.tabs.Tab> {
	return new Promise((resolve, reject) => {
		chrome.tabs.create({ url, active: true }, (tab) => {
			if (chrome.runtime.lastError || !tab) {
				reject(new Error(chrome.runtime.lastError?.message ?? "Could not create dashboard tab"));
				return;
			}
			resolve(tab);
		});
	});
}

async function waitForTabLoad(tabId: number, timeoutMs = 10_000): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;

		const cleanup = (): void => {
			chrome.tabs.onUpdated.removeListener(onUpdated);
			clearTimeout(timeout);
		};

		const finishResolve = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		};

		const finishReject = (message: string): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(message));
		};

		const timeout = setTimeout(() => {
			finishReject("Timed out waiting for dashboard tab");
		}, timeoutMs);

		const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo): void => {
			if (updatedTabId !== tabId) return;
			if (changeInfo.status === "complete") {
				finishResolve();
			}
		};

		chrome.tabs.onUpdated.addListener(onUpdated);
		chrome.tabs.get(tabId, (tab) => {
			if (chrome.runtime.lastError) {
				finishReject(chrome.runtime.lastError.message ?? "Failed to query tab status");
				return;
			}
			if (tab?.status === "complete") {
				finishResolve();
			}
		});
	});
}

async function sendTabMessageWithRetry(
	tabId: number,
	message: unknown,
	attempts = 10,
): Promise<{ ok: boolean; error?: string } | null> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const response = await new Promise<{ ok: boolean; error?: string } | null>((resolve) => {
			chrome.tabs.sendMessage(tabId, message, (result) => {
				if (chrome.runtime.lastError) {
					resolve(null);
					return;
				}
				resolve((result as { ok: boolean; error?: string } | null) ?? null);
			});
		});

		if (response) return response;
		await delay(200);
	}

	return null;
}

async function openDashboardAndInject(url: string, payload: string, autoSend: boolean): Promise<InjectResult> {
	const tab = await createTab(url);
	if (!tab.id) {
		return { ok: false, error: "Dashboard tab missing id" };
	}

	if (tab.status !== "complete") {
		await waitForTabLoad(tab.id);
	}

	const injectResult = await sendTabMessageWithRetry(tab.id, {
		action: "inject-harness-payload",
		payload,
		autoSend,
	});

	if (injectResult?.ok) {
		return { ok: true, tabId: tab.id };
	}

	return {
		ok: false,
		tabId: tab.id,
		error: injectResult?.error ?? "Failed to inject payload into dashboard harness",
	};
}

function formatBookmark(context: PageContext): string {
	return [
		"[Signet Bookmark]",
		`Title: ${context.pageTitle || "Untitled"}`,
		`URL: ${context.pageUrl || "unknown"}`,
		`Saved At: ${new Date().toISOString()}`,
	].join("\n");
}

function buildTranscribeOverlayPrompt(context: PageContext, textToTranscribe: string): string {
	const clippedText =
		textToTranscribe.length > MAX_TRANSCRIBE_CHARS
			? `${textToTranscribe.slice(0, MAX_TRANSCRIBE_CHARS)}\n\n[Truncated by Signet for overlay transcription request.]`
			: textToTranscribe;
	return [
		"Transcribe the following content into clean, readable text.",
		"Keep all facts and meaning intact.",
		"Do not add new information.",
		"If the content is already text, produce a polished transcript preserving structure.",
		"",
		`Source: ${context.pageTitle || "Untitled"} (${context.pageUrl || "unknown"})`,
		"",
		"Content:",
		clippedText,
	].join("\n");
}

async function handleTranscribe(tab: chrome.tabs.Tab, selectedText: string): Promise<void> {
	const context = await getPageContext(tab, selectedText);
	const textToTranscribe = (
		selectedText ||
		context.selectedText ||
		[
			`Page Title: ${context.pageTitle || "Untitled"}`,
			`Page URL: ${context.pageUrl || "unknown"}`,
			context.links.length > 0 ? `Page Links:\n${context.links.slice(0, 10).join("\n")}` : "",
		]
			.filter(Boolean)
			.join("\n\n")
	).trim();
	if (!textToTranscribe) return;

	const promptText = buildTranscribeOverlayPrompt(context, textToTranscribe);
	await handleAskSignet(tab, selectedText, {
		text: textToTranscribe,
		presetAction: "transcribe",
		autoSubmit: true,
		promptText,
	});
}

async function handleViewMcpServers(): Promise<void> {
	const config = await getConfig();
	const dashboardUrl = buildDashboardUrl(config.daemonUrl, "os");
	await createTab(dashboardUrl);
}

async function handleBookmark(tab: chrome.tabs.Tab, selectedText: string): Promise<void> {
	const context = await getPageContext(tab, selectedText);
	await rememberMemory({
		content: formatBookmark(context),
		tags: "bookmark,browser-extension,right-click",
		importance: 0.55,
		type: "fact",
		source_type: "browser-extension",
	});
}

async function handleRememberSelection(tab: chrome.tabs.Tab, selectedText: string): Promise<void> {
	const context = await getPageContext(tab, selectedText);
	const selected = selectedText || context.selectedText;

	if (selected.trim()) {
		await rememberMemory({
			content: [
				"[Signet Remember Selection]",
				`Source: ${context.pageTitle} (${context.pageUrl})`,
				"",
				selected,
			].join("\n"),
			tags: "remember,selection,browser-extension,right-click",
			importance: 0.68,
			type: "note",
			source_type: "browser-extension",
		});
		return;
	}

	await rememberMemory({
		content: [
			"[Signet Remember Selection]",
			`Source: ${context.pageTitle} (${context.pageUrl})`,
			"",
			"No text was selected; saved current page reference.",
		].join("\n"),
		tags: "remember,page,browser-extension,right-click",
		importance: 0.5,
		type: "note",
		source_type: "browser-extension",
	});
}

async function handleSendToSignet(tab: chrome.tabs.Tab, selectedText: string): Promise<void> {
	const context = await getPageContext(tab, selectedText);
	const payload = formatSelectionBundle(context);
	const action = (selectedText || context.selectedText).trim() ? "send-selection" : "send-page";

	await dispatchBrowserTool({
		action,
		payload,
		pageTitle: context.pageTitle,
		pageUrl: context.pageUrl,
		selectedText: context.selectedText,
		links: context.links,
		images: context.images,
		videos: context.videos,
		audio: context.audio,
		files: context.files,
		dispatchToHarness: false,
	});

	const config = await getConfig();
	const dashboardUrl = buildDashboardUrl(config.daemonUrl, "os");
	await openDashboardAndInject(dashboardUrl, payload, true);
}

async function ensureContentScriptInjected(tabId: number): Promise<boolean> {
	if (!chrome.scripting?.executeScript) return false;
	try {
		await chrome.scripting.executeScript({
			target: { tabId },
			files: ["content/content.js"],
		});
		return true;
	} catch {
		return false;
	}
}

async function handleAskSignet(tab: chrome.tabs.Tab, selectedText: string, options?: AskOverlayOptions): Promise<void> {
	if (!tab.id) return;
	const context = await getPageContext(tab, selectedText);
	const prefill = (options?.text || selectedText || context.selectedText || "").trim();
	const message = {
		action: "show-ask-signet-overlay",
		text: prefill,
		pageUrl: context.pageUrl,
		pageTitle: context.pageTitle,
		presetAction: options?.presetAction,
		autoSubmit: options?.autoSubmit,
		promptText: options?.promptText,
	};

	let overlayResult = await sendTabMessage<AskOverlayResponse>(tab.id, message);
	if (overlayResult?.ok) return;

	const injected = await ensureContentScriptInjected(tab.id);
	if (!injected) return;

	overlayResult = await sendTabMessage<AskOverlayResponse>(tab.id, message);
	if (overlayResult?.ok) return;
}

async function handleContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
	if (!tab?.id) return;

	const selectedText = (info.selectionText ?? "").trim();

	if (info.menuItemId === MENU_IDS.askSignet) {
		await handleAskSignet(tab, selectedText);
		return;
	}

	if (info.menuItemId === MENU_IDS.transcribe) {
		await handleTranscribe(tab, selectedText);
		return;
	}

	if (info.menuItemId === MENU_IDS.sendToSignet) {
		await handleSendToSignet(tab, selectedText);
		return;
	}

	if (info.menuItemId === MENU_IDS.viewMcpServers) {
		await handleViewMcpServers();
		return;
	}

	if (info.menuItemId === MENU_IDS.bookmark) {
		await handleBookmark(tab, selectedText);
		return;
	}

	if (info.menuItemId === MENU_IDS.rememberSelection) {
		await handleRememberSelection(tab, selectedText);
	}
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
	void handleContextMenuClick(info, tab);
});

async function pollHealth(): Promise<void> {
	const health = await checkHealth();
	let newState: HealthState;

	if (health === null) {
		newState = "offline";
	} else if (health.status === "ok" || health.status === "healthy") {
		newState = "healthy";
	} else {
		newState = "degraded";
	}

	if (newState !== currentState) {
		currentState = newState;
		chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[newState] });
		chrome.action.setBadgeText({ text: BADGE_TEXT[newState] });
	}
}

// Poll every 60 seconds
chrome.alarms.create("signet-health-poll", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === "signet-health-poll") {
		pollHealth();
	}
});

// Initial poll on startup
pollHealth();

// --- Message routing ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message.action === "get-health") {
		pollHealth().then(() => {
			sendResponse({ state: currentState });
		});
		return true;
	}

	if (message.action === "get-daemon-url") {
		getConfig().then((config) => {
			sendResponse({ url: config.daemonUrl });
		});
		return true;
	}

	if (message.action === "ask-signet-models") {
		fetchAskSignetModels()
			.then((result) => sendResponse(result))
			.catch((error: unknown) => {
				sendResponse({
					ok: false,
					error: error instanceof Error ? error.message : "Failed to load models",
				});
			});
		return true;
	}

	if (message.action === "ask-signet-chat") {
		askSignetChat(String(message.message ?? ""), String(message.modelId ?? ""))
			.then((result) => sendResponse(result))
			.catch((error: unknown) => {
				sendResponse({
					ok: false,
					error: error instanceof Error ? error.message : "Ask Signet request failed",
				});
			});
		return true;
	}

	if (message.action === "open-dashboard-and-inject") {
		openDashboardAndInject(String(message.url ?? ""), String(message.payload ?? ""), message.autoSend !== false)
			.then((result) => sendResponse(result))
			.catch((error: unknown) => {
				sendResponse({
					ok: false,
					error: error instanceof Error ? error.message : "Failed to open dashboard",
				});
			});
		return true;
	}

	return false;
});
