/**
 * Signet popup entry point
 * Flow: Header → Memory Search → Navigator → Tools
 */

import { checkHealth, dispatchBrowserTool, rememberMemory } from "../shared/api.js";
import { getConfig } from "../shared/config.js";
import { applyTheme, watchSystemTheme } from "../shared/theme.js";
import { initHealthBadge } from "./components/health-badge.js";
import {
	renderLoading,
	renderMemories,
	renderOffline,
	renderSearchEmpty,
	renderSearchPrompt,
} from "./components/memory-list.js";
import { initSearch } from "./components/search-bar.js";

type ToolTone = "neutral" | "success" | "error";

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

interface InjectResponse {
	readonly ok: boolean;
	readonly tabId?: number;
	readonly error?: string;
}

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/$/, "");
}

function buildDashboardUrl(baseUrl: string, hash = ""): string {
	const cleaned = normalizeBaseUrl(baseUrl);
	if (!hash) return cleaned;
	return `${cleaned}/#${hash}`;
}

function setToolStatus(el: HTMLElement, message: string, tone: ToolTone = "neutral"): void {
	el.textContent = message;
	if (tone === "neutral") {
		el.removeAttribute("data-tone");
		return;
	}
	el.setAttribute("data-tone", tone);
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
	return new Promise((resolve) => {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			resolve(tabs[0] ?? null);
		});
	});
}

async function sendTabMessage<T>(tabId: number, message: unknown, timeoutMs = 5000): Promise<T | null> {
	return new Promise((resolve) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(null);
		}, timeoutMs);

		chrome.tabs.sendMessage(tabId, message, (response) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (chrome.runtime.lastError) {
				resolve(null);
				return;
			}
			resolve((response as T | null) ?? null);
		});
	});
}

async function sendRuntimeMessage<T>(message: unknown, timeoutMs = 12000): Promise<T | null> {
	return new Promise((resolve) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(null);
		}, timeoutMs);

		chrome.runtime.sendMessage(message, (response) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (chrome.runtime.lastError) {
				resolve(null);
				return;
			}
			resolve((response as T | null) ?? null);
		});
	});
}

async function getPageContext(): Promise<PageContext> {
	const activeTab = await getActiveTab();
	const fallback: PageContext = {
		pageTitle: activeTab?.title ?? "Untitled page",
		pageUrl: activeTab?.url ?? "",
		selectedText: "",
		links: [],
		images: [],
		videos: [],
		audio: [],
		files: [],
	};

	if (!activeTab?.id) {
		return fallback;
	}

	const context = await sendTabMessage<PageContext>(activeTab.id, { action: "collect-page-context" });
	if (!context) return fallback;
	return {
		...fallback,
		...context,
		pageTitle: context.pageTitle || fallback.pageTitle,
		pageUrl: context.pageUrl || fallback.pageUrl,
	};
}

function formatPageCapture(context: PageContext): string {
	return [
		"[Signet Page Capture]",
		`Title: ${context.pageTitle || "Untitled"}`,
		`URL: ${context.pageUrl || "unknown"}`,
		`Captured At: ${new Date().toISOString()}`,
		"",
		context.selectedText ? "Selected Text:" : "Page Note:",
		context.selectedText || "No text selected; page captured as reference.",
	].join("\n");
}

function formatBookmark(context: PageContext): string {
	return [
		"[Signet Bookmark]",
		`Title: ${context.pageTitle || "Untitled"}`,
		`URL: ${context.pageUrl || "unknown"}`,
		`Saved At: ${new Date().toISOString()}`,
	].join("\n");
}

function formatPageNote(context: PageContext, note: string): string {
	return [
		"[Signet Page Note]",
		`Title: ${context.pageTitle || "Untitled"}`,
		`URL: ${context.pageUrl || "unknown"}`,
		"",
		"User Note:",
		note,
		context.selectedText ? `\nSelection Context:\n${context.selectedText}` : "",
	].join("\n");
}

function formatHarnessPayload(context: PageContext, note: string): string {
	return [
		"--- signet-harness-payload.txt ---",
		`source_title: ${context.pageTitle || "Untitled"}`,
		`source_url: ${context.pageUrl || "unknown"}`,
		`timestamp: ${new Date().toISOString()}`,
		"",
		"## User Notes",
		note || "(none)",
		"",
		"## Page Selection",
		context.selectedText || "(no selected text)",
		"",
		"Please process this payload in Signet harness context.",
	].join("\n");
}

async function copyToClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

async function sendToHarness(payload: string, statusEl: HTMLElement, autoSend = true): Promise<void> {
	const config = await getConfig();
	const dashboardUrl = buildDashboardUrl(config.daemonUrl, "os");

	const result = await sendRuntimeMessage<InjectResponse>({
		action: "open-dashboard-and-inject",
		url: dashboardUrl,
		payload,
		autoSend,
	});

	if (result?.ok) {
		setToolStatus(statusEl, "Sent to Signet harness.", "success");
		return;
	}

	const copied = await copyToClipboard(payload);
	if (!result?.tabId) {
		chrome.tabs.create({ url: dashboardUrl });
	}

	const reason = result?.error ? ` (${result.error})` : "";
	setToolStatus(
		statusEl,
		copied
			? `Could not auto-send${reason}. Opened Signet OS and copied payload.`
			: `Could not auto-send${reason}. Opened Signet OS for manual paste.`,
		"error",
	);
}

async function init(): Promise<void> {
	const config = await getConfig();
	applyTheme(document.documentElement, config.theme);
	watchSystemTheme(() => {
		if (config.theme === "auto") {
			applyTheme(document.documentElement, "auto");
		}
	});

	const healthDot = document.getElementById("health-dot");
	const versionEl = document.getElementById("version");
	const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
	const memoryList = document.getElementById("memory-list");
	const openDashboard = document.getElementById("open-dashboard");
	const openOptions = document.getElementById("open-options");
	const toolStatus = document.getElementById("tool-status");
	const navTargetSelect = document.getElementById("nav-target-select") as HTMLSelectElement | null;
	const navOpenTargetBtn = document.getElementById("nav-open-target") as HTMLButtonElement | null;
	const noteSection = document.getElementById("tool-note-section") as HTMLDivElement | null;
	const noteInput = document.getElementById("tool-note-input") as HTMLTextAreaElement | null;

	const capturePageBtn = document.getElementById("tool-capture-page") as HTMLButtonElement | null;
	const saveBookmarkBtn = document.getElementById("tool-save-bookmark") as HTMLButtonElement | null;
	const writeNoteBtn = document.getElementById("tool-write-note") as HTMLButtonElement | null;
	const openOsChatBtn = document.getElementById("tool-open-os-chat") as HTMLButtonElement | null;
	const sendPageBtn = document.getElementById("tool-send-page") as HTMLButtonElement | null;

	if (
		!healthDot ||
		!versionEl ||
		!searchInput ||
		!memoryList ||
		!openDashboard ||
		!openOptions ||
		!toolStatus ||
		!navTargetSelect ||
		!navOpenTargetBtn ||
		!noteSection ||
		!noteInput ||
		!capturePageBtn ||
		!saveBookmarkBtn ||
		!writeNoteBtn ||
		!openOsChatBtn ||
		!sendPageBtn
	) {
		return;
	}

	const memoryListEl = memoryList as HTMLElement;
	const searchInputEl = searchInput as HTMLInputElement;
	const noteSectionEl = noteSection as HTMLDivElement;

	const openDashboardHash = async (hash = ""): Promise<void> => {
		const cfg = await getConfig();
		chrome.tabs.create({ url: buildDashboardUrl(cfg.daemonUrl, hash) });
	};

	navOpenTargetBtn.addEventListener("click", () => {
		const target = navTargetSelect.value || "home";
		void openDashboardHash(target);
	});

	openDashboard.addEventListener("click", () => {
		void openDashboardHash();
	});

	openOptions.addEventListener("click", () => {
		chrome.runtime.openOptionsPage();
	});

	openOsChatBtn.addEventListener("click", () => {
		void openDashboardHash("os");
	});

	let noteSectionVisible = false;
	const setNoteSectionVisible = (visible: boolean): void => {
		noteSectionVisible = visible;
		noteSectionEl.hidden = !visible;
		noteSectionEl.classList.toggle("is-visible", visible);
		writeNoteBtn.textContent = visible ? "Save Note" : "Write Note";
	};
	setNoteSectionVisible(false);

	let online = false;

	async function refreshOverview(): Promise<void> {
		if (!online) {
			renderOffline(memoryListEl);
			return;
		}
		renderSearchPrompt(memoryListEl);
	}

	renderLoading(memoryListEl);

	const updateHealth = initHealthBadge(healthDot, versionEl);
	await updateHealth();
	const health = await checkHealth();
	online = health !== null && (health.status === "ok" || health.status === "healthy");

	if (online) {
		await refreshOverview();
	} else {
		renderOffline(memoryListEl);
	}

	initSearch(
		searchInputEl,
		(results, query) => {
			if (results.length === 0) {
				renderSearchEmpty(memoryListEl, query);
			} else {
				renderMemories(memoryListEl, results);
			}
		},
		() => {
			if (!online) {
				renderOffline(memoryListEl);
				return;
			}
			renderSearchPrompt(memoryListEl);
		},
	);

	capturePageBtn.addEventListener("click", async () => {
		setToolStatus(toolStatus, "Capturing page...");
		const context = await getPageContext();
		const content = formatPageCapture(context);
		const result = await rememberMemory({
			content,
			tags: "browser,page-capture",
			importance: 0.6,
			type: "fact",
			source_type: "browser-extension",
		});

		if (result.success) {
			setToolStatus(toolStatus, "Page captured to Signet memory.", "success");
			if (online) await refreshOverview();
		} else {
			setToolStatus(toolStatus, "Capture failed. Check daemon connectivity.", "error");
		}
	});

	saveBookmarkBtn.addEventListener("click", async () => {
		setToolStatus(toolStatus, "Saving bookmark...");
		const context = await getPageContext();
		const result = await rememberMemory({
			content: formatBookmark(context),
			tags: "bookmark,browser-extension",
			importance: 0.55,
			type: "fact",
			source_type: "browser-extension",
		});

		if (result.success) {
			setToolStatus(toolStatus, "Bookmark saved to Signet.", "success");
			if (online) await refreshOverview();
		} else {
			setToolStatus(toolStatus, "Bookmark save failed.", "error");
		}
	});

	writeNoteBtn.addEventListener("click", async () => {
		if (!noteSectionVisible) {
			setNoteSectionVisible(true);
			noteInput.focus();
			setToolStatus(toolStatus, "Note editor opened.");
			return;
		}

		const note = noteInput.value.trim();
		if (!note) {
			setToolStatus(toolStatus, "Write a note first.", "error");
			return;
		}

		setToolStatus(toolStatus, "Saving note...");
		const context = await getPageContext();
		const result = await rememberMemory({
			content: formatPageNote(context, note),
			tags: "page-note,browser-extension",
			importance: 0.65,
			type: "note",
			source_type: "browser-extension",
		});

		if (result.success) {
			setToolStatus(toolStatus, "Note saved to Signet memory.", "success");
			noteInput.value = "";
			setNoteSectionVisible(false);
			if (online) await refreshOverview();
		} else {
			setToolStatus(toolStatus, "Note save failed.", "error");
		}
	});

	sendPageBtn.addEventListener("click", async () => {
		setToolStatus(toolStatus, "Preparing page payload...");
		const context = await getPageContext();
		const note = noteInput.value.trim();
		const payload = formatHarnessPayload(context, note);

		setToolStatus(toolStatus, "Sending page to Signet browser tool...");
		const browserResult = await dispatchBrowserTool({
			action: "send-page",
			payload,
			pageTitle: context.pageTitle,
			pageUrl: context.pageUrl,
			note,
			selectedText: context.selectedText,
			links: context.links,
			images: context.images,
			videos: context.videos,
			audio: context.audio,
			files: context.files,
			dispatchToHarness: false,
		});

		if (browserResult.memoryStored) {
			setToolStatus(toolStatus, "Saved to memory. Opening Signet OS...", "neutral");
		} else {
			setToolStatus(toolStatus, "Opening Signet OS...", "neutral");
		}

		await sendToHarness(payload, toolStatus, true);
	});
}

document.addEventListener("DOMContentLoaded", () => {
	void init();
});
