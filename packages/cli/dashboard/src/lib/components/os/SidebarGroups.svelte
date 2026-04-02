<script lang="ts">
import { API_BASE } from "$lib/api";
import {
	os,
	type SidebarGroup,
	addToGroup,
	createGroup,
	deleteGroup,
	renameGroup,
	setActiveGroup,
} from "$lib/stores/os.svelte";
import Folder from "@lucide/svelte/icons/folder";
import FolderOpen from "@lucide/svelte/icons/folder-open";
import LayoutGrid from "@lucide/svelte/icons/layout-grid";
import Plus from "@lucide/svelte/icons/plus";
import Trash2 from "@lucide/svelte/icons/trash-2";
import { onMount } from "svelte";

interface BrowserMemoryEntry {
	content?: string;
	tags?: string | string[] | null;
	source_type?: string | null;
}

let newGroupName = $state("");
let showNewInput = $state(false);
let editingId = $state<string | null>(null);
let editingName = $state("");
let allAppsExpanded = $state(false);
let allAppsSelection = $state("");

const sortedApps = $derived([...os.entries].sort((a, b) => a.name.localeCompare(b.name)));
const selectedApp = $derived(sortedApps.find((app) => app.id === allAppsSelection) ?? null);

const browserSync = $state({
	loading: false,
	error: null as string | null,
	bookmarks: 0,
	transcriptions: 0,
	sessions: 0,
	lastSyncedAt: null as string | null,
});

$effect(() => {
	if (sortedApps.length === 0) {
		allAppsSelection = "";
		return;
	}
	if (!allAppsSelection || !sortedApps.some((app) => app.id === allAppsSelection)) {
		allAppsSelection = sortedApps[0].id;
	}
});

function handleCreateGroup(): void {
	const name = newGroupName.trim();
	if (!name) return;
	createGroup(name);
	newGroupName = "";
	showNewInput = false;
}

function startRename(group: SidebarGroup): void {
	editingId = group.id;
	editingName = group.name;
}

function commitRename(): void {
	if (editingId && editingName.trim()) {
		renameGroup(editingId, editingName.trim());
	}
	editingId = null;
	editingName = "";
}

function handleGroupDragOver(e: DragEvent): void {
	e.preventDefault();
	if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
}

function handleGroupDrop(e: DragEvent, groupId: string): void {
	e.preventDefault();
	const appId = e.dataTransfer?.getData("text/plain");
	if (appId) {
		addToGroup(groupId, appId);
	}
}

function handleAppDragStart(e: DragEvent, appId: string): void {
	if (!e.dataTransfer) return;
	e.dataTransfer.setData("text/plain", appId);
	e.dataTransfer.effectAllowed = "move";
}

function parseTags(tags: BrowserMemoryEntry["tags"]): string[] {
	if (Array.isArray(tags)) {
		return tags
			.map((tag) => String(tag).trim().toLowerCase())
			.filter(Boolean);
	}
	if (typeof tags !== "string") return [];
	return tags
		.split(",")
		.map((tag) => tag.trim().toLowerCase())
		.filter(Boolean);
}

function classifyBrowserMemory(memories: BrowserMemoryEntry[]): {
	bookmarks: number;
	transcriptions: number;
	sessions: number;
} {
	let bookmarks = 0;
	let transcriptions = 0;
	let sessions = 0;

	for (const memory of memories) {
		const tags = new Set(parseTags(memory.tags));
		const content = String(memory.content ?? "").toLowerCase();
		const sourceType = String(memory.source_type ?? "").toLowerCase();
		const browserScoped =
			sourceType === "browser-extension" ||
			tags.has("browser-extension") ||
			content.includes("[signet browser tool]") ||
			content.includes("[signet bookmark]") ||
			content.includes("[signet transcribe]") ||
			content.includes("[signet page note]") ||
			content.includes("[signet page capture]");

		if (!browserScoped) continue;

		if (tags.has("bookmark") || content.includes("[signet bookmark]")) {
			bookmarks += 1;
		}

		if (tags.has("transcribe") || content.includes("[signet transcribe]")) {
			transcriptions += 1;
		}

		if (
			tags.has("browser-tool") ||
			tags.has("send-page") ||
			tags.has("send-selection") ||
			tags.has("page-note") ||
			tags.has("page-capture") ||
			content.includes("[signet browser tool]") ||
			content.includes("[signet page note]") ||
			content.includes("[signet page capture]")
		) {
			sessions += 1;
		}
	}

	return { bookmarks, transcriptions, sessions };
}

async function refreshBrowserCategories(): Promise<void> {
	browserSync.loading = true;
	browserSync.error = null;
	try {
		const response = await fetch(`${API_BASE}/api/memories?limit=500&offset=0`);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const data = (await response.json()) as { memories?: BrowserMemoryEntry[] };
		const memoryRows = Array.isArray(data.memories) ? data.memories : [];
		const counts = classifyBrowserMemory(memoryRows);
		browserSync.bookmarks = counts.bookmarks;
		browserSync.transcriptions = counts.transcriptions;
		browserSync.sessions = counts.sessions;
		browserSync.lastSyncedAt = new Date().toISOString();
	} catch (error) {
		browserSync.error = error instanceof Error ? error.message : String(error);
	} finally {
		browserSync.loading = false;
	}
}

function formatSyncTime(iso: string | null): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

onMount(() => {
	void refreshBrowserCategories();
	const timer = window.setInterval(() => {
		void refreshBrowserCategories();
	}, 30_000);
	return () => window.clearInterval(timer);
});
</script>

<div class="sidebar-groups">
	<div class="groups-header">
		<span class="sig-eyebrow">Groups</span>
		<button
			class="group-add-btn"
			title="New group"
			onclick={() => { showNewInput = !showNewInput; }}
		>
			<Plus class="size-3" />
		</button>
	</div>

	<div class="all-apps-wrap">
		<button
			class="group-item"
			class:group-item--active={os.activeGroup === null}
			onclick={() => {
				setActiveGroup(null);
				allAppsExpanded = !allAppsExpanded;
			}}
		>
			<LayoutGrid class="size-3.5" />
			<span>All Apps</span>
			<span class="sig-meta">{sortedApps.length}</span>
			<span class="group-caret">{allAppsExpanded ? "▾" : "▸"}</span>
		</button>

		{#if allAppsExpanded}
			<div class="all-apps-dropdown">
				<div class="all-apps-select-row">
					<label class="sig-meta" for="all-apps-select">Select app</label>
					<select id="all-apps-select" bind:value={allAppsSelection} class="all-apps-select">
						{#each sortedApps as app (app.id)}
							<option value={app.id}>{app.name}</option>
						{/each}
					</select>
				</div>

				{#if selectedApp}
					<div
						class="all-apps-selected"
						draggable="true"
						ondragstart={(e) => handleAppDragStart(e, selectedApp.id)}
						title="Drag selected app into render window"
					>
						<span class="all-apps-item-name">{selectedApp.name}</span>
						<span class="sig-meta">Drag</span>
					</div>
				{/if}

				<div class="all-apps-list">
					{#each sortedApps as app (app.id)}
						<div
							class="all-apps-item"
							draggable="true"
							ondragstart={(e) => handleAppDragStart(e, app.id)}
							title="Drag into render window"
						>
							<span class="all-apps-item-name">{app.name}</span>
							<span class="sig-meta">{app.state}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>

	<div class="groups-subsection">
		<div class="groups-subheader">
			<span class="sig-eyebrow">Browser Sync</span>
			<button
				class="group-refresh-btn"
				onclick={() => void refreshBrowserCategories()}
				disabled={browserSync.loading}
				title="Refresh extension memory categories"
			>
				{browserSync.loading ? "Syncing" : "Refresh"}
			</button>
		</div>

		<div class="group-static-item">
			<span>Browser Bookmarks</span>
			<span class="sig-meta">{browserSync.bookmarks}</span>
		</div>
		<div class="group-static-item">
			<span>Transcriptions</span>
			<span class="sig-meta">{browserSync.transcriptions}</span>
		</div>
		<div class="group-static-item">
			<span>Browser Sessions</span>
			<span class="sig-meta">{browserSync.sessions}</span>
		</div>

		{#if browserSync.error}
			<div class="group-sync-error">{browserSync.error}</div>
		{:else if browserSync.lastSyncedAt}
			<div class="group-sync-meta">Synced {formatSyncTime(browserSync.lastSyncedAt)}</div>
		{/if}
	</div>

	{#each os.groups as group (group.id)}
		<div
			class="group-item"
			class:group-item--active={os.activeGroup === group.id}
			onclick={() => setActiveGroup(group.id)}
			ondragover={handleGroupDragOver}
			ondrop={(e) => handleGroupDrop(e, group.id)}
			role="button"
			tabindex="0"
			onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") setActiveGroup(group.id); }}
		>
			{#if os.activeGroup === group.id}
				<FolderOpen class="size-3.5" />
			{:else}
				<Folder class="size-3.5" />
			{/if}

			{#if editingId === group.id}
				<input
					class="group-rename-input"
					type="text"
					bind:value={editingName}
					onblur={commitRename}
					onkeydown={(e) => {
						if (e.key === "Enter") commitRename();
						if (e.key === "Escape") { editingId = null; }
					}}
				/>
			{:else}
				<span
					class="flex-1 truncate"
					ondblclick={() => startRename(group)}
				>{group.name}</span>
			{/if}

			<span class="sig-meta">{group.items.length}</span>

			<button
				class="group-delete-btn"
				title="Delete group"
				onclick={(e) => { e.stopPropagation(); deleteGroup(group.id); }}
			>
				<Trash2 class="size-2.5" />
			</button>
		</div>
	{/each}

	{#if showNewInput}
		<div class="group-new-input-wrap">
			<input
				class="group-new-input"
				type="text"
				placeholder="Group name…"
				bind:value={newGroupName}
				onkeydown={(e) => {
					if (e.key === "Enter") handleCreateGroup();
					if (e.key === "Escape") { showNewInput = false; }
				}}
			/>
		</div>
	{/if}
</div>

<style>
	.sidebar-groups {
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 0 var(--space-sm);
	}

	.groups-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 4px 4px;
	}

	.groups-subheader {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 4px 4px;
	}

	.group-refresh-btn {
		height: 18px;
		padding: 0 6px;
		border-radius: 4px;
		border: 1px solid var(--sig-border);
		background: transparent;
		color: var(--sig-text-muted);
		font-family: var(--font-mono);
		font-size: 9px;
		cursor: pointer;
	}

	.group-refresh-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.group-add-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border-radius: 3px;
		border: none;
		background: transparent;
		color: var(--sig-text-muted);
		cursor: pointer;
		padding: 0;
	}

	.group-add-btn:hover {
		color: var(--sig-highlight-text);
		background: var(--sig-highlight-muted);
	}

	.all-apps-wrap {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.group-item,
	.group-static-item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		border-radius: 4px;
		border: none;
		background: transparent;
		color: var(--sig-text);
		font-family: var(--font-mono);
		font-size: 11px;
		cursor: pointer;
		text-align: left;
		width: 100%;
		transition: background var(--dur) var(--ease);
	}

	.group-static-item {
		cursor: default;
	}

	.group-item:hover,
	.group-static-item:hover {
		background: rgba(255, 255, 255, 0.04);
	}

	.group-item--active {
		background: var(--sig-surface-raised);
		color: var(--sig-text-bright);
	}

	.group-caret {
		margin-left: auto;
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	.all-apps-dropdown {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 2px 4px 8px;
	}

	.all-apps-select-row {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.all-apps-select {
		width: 100%;
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		border-radius: 4px;
		padding: 3px 6px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-bright);
	}

	.all-apps-selected,
	.all-apps-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 4px 6px;
		border-radius: 4px;
		border: 1px solid var(--sig-border);
		background: var(--sig-surface);
		font-family: var(--font-mono);
		font-size: 10px;
		cursor: grab;
	}

	.all-apps-item:active,
	.all-apps-selected:active {
		cursor: grabbing;
	}

	.all-apps-item-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.all-apps-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 140px;
		overflow-y: auto;
	}

	.groups-subsection {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 2px 0 6px;
	}

	.group-sync-error {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-danger);
		padding: 4px 8px;
	}

	.group-sync-meta {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		padding: 2px 8px 4px;
	}

	.group-delete-btn {
		display: none;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		border-radius: 3px;
		border: none;
		background: transparent;
		color: var(--sig-text-muted);
		cursor: pointer;
		padding: 0;
	}

	.group-item:hover .group-delete-btn {
		display: flex;
	}

	.group-delete-btn:hover {
		color: var(--sig-danger);
	}

	.group-rename-input {
		background: var(--sig-bg);
		border: 1px solid var(--sig-border-strong);
		border-radius: 3px;
		padding: 1px 4px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-bright);
		flex: 1;
		outline: none;
	}

	.group-new-input-wrap {
		padding: 2px 4px;
	}

	.group-new-input {
		width: 100%;
		background: var(--sig-bg);
		border: 1px solid var(--sig-border-strong);
		border-radius: 4px;
		padding: 3px 8px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-bright);
		outline: none;
	}

	.group-new-input:focus {
		border-color: var(--sig-highlight);
	}

	:root[data-theme="light"] .group-item:hover,
	:root[data-theme="light"] .group-static-item:hover {
		background: rgba(0, 0, 0, 0.04);
	}

	:root[data-theme="light"] .group-item--active {
		background: rgba(0, 0, 0, 0.06);
	}

	@media (max-width: 768px) {
		.sidebar-groups {
			flex-direction: row;
			flex-wrap: wrap;
			gap: 4px;
		}

		.groups-header {
			padding: 0 4px;
			min-width: fit-content;
		}

		.groups-subsection {
			min-width: 180px;
		}

		.group-item,
		.group-static-item {
			width: auto;
			white-space: nowrap;
			padding: 4px 10px;
		}

		.group-new-input-wrap {
			padding: 0 4px;
		}

		.group-new-input {
			width: 120px;
		}
	}
</style>
