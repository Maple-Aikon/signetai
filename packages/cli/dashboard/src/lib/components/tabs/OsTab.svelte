<script lang="ts">
import { API_BASE } from "$lib/api";
import AgentChat from "$lib/components/os/AgentChat.svelte";
import AppDock from "$lib/components/os/AppDock.svelte";
import AutoCard from "$lib/components/os/AutoCard.svelte";
import SidebarGroups from "$lib/components/os/SidebarGroups.svelte";
import WidgetSandbox from "$lib/components/os/WidgetSandbox.svelte";
import {
	os,
	fetchTrayEntries,
	fetchWidgetHtml,
	getDockApps,
	getTrayApps,
	loadGroups,
	onWidgetGenerated,
	onWidgetGenerationFailed,
	requestWidgetGen,
	widgetGenerating,
	widgetHtmlCache,
} from "$lib/stores/os.svelte";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";
import { onDestroy, onMount } from "svelte";

let renderWindowDragOver = $state(false);
let renderWindowTabIds = $state<string[]>([]);
let activeRenderTabId = $state<string | null>(null);
let renderWindowErrors = $state<Record<string, string>>({});

const trayApps = $derived(getTrayApps());
const dockApps = $derived(getDockApps());
const _widgetVersion = $derived(os.widgetCacheVersion);
const renderWindowEntry = $derived(
	activeRenderTabId ? (os.entries.find((e) => e.id === activeRenderTabId) ?? null) : null,
);
const renderWindowHtml = $derived.by(() => {
	void _widgetVersion;
	if (!renderWindowEntry) return null;
	if (renderWindowEntry.manifest.html) return renderWindowEntry.manifest.html;
	return widgetHtmlCache.get(renderWindowEntry.id) ?? null;
});
const renderWindowGenerating = $derived.by(() => {
	void _widgetVersion;
	return renderWindowEntry ? widgetGenerating.has(renderWindowEntry.id) : false;
});
const renderWindowError = $derived.by(() => {
	if (!activeRenderTabId) return null;
	return renderWindowErrors[activeRenderTabId] ?? null;
});

type HeaderAction = "remember" | "transcribe" | "recall";
type HeaderStatusTone = "neutral" | "success" | "error";

interface HeaderActionOptions {
	targetLanguage?: string;
}

type AgentChatActionHandle = {
	triggerHeaderAction: (
		action: HeaderAction,
		options?: HeaderActionOptions,
	) => Promise<{ ok: boolean; message?: string; error?: string }>;
};

let headerActionBusy = $state<HeaderAction | null>(null);
let headerStatus = $state("");
let headerStatusTone = $state<HeaderStatusTone>("neutral");
let headerStatusTimer: ReturnType<typeof setTimeout> | null = null;
let agentChatRef = $state<AgentChatActionHandle | null>(null);
const transcribeLanguages = [
	"English",
	"Spanish",
	"French",
	"German",
	"Portuguese",
	"Italian",
	"Japanese",
	"Korean",
	"Chinese (Simplified)",
	"Arabic",
	"Hindi",
] as const;
let selectedTranscribeLanguage = $state<(typeof transcribeLanguages)[number]>("English");

function clearHeaderStatusTimer(): void {
	if (headerStatusTimer) {
		clearTimeout(headerStatusTimer);
		headerStatusTimer = null;
	}
}

function setHeaderStatus(message: string, tone: HeaderStatusTone = "neutral", persist = false): void {
	headerStatus = message;
	headerStatusTone = tone;
	clearHeaderStatusTimer();
	if (!persist) {
		headerStatusTimer = setTimeout(() => {
			headerStatus = "";
			headerStatusTone = "neutral";
			headerStatusTimer = null;
		}, 4500);
	}
}

async function runHeaderChatAction(action: HeaderAction, options: HeaderActionOptions = {}): Promise<void> {
	if (!agentChatRef) {
		setHeaderStatus("Chat panel is still initializing. Try again in a moment.", "error", true);
		return;
	}

	headerActionBusy = action;
	try {
		const outcome = await agentChatRef.triggerHeaderAction(action, options);
		if (outcome.ok) {
			setHeaderStatus(outcome.message ?? "Action sent to chat.", "success");
		} else {
			setHeaderStatus(outcome.error ?? "Action could not be sent to chat.", "error", true);
		}
	} catch (error) {
		setHeaderStatus(
			`Action failed: ${error instanceof Error ? error.message : String(error)}`,
			"error",
			true,
		);
	} finally {
		headerActionBusy = null;
	}
}

let eventSource: EventSource | null = null;

onMount(() => {
	fetchTrayEntries();
	loadGroups();

	// Subscribe to widget generation events via SSE
	eventSource = new EventSource(`${API_BASE}/api/os/events/stream`);
	eventSource.onmessage = (e) => {
		try {
			const event = JSON.parse(e.data);
			if (event.type === "widget.generated" && event.payload?.serverId) {
				// Fetch the generated HTML and mark generation complete for all consumers
				fetchWidgetHtml(event.payload.serverId).then((html) => {
					if (html) {
						onWidgetGenerated(event.payload.serverId, html);
						setRenderWindowError(event.payload.serverId, null);
					} else {
						onWidgetGenerationFailed(event.payload.serverId);
						setRenderWindowError(event.payload.serverId, "Failed to load generated MCP client UI.");
					}
				});
			} else if (event.type === "widget.error" && event.payload?.serverId) {
				onWidgetGenerationFailed(event.payload.serverId);
				setRenderWindowError(
					event.payload.serverId,
					typeof event.payload.error === "string" ? event.payload.error : "Failed to build MCP client UI.",
				);
			}
		} catch {
			// Ignore parse errors from heartbeats
		}
	};
});

onDestroy(() => {
	eventSource?.close();
	clearHeaderStatusTimer();
});

function getEntryById(appId: string) {
	return os.entries.find((entry) => entry.id === appId) ?? null;
}

function clearRenderWindow(): void {
	renderWindowTabIds = [];
	activeRenderTabId = null;
	renderWindowErrors = {};
	renderWindowDragOver = false;
}

function closeRenderTab(appId: string): void {
	const nextTabs = renderWindowTabIds.filter((id) => id !== appId);
	renderWindowTabIds = nextTabs;
	const nextErrors = { ...renderWindowErrors };
	delete nextErrors[appId];
	renderWindowErrors = nextErrors;
	if (activeRenderTabId === appId) {
		activeRenderTabId = nextTabs.length > 0 ? nextTabs[nextTabs.length - 1] : null;
	}
}

function setRenderWindowError(appId: string, message: string | null): void {
	if (!message) {
		const nextErrors = { ...renderWindowErrors };
		delete nextErrors[appId];
		renderWindowErrors = nextErrors;
		return;
	}
	renderWindowErrors = {
		...renderWindowErrors,
		[appId]: message,
	};
}

async function loadAppIntoRenderWindow(appId: string): Promise<void> {
	setRenderWindowError(appId, null);
	let entry = getEntryById(appId);
	if (!entry) {
		await fetchTrayEntries();
		entry = getEntryById(appId);
	}
	if (!entry) {
		if (activeRenderTabId) setRenderWindowError(activeRenderTabId, "Unable to load that MCP app from the current tray.");
		return;
	}

	if (!renderWindowTabIds.includes(appId)) {
		renderWindowTabIds = [...renderWindowTabIds, appId];
	}
	activeRenderTabId = appId;

	if (!entry.manifest.html && !widgetHtmlCache.has(appId)) {
		await fetchWidgetHtml(appId);
	}
}

function handleRenderDragOver(e: DragEvent): void {
	e.preventDefault();
	renderWindowDragOver = true;
	if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
}

function handleRenderDragLeave(): void {
	renderWindowDragOver = false;
}

function handleRenderDrop(e: DragEvent): void {
	e.preventDefault();
	renderWindowDragOver = false;
	const appId = e.dataTransfer?.getData("text/plain")?.trim();
	if (!appId) return;
	void loadAppIntoRenderWindow(appId);
}

async function handleRenderRefresh(): Promise<void> {
	if (!renderWindowEntry) return;
	setRenderWindowError(renderWindowEntry.id, null);
	const cached = await fetchWidgetHtml(renderWindowEntry.id);
	if (!cached && !renderWindowEntry.manifest.html) {
		await requestWidgetGen(renderWindowEntry.id);
	}
}

async function startRenderGeneration(serverId: string): Promise<void> {
	setRenderWindowError(serverId, null);
	await requestWidgetGen(serverId);
}

async function handleDragToBoard(id: string): Promise<void> {
	await loadAppIntoRenderWindow(id);
}
</script>

<div class="os-tab">
	<!-- Sidebar groups panel (left) -->
	<div class="os-sidebar">
		<SidebarGroups />
	</div>

	<!-- Main content area -->
	<div class="os-main">
		<div class="os-main-header">
			<span class="sig-heading">Signet Os</span>
			<div class="os-main-header-actions">
				<button
					class="os-main-header-btn"
					type="button"
					onclick={() => void runHeaderChatAction("remember")}
					disabled={headerActionBusy !== null}
				>
					{headerActionBusy === "remember" ? "Sending…" : "Remember"}
				</button>
				<div class="os-main-header-transcribe-group">
					<select
						class="os-main-header-select"
						bind:value={selectedTranscribeLanguage}
						disabled={headerActionBusy !== null}
						title="Transcribe output language"
					>
						{#each transcribeLanguages as language}
							<option value={language}>{language}</option>
						{/each}
					</select>
					<button
						class="os-main-header-btn"
						type="button"
						onclick={() => void runHeaderChatAction("transcribe", { targetLanguage: selectedTranscribeLanguage })}
						disabled={headerActionBusy !== null}
					>
						{headerActionBusy === "transcribe" ? "Sending…" : "Transcribe"}
					</button>
				</div>
				<button
					class="os-main-header-btn"
					type="button"
					onclick={() => void runHeaderChatAction("recall")}
					disabled={headerActionBusy !== null}
				>
					{headerActionBusy === "recall" ? "Sending…" : "Recall"}
				</button>
			</div>
		</div>

		{#if headerStatus}
			<div class="os-header-status" class:os-header-status--success={headerStatusTone === "success"} class:os-header-status--error={headerStatusTone === "error"}>
				<span class="sig-meta">{headerStatus}</span>
			</div>
		{/if}

		{#if os.error}
			<div class="os-error">
				<span class="sig-label text-[var(--sig-danger)]">{os.error}</span>
			</div>
		{/if}

		<div class="os-workspace">
			<!-- Agent chat panel -->
			<div class="os-chat-panel">
				<AgentChat bind:this={agentChatRef} />
			</div>

			<div class="os-render-window">
				<div class="os-render-window-tabs" ondragover={handleRenderDragOver} ondragleave={handleRenderDragLeave} ondrop={handleRenderDrop}>
						{#if renderWindowTabIds.length === 0}
							<div class="os-render-window-tabs-empty">Drop an app here to open the first render tab.</div>
						{:else}
							{#each renderWindowTabIds as tabId (tabId)}
								{@const tabEntry = getEntryById(tabId)}
								<button
									class="os-render-tab"
									class:os-render-tab--active={activeRenderTabId === tabId}
									onclick={() => activeRenderTabId = tabId}
									title={tabEntry?.name ?? tabId}
								>
									<span class="os-render-tab-name">{tabEntry?.name ?? tabId}</span>
									<span
										class="os-render-tab-close"
										onclick={(e) => {
											e.stopPropagation();
											closeRenderTab(tabId);
										}}
										title="Close tab"
									>
										×
									</span>
								</button>
							{/each}
							<div class="os-render-window-tabs-hint">Drag another app here to open a new tab.</div>
						{/if}
						<div class="os-render-window-tabs-actions">
							<button
								class="os-render-action-btn"
								title="Refresh render window"
								onclick={() => void handleRenderRefresh()}
								disabled={!renderWindowEntry}
							>
								<RefreshCw class="size-3" />
							</button>
							<button
								class="os-render-action-btn"
								title="Clear all render tabs"
								onclick={clearRenderWindow}
								disabled={renderWindowTabIds.length === 0}
							>
								Clear
							</button>
						</div>
					</div>

					<div
						class="os-render-window-body"
						class:drag-over={renderWindowDragOver}
						role="region"
						aria-label="MCP render drop zone"
						ondragover={handleRenderDragOver}
						ondragleave={handleRenderDragLeave}
						ondrop={handleRenderDrop}
					>
						<div class="os-render-window-content">
							{#if renderWindowError}
								<div class="os-render-window-error">{renderWindowError}</div>
							{/if}
							{#if renderWindowEntry}
								{#if renderWindowHtml}
									<WidgetSandbox html={renderWindowHtml} serverId={renderWindowEntry.id} />
								{:else if renderWindowGenerating}
									<div class="os-render-window-loading-state">
										<div class="os-signet-loader" aria-hidden="true">
											<span></span>
											<span></span>
											<span></span>
										</div>
										<span class="sig-label">Generating MCP client UI…</span>
										<span class="sig-meta">Building with Signet tools/resources. This stays active until final UI output is ready.</span>
									</div>
								{:else}
									<div class="os-render-window-autocard">
										<AutoCard
											autoCard={renderWindowEntry.autoCard}
											name={renderWindowEntry.name}
											icon={renderWindowEntry.icon}
										/>
										<div class="os-render-window-autocard-action">
											<button
												class="os-render-action-btn"
												onclick={() => void startRenderGeneration(renderWindowEntry.id)}
											>
												Load Visual MCP Client
											</button>
										</div>
									</div>
								{/if}
							{:else}
								<div class="os-render-window-empty-state">
									<span class="sig-label">Drag any discovered MCP app here from the dock or left sidebar to launch it.</span>
								</div>
							{/if}
						</div>
					</div>
				</div>
		</div>

		<!-- Bottom dock / tray -->
		<AppDock
			{trayApps}
			{dockApps}
			ondragtoboard={handleDragToBoard}
		/>
	</div>
</div>

<style>
	.os-tab {
		display: flex;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.os-sidebar {
		width: 180px;
		min-width: 180px;
		border-right: 1px solid var(--sig-border);
		background: var(--sig-bg);
		overflow-y: auto;
		padding: var(--space-sm) 0;
		flex-shrink: 0;
	}

	.os-main {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		background: var(--sig-bg);
	}

	.os-main-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px var(--space-md);
		background: var(--sig-surface);
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.os-main-header-actions {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.os-main-header-transcribe-group {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.os-main-header-select {
		height: 24px;
		max-width: 180px;
		padding: 0 8px;
		border: 1px solid var(--sig-border);
		border-radius: 6px;
		background: var(--sig-bg);
		color: var(--sig-text);
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.02em;
	}

	.os-main-header-select:disabled {
		opacity: 0.55;
	}

	.os-main-header-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 24px;
		padding: 0 8px;
		border: 1px solid var(--sig-border);
		border-radius: 6px;
		background: var(--sig-bg);
		color: var(--sig-text-muted);
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		cursor: pointer;
		transition: all var(--dur) var(--ease);
	}

	.os-main-header-btn:hover:not(:disabled) {
		border-color: var(--sig-accent);
		color: var(--sig-accent);
	}

	.os-main-header-btn:disabled {
		opacity: 0.55;
		cursor: default;
	}

	.os-header-status {
		padding: 6px var(--space-md);
		border-bottom: 1px solid var(--sig-border);
		background: color-mix(in srgb, var(--sig-surface) 70%, var(--sig-bg));
	}

	.os-header-status--success {
		background: color-mix(in srgb, var(--sig-accent) 10%, var(--sig-bg));
	}

	.os-header-status--error {
		background: color-mix(in srgb, var(--sig-danger) 10%, var(--sig-bg));
	}

	.os-workspace {
		display: grid;
		grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.os-chat-panel {
		min-height: 0;
		overflow: hidden;
	}

	.os-chat-panel :global(.agent-chat) {
		height: 100%;
		max-height: none;
		min-height: 0;
		border-top: 1px solid var(--sig-border);
	}

	.os-error {
		padding: 8px var(--space-md);
		background: color-mix(in srgb, var(--sig-danger) 8%, var(--sig-bg));
	}

	.os-render-window {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--sig-border);
		border-bottom: 1px solid var(--sig-border);
		background: var(--sig-surface);
		flex-shrink: 0;
		min-height: 0;
	}

	.os-render-window-tabs {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px var(--space-md);
		border-bottom: 1px solid var(--sig-border);
		overflow-x: auto;
		background: color-mix(in srgb, var(--sig-surface) 70%, var(--sig-bg));
	}

	.os-render-window-tabs-actions {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-left: auto;
	}

	.os-render-window-tabs-empty,
	.os-render-window-tabs-hint {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		white-space: nowrap;
	}

	.os-render-tab {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		max-width: 220px;
		border: 1px solid var(--sig-border);
		border-radius: 6px;
		background: var(--sig-bg);
		color: var(--sig-text-muted);
		cursor: pointer;
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.os-render-tab--active {
		border-color: var(--sig-accent);
		color: var(--sig-accent);
		background: color-mix(in srgb, var(--sig-accent) 10%, var(--sig-bg));
	}

	.os-render-tab-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.os-render-tab-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		border-radius: 3px;
		font-size: 11px;
		line-height: 1;
	}

	.os-render-tab-close:hover {
		background: color-mix(in srgb, var(--sig-danger) 14%, transparent);
		color: var(--sig-danger);
	}

	.os-render-window-loading-state {
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 16px;
		text-align: center;
	}

	.os-signet-loader {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.os-signet-loader span {
		width: 7px;
		height: 7px;
		border-radius: 999px;
		background: var(--sig-accent);
		animation: sig-loader-pulse 0.9s ease-in-out infinite;
	}

	.os-signet-loader span:nth-child(2) {
		animation-delay: 0.12s;
	}

	.os-signet-loader span:nth-child(3) {
		animation-delay: 0.24s;
	}

	@keyframes sig-loader-pulse {
		0%,
		100% {
			opacity: 0.3;
			transform: scale(0.8);
		}
		50% {
			opacity: 1;
			transform: scale(1);
		}
	}

	.os-render-action-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 24px;
		padding: 0 8px;
		border: 1px solid var(--sig-border);
		border-radius: 6px;
		background: var(--sig-bg);
		color: var(--sig-text-muted);
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		cursor: pointer;
		transition: all var(--dur) var(--ease);
	}

	.os-render-action-btn:hover:not(:disabled) {
		border-color: var(--sig-accent);
		color: var(--sig-accent);
	}

	.os-render-action-btn:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.os-render-window-body {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		background: var(--sig-bg);
		border: 1px dashed transparent;
		padding: 10px;
		transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
	}

	.os-render-window-content {
		position: relative;
		height: 100%;
		border: 1px solid var(--sig-border);
		border-radius: 12px;
		overflow: hidden;
		background: color-mix(in srgb, var(--sig-surface) 75%, var(--sig-bg));
	}

	.os-render-window-body.drag-over {
		border-color: var(--sig-accent);
		background: color-mix(in srgb, var(--sig-accent) 8%, var(--sig-bg));
	}

	.os-render-window-empty-state {
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 12px;
		text-align: center;
	}

	.os-render-window-error {
		position: absolute;
		top: 8px;
		left: 8px;
		right: 8px;
		z-index: 2;
		font-family: var(--font-mono);
		font-size: 11px;
		padding: 6px 8px;
		border: 1px solid color-mix(in srgb, var(--sig-danger) 35%, var(--sig-border));
		background: color-mix(in srgb, var(--sig-danger) 12%, var(--sig-surface));
		color: var(--sig-danger);
		border-radius: 6px;
	}

	.os-render-window-autocard {
		height: 100%;
		display: flex;
		flex-direction: column;
	}

	.os-render-window-autocard-action {
		padding: 8px var(--space-md);
		border-top: 1px solid var(--sig-border);
		display: flex;
		justify-content: flex-end;
	}

	@media (max-width: 768px) {
		.os-tab {
			flex-direction: column;
		}

		.os-sidebar {
			width: 100%;
			min-width: 0;
			max-height: 120px;
			border-right: none;
			border-bottom: 1px solid var(--sig-border);
			padding: var(--space-sm);
			overflow-x: auto;
			overflow-y: hidden;
		}
	}
</style>
