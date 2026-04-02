/**
 * Signet background service worker
 * Handles: context menus, health polling, badge updates, and message routing
 */

import { checkHealth, dispatchBrowserTool, getIdentity, rememberMemory } from "../shared/api.js";
import { getConfig } from "../shared/config.js";

type HealthState = "healthy" | "degraded" | "offline";
type TranscribeFormat = "summary" | "bullet" | "checklist" | "json";

interface InjectResult {
	readonly ok: boolean;
	readonly tabId?: number;
	readonly error?: string;
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
	remember: "signet-remember",
	transcribeSummary: "signet-transcribe-summary",
	transcribeBullet: "signet-transcribe-bullet",
	transcribeChecklist: "signet-transcribe-checklist",
	transcribeJson: "signet-transcribe-json",
	sendSelection: "signet-send-selection",
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

let currentState: HealthState = "offline";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/$/, "");
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
			contexts: ["selection"],
		});

		chrome.contextMenus.create({
			id: MENU_IDS.remember,
			parentId: MENU_IDS.root,
			title: "Remember Selection",
			contexts: ["selection"],
		});

		chrome.contextMenus.create({
			id: MENU_IDS.transcribeSummary,
			parentId: MENU_IDS.root,
			title: "Transcribe as Summary",
			contexts: ["selection"],
		});

		chrome.contextMenus.create({
			id: MENU_IDS.transcribeBullet,
			parentId: MENU_IDS.root,
			title: "Transcribe as Bullet Points",
			contexts: ["selection"],
		});

		chrome.contextMenus.create({
			id: MENU_IDS.transcribeChecklist,
			parentId: MENU_IDS.root,
			title: "Transcribe as Checklist",
			contexts: ["selection"],
		});

		chrome.contextMenus.create({
			id: MENU_IDS.transcribeJson,
			parentId: MENU_IDS.root,
			title: "Transcribe as JSON",
			contexts: ["selection"],
		});

		chrome.contextMenus.create({
			id: MENU_IDS.sendSelection,
			parentId: MENU_IDS.root,
			title: "Send Selection to Signet",
			contexts: ["selection"],
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

function transcribeSelection(text: string, format: TranscribeFormat, identityName: string): string {
	const cleaned = text.trim();
	if (!cleaned) return "";

	if (format === "json") {
		return JSON.stringify(
			{
				agent: identityName,
				type: "transcription",
				summary: cleaned.slice(0, 220),
				length: cleaned.length,
				timestamp: new Date().toISOString(),
				content: cleaned,
			},
			null,
			2,
		);
	}

	const sentences = cleaned
		.split(/(?<=[.!?])\s+/)
		.map((part) => part.trim())
		.filter(Boolean)
		.slice(0, 8);

	if (format === "bullet") {
		const items = sentences.length > 0 ? sentences : [cleaned];
		return items.map((item) => `• ${item}`).join("\n");
	}

	if (format === "checklist") {
		const items = sentences.length > 0 ? sentences : [cleaned];
		return items.map((item) => `- [ ] ${item}`).join("\n");
	}

	const lead = sentences.length > 0 ? sentences.slice(0, 2).join(" ") : cleaned;
	return `${lead}\n\nTranscribed by ${identityName}.`;
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

async function handleTranscribe(tab: chrome.tabs.Tab, selectedText: string, format: TranscribeFormat): Promise<void> {
	if (!selectedText) return;
	const context = await getPageContext(tab, selectedText);
	const identity = await getIdentity();
	const identityName = identity?.name ?? "Signet Agent";
	const transcription = transcribeSelection(selectedText, format, identityName);
	if (!transcription) return;

	await rememberMemory({
		content: [
			"[Signet Transcribe]",
			`Format: ${format}`,
			`Source: ${context.pageTitle} (${context.pageUrl})`,
			"",
			transcription,
		].join("\n"),
		tags: "transcribe,browser-extension,right-click",
		importance: 0.72,
		type: "note",
		source_type: "browser-extension",
	});
}

async function handleSendSelection(tab: chrome.tabs.Tab, selectedText: string): Promise<void> {
	if (!selectedText) return;
	const context = await getPageContext(tab, selectedText);
	const payload = formatSelectionBundle(context);

	const browserResult = await dispatchBrowserTool({
		action: "send-selection",
		payload,
		pageTitle: context.pageTitle,
		pageUrl: context.pageUrl,
		selectedText: context.selectedText,
		links: context.links,
		images: context.images,
		videos: context.videos,
		audio: context.audio,
		files: context.files,
		dispatchToHarness: true,
	});

	if (browserResult.success && browserResult.dispatched) {
		return;
	}

	const config = await getConfig();
	const dashboardUrl = buildDashboardUrl(config.daemonUrl, "os");
	await openDashboardAndInject(dashboardUrl, payload, true);
}

async function handleContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
	if (!tab?.id) return;

	const selectedText = (info.selectionText ?? "").trim();
	const pageUrl = info.pageUrl ?? tab.url ?? "";
	const pageTitle = tab.title ?? "";

	if (info.menuItemId === MENU_IDS.remember) {
		if (!selectedText) return;
		chrome.tabs.sendMessage(tab.id, {
			action: "show-save-panel",
			text: selectedText,
			pageUrl,
			pageTitle,
		});
		return;
	}

	if (info.menuItemId === MENU_IDS.transcribeSummary) {
		await handleTranscribe(tab, selectedText, "summary");
		return;
	}

	if (info.menuItemId === MENU_IDS.transcribeBullet) {
		await handleTranscribe(tab, selectedText, "bullet");
		return;
	}

	if (info.menuItemId === MENU_IDS.transcribeChecklist) {
		await handleTranscribe(tab, selectedText, "checklist");
		return;
	}

	if (info.menuItemId === MENU_IDS.transcribeJson) {
		await handleTranscribe(tab, selectedText, "json");
		return;
	}

	if (info.menuItemId === MENU_IDS.sendSelection) {
		await handleSendSelection(tab, selectedText);
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
