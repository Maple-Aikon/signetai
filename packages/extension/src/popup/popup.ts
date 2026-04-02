/**
 * Signet popup entry point
 * New flow: Header → Memory Search → Navigator → Tools → Overview
 */

import { checkHealth, dispatchBrowserTool, getIdentity, getMemories, rememberMemory } from "../shared/api.js";
import { getConfig } from "../shared/config.js";
import { applyTheme, watchSystemTheme } from "../shared/theme.js";
import type { Memory } from "../shared/types.js";
import { initHealthBadge } from "./components/health-badge.js";
import { renderLoading, renderMemories, renderOffline, renderSearchEmpty } from "./components/memory-list.js";
import { updateStats } from "./components/memory-stats.js";
import { initSearch } from "./components/search-bar.js";

type ToolTone = "neutral" | "success" | "error";

type TranscribeFormat = "summary" | "bullet" | "checklist" | "json";

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
	const memoriesStatEl = document.getElementById("stat-memories");
	const embeddedStatEl = document.getElementById("stat-embedded");
	const pipelineStatEl = document.getElementById("stat-pipeline");
	const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
	const memoryList = document.getElementById("memory-list");
	const openDashboard = document.getElementById("open-dashboard");
	const openOptions = document.getElementById("open-options");
	const toolStatus = document.getElementById("tool-status");
	const noteInput = document.getElementById("tool-note-input") as HTMLTextAreaElement | null;
	const transcribeFormat = document.getElementById("transcribe-format") as HTMLSelectElement | null;

	const capturePageBtn = document.getElementById("tool-capture-page") as HTMLButtonElement | null;
	const saveBookmarkBtn = document.getElementById("tool-save-bookmark") as HTMLButtonElement | null;
	const writeNoteBtn = document.getElementById("tool-write-note") as HTMLButtonElement | null;
	const sendPageBtn = document.getElementById("tool-send-page") as HTMLButtonElement | null;
	const transcribeBtn = document.getElementById("tool-transcribe-highlight") as HTMLButtonElement | null;
	const sendSelectionBtn = document.getElementById("tool-send-selection") as HTMLButtonElement | null;

	if (
		!healthDot ||
		!versionEl ||
		!memoriesStatEl ||
		!embeddedStatEl ||
		!pipelineStatEl ||
		!searchInput ||
		!memoryList ||
		!openDashboard ||
		!openOptions ||
		!toolStatus ||
		!noteInput ||
		!transcribeFormat ||
		!capturePageBtn ||
		!saveBookmarkBtn ||
		!writeNoteBtn ||
		!sendPageBtn ||
		!transcribeBtn ||
		!sendSelectionBtn
	) {
		return;
	}

	const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-nav-target]"));
	const memoryListEl = memoryList as HTMLElement;
	const memoriesStat = memoriesStatEl as HTMLElement;
	const embeddedStat = embeddedStatEl as HTMLElement;
	const pipelineStat = pipelineStatEl as HTMLElement;
	const searchInputEl = searchInput as HTMLInputElement;

	const openDashboardHash = async (hash = ""): Promise<void> => {
		const cfg = await getConfig();
		chrome.tabs.create({ url: buildDashboardUrl(cfg.daemonUrl, hash) });
	};

	for (const navButton of navButtons) {
		navButton.addEventListener("click", () => {
			const target = navButton.dataset.navTarget ?? "";
			void openDashboardHash(target);
		});
	}

	openDashboard.addEventListener("click", () => {
		void openDashboardHash();
	});

	openOptions.addEventListener("click", () => {
		chrome.runtime.openOptionsPage();
	});

	let recentMemories: readonly Memory[] = [];
	let online = false;

	async function refreshOverview(): Promise<void> {
		if (!online) {
			renderOffline(memoryListEl);
			memoriesStat.textContent = "--";
			embeddedStat.textContent = "--";
			pipelineStat.textContent = "--";
			return;
		}

		const memoryResult = await getMemories(10, 0);
		recentMemories = memoryResult.memories;
		await updateStats(memoryResult.stats, memoriesStat, embeddedStat, pipelineStat);

		if (searchInputEl.value.trim().length === 0) {
			renderMemories(memoryListEl, recentMemories);
		}
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
		memoriesStat.textContent = "--";
		embeddedStat.textContent = "--";
		pipelineStat.textContent = "--";
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
			renderMemories(memoryListEl, recentMemories);
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

	transcribeBtn.addEventListener("click", async () => {
		setToolStatus(toolStatus, "Transcribing highlight...");
		const context = await getPageContext();
		if (!context.selectedText.trim()) {
			setToolStatus(toolStatus, "Highlight text on the page first.", "error");
			return;
		}

		const identity = await getIdentity();
		const identityName = identity?.name ?? "Signet Agent";
		const format = (transcribeFormat.value as TranscribeFormat) || "summary";
		const transcription = transcribeSelection(context.selectedText, format, identityName);

		if (!transcription) {
			setToolStatus(toolStatus, "Could not transcribe selection.", "error");
			return;
		}

		noteInput.value = transcription;
		const result = await rememberMemory({
			content: [
				"[Signet Transcribe]",
				`Format: ${format}`,
				`Source: ${context.pageTitle} (${context.pageUrl})`,
				"",
				transcription,
			].join("\n"),
			tags: "transcribe,browser-extension",
			importance: 0.7,
			type: "note",
			source_type: "browser-extension",
		});

		if (result.success) {
			setToolStatus(toolStatus, "Transcribed and saved to Signet.", "success");
			if (online) await refreshOverview();
		} else {
			setToolStatus(toolStatus, "Transcription save failed.", "error");
		}
	});

	sendSelectionBtn.addEventListener("click", async () => {
		setToolStatus(toolStatus, "Packaging selection for Signet...");
		const context = await getPageContext();
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
			dispatchToHarness: false,
		});

		if (browserResult.memoryStored) {
			setToolStatus(toolStatus, "Saved selection. Opening Signet OS...", "neutral");
		} else {
			setToolStatus(toolStatus, "Opening Signet OS...", "neutral");
		}

		await sendToHarness(payload, toolStatus, true);
	});
}

document.addEventListener("DOMContentLoaded", () => {
	void init();
});
