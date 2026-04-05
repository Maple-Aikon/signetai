<script lang="ts">
import { API_BASE, getSkills, type Skill } from "$lib/api";
import {
	os,
	type SidebarGroup,
	addToGroup,
	createGroup,
	deleteGroup,
	renameGroup,
	setActiveGroup,
} from "$lib/stores/os.svelte";
import BookOpen from "@lucide/svelte/icons/book-open";
import Folder from "@lucide/svelte/icons/folder";
import FolderOpen from "@lucide/svelte/icons/folder-open";
import LayoutGrid from "@lucide/svelte/icons/layout-grid";
import Plus from "@lucide/svelte/icons/plus";
import Trash2 from "@lucide/svelte/icons/trash-2";
import { onMount } from "svelte";

interface BrowserMemoryEntry {
	id?: string;
	content?: string;
	tags?: string | string[] | null;
	source_type?: string | null;
	created_at?: string;
}

interface BrowserSyncItem {
	id: string;
	title: string;
	subtitle?: string;
	url?: string;
	snippet: string;
	createdAt?: string;
}

interface InstalledSkillItem {
	id: string;
	name: string;
	description: string;
	argHint?: string;
	command: string;
}

let newGroupName = $state("");
let showNewInput = $state(false);
let editingId = $state<string | null>(null);
let editingName = $state("");
let allAppsExpanded = $state(false);
let allAppsSelection = $state("");
let allSkillsExpanded = $state(false);
let allSkillsSelection = $state("");
let browserBookmarksExpanded = $state(false);
let browserTranscriptionsExpanded = $state(false);
let browserSessionsExpanded = $state(false);
let suppressBookmarkClickUntil = 0;

const sortedApps = $derived([...os.entries].sort((a, b) => a.name.localeCompare(b.name)));
const selectedApp = $derived(sortedApps.find((app) => app.id === allAppsSelection) ?? null);

const skillsSync = $state({
	loading: false,
	error: null as string | null,
	items: [] as InstalledSkillItem[],
	lastSyncedAt: null as string | null,
});

const selectedSkill = $derived(skillsSync.items.find((skill) => skill.id === allSkillsSelection) ?? null);

const browserSync = $state({
	loading: false,
	error: null as string | null,
	bookmarks: [] as BrowserSyncItem[],
	transcriptions: [] as BrowserSyncItem[],
	sessions: [] as BrowserSyncItem[],
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

$effect(() => {
	if (skillsSync.items.length === 0) {
		allSkillsSelection = "";
		return;
	}
	if (!allSkillsSelection || !skillsSync.items.some((skill) => skill.id === allSkillsSelection)) {
		allSkillsSelection = skillsSync.items[0].id;
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
	const appId =
		e.dataTransfer?.getData("application/x-signet-app-id")?.trim() ||
		e.dataTransfer?.getData("text/plain")?.trim() ||
		"";
	if (!appId || !os.entries.some((entry) => entry.id === appId)) return;
	addToGroup(groupId, appId);
}

function handleAppDragStart(e: DragEvent, app: { id: string; name: string }): void {
	if (!e.dataTransfer) return;
	const chatSnippet = [
		"MCP app context",
		`App: ${app.name}`,
		`Server ID: ${app.id}`,
	].join("\n");
	e.dataTransfer.setData("application/x-signet-app-id", app.id);
	e.dataTransfer.setData("application/x-signet-chat-snippet", chatSnippet);
	e.dataTransfer.setData("text/plain", app.id);
	e.dataTransfer.effectAllowed = "copyMove";
}

function handleMemoryDragStart(e: DragEvent, item: BrowserSyncItem): void {
	if (!e.dataTransfer) return;
	e.dataTransfer.setData("application/x-signet-chat-snippet", item.snippet);
	e.dataTransfer.setData("text/plain", item.snippet);
	e.dataTransfer.effectAllowed = "copy";
}

function handleBookmarkDragStart(e: DragEvent, item: BrowserSyncItem): void {
	suppressBookmarkClickUntil = Date.now() + 250;
	handleMemoryDragStart(e, item);
}

function handleBookmarkClick(item: BrowserSyncItem): void {
	if (Date.now() < suppressBookmarkClickUntil) return;
	const url = item.url?.trim();
	if (!url) return;
	const opened = window.open(url, "_blank");
	if (opened) {
		try {
			opened.opener = null;
		} catch {
			// noop
		}
	}
}

function buildSkillSlashCommand(skill: Skill): string {
	const baseCommand = `/${skill.name}`;
	const argHint = skill.arg_hint?.trim();
	return argHint ? `${baseCommand} ${argHint}` : `${baseCommand} `;
}

function handleSkillDragStart(e: DragEvent, skill: InstalledSkillItem): void {
	if (!e.dataTransfer) return;
	e.dataTransfer.setData("application/x-signet-chat-snippet", skill.command);
	e.dataTransfer.setData("text/plain", skill.command);
	e.dataTransfer.effectAllowed = "copy";
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

function extractField(content: string, field: string): string | null {
	const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = content.match(new RegExp(`^${escapedField}:\\s*(.+)$`, "im"));
	return match?.[1]?.trim() || null;
}

function stripSignetHeaders(content: string): string {
	return content
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			if (!trimmed) return true;
			if (/^\[signet[\w\s-]*\]/i.test(trimmed)) return false;
			if (/^(title|url|saved at|captured at|source|format):/i.test(trimmed)) return false;
			if (/^(source_title|source_url|timestamp|created_at):/i.test(trimmed)) return false;
			return true;
		})
		.join("\n")
		.trim();
}

function normalizeHttpUrl(raw: string | null): string | undefined {
	if (!raw) return undefined;
	try {
		const parsed = new URL(raw.trim());
		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			return parsed.toString();
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function buildBrowserSyncItem(memory: BrowserMemoryEntry, index: number, kind: "bookmark" | "transcription" | "session"): BrowserSyncItem {
	const content = String(memory.content ?? "").trim();
	const title =
		extractField(content, "Title") ||
		extractField(content, "source_title") ||
		extractField(content, "Source") ||
		`${kind[0]!.toUpperCase()}${kind.slice(1)} ${index + 1}`;
	const url = normalizeHttpUrl(extractField(content, "URL") || extractField(content, "source_url"));
	const body = stripSignetHeaders(content);
	const snippet = [
		kind === "bookmark"
			? "Browser bookmark context"
			: kind === "transcription"
				? "Browser transcription context"
				: "Browser session context",
		`Title: ${title}`,
		url ? `URL: ${url}` : "",
		body || content,
	]
		.filter(Boolean)
		.join("\n")
		.slice(0, 1400);

	return {
		id: memory.id?.trim() || `${kind}-${index}`,
		title,
		subtitle: url || extractField(content, "Format") || undefined,
		url,
		snippet,
		createdAt: memory.created_at,
	};
}

function classifyBrowserMemory(memories: BrowserMemoryEntry[]): {
	bookmarks: BrowserSyncItem[];
	transcriptions: BrowserSyncItem[];
	sessions: BrowserSyncItem[];
} {
	const bookmarks: BrowserSyncItem[] = [];
	const transcriptions: BrowserSyncItem[] = [];
	const sessions: BrowserSyncItem[] = [];

	for (const [index, memory] of memories.entries()) {
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
			content.includes("[signet page capture]") ||
			content.includes("--- signet-selection-bundle.txt ---") ||
			content.includes("--- signet-harness-payload.txt ---");

		if (!browserScoped) continue;

		if (tags.has("bookmark") || content.includes("[signet bookmark]")) {
			bookmarks.push(buildBrowserSyncItem(memory, index, "bookmark"));
		}

		if (tags.has("transcribe") || content.includes("[signet transcribe]")) {
			transcriptions.push(buildBrowserSyncItem(memory, index, "transcription"));
		}

		if (
			tags.has("browser-tool") ||
			tags.has("send-page") ||
			tags.has("send-selection") ||
			tags.has("page-note") ||
			tags.has("page-capture") ||
			content.includes("[signet browser tool]") ||
			content.includes("[signet page note]") ||
			content.includes("[signet page capture]") ||
			content.includes("--- signet-selection-bundle.txt ---") ||
			content.includes("--- signet-harness-payload.txt ---")
		) {
			sessions.push(buildBrowserSyncItem(memory, index, "session"));
		}
	}

	const sortByNewest = (a: BrowserSyncItem, b: BrowserSyncItem): number => {
		const aTs = Date.parse(a.createdAt ?? "");
		const bTs = Date.parse(b.createdAt ?? "");
		if (Number.isFinite(aTs) && Number.isFinite(bTs)) return bTs - aTs;
		if (Number.isFinite(aTs)) return -1;
		if (Number.isFinite(bTs)) return 1;
		return b.id.localeCompare(a.id);
	};

	bookmarks.sort(sortByNewest);
	transcriptions.sort(sortByNewest);
	sessions.sort(sortByNewest);

	return { bookmarks, transcriptions, sessions };
}

async function refreshSkills(): Promise<void> {
	skillsSync.loading = true;
	skillsSync.error = null;
	try {
		const installedSkills = await getSkills();
		skillsSync.items = installedSkills
			.flatMap((skill, index) => {
				const name = String(skill.name ?? "").trim();
				if (!name) return [];
				const command = buildSkillSlashCommand(skill);
				const description = String(skill.description ?? "").trim() || "Installed Signet skill";
				const argHint = skill.arg_hint?.trim() || undefined;
				const item: InstalledSkillItem = {
					id: skill.path?.trim() || `${name}-${index}`,
					name,
					description,
					command,
				};
				if (argHint) item.argHint = argHint;
				return [item];
			})
			.sort((a, b) => a.name.localeCompare(b.name));
		skillsSync.lastSyncedAt = new Date().toISOString();
	} catch (error) {
		skillsSync.error = error instanceof Error ? error.message : String(error);
	} finally {
		skillsSync.loading = false;
	}
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
		const groups = classifyBrowserMemory(memoryRows);
		browserSync.bookmarks = groups.bookmarks;
		browserSync.transcriptions = groups.transcriptions;
		browserSync.sessions = groups.sessions;
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
	void refreshSkills();
	void refreshBrowserCategories();
	const timer = window.setInterval(() => {
		void refreshSkills();
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
						ondragstart={(e) => handleAppDragStart(e, selectedApp)}
						title="Drag selected app into render window or OS chat input"
					>
						<span class="all-apps-item-name">{selectedApp.name}</span>
						<span class="sig-meta">Drag</span>
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<div class="groups-subsection">
		<div class="groups-subheader">
			<span class="sig-eyebrow">Skills</span>
			<button
				class="group-refresh-btn"
				onclick={() => void refreshSkills()}
				disabled={skillsSync.loading}
				title="Refresh installed skills"
			>
				{skillsSync.loading ? "Syncing" : "Refresh"}
			</button>
		</div>

		<button
			class="group-item"
			class:group-item--active={allSkillsExpanded}
			type="button"
			onclick={() => { allSkillsExpanded = !allSkillsExpanded; }}
		>
			<BookOpen class="size-3.5" />
			<span>All Skills</span>
			<span class="sig-meta">{skillsSync.items.length}</span>
			<span class="group-caret">{allSkillsExpanded ? "▾" : "▸"}</span>
		</button>

		{#if allSkillsExpanded}
			<div class="all-apps-dropdown">
				<div class="all-apps-select-row">
					<label class="sig-meta" for="all-skills-select">Select skill</label>
					<select id="all-skills-select" bind:value={allSkillsSelection} class="all-apps-select">
						{#if skillsSync.items.length > 0}
							{#each skillsSync.items as skill (skill.id)}
								<option value={skill.id}>{skill.name}</option>
							{/each}
						{:else}
							<option value="" disabled>No installed skills</option>
						{/if}
					</select>
				</div>

				{#if selectedSkill}
					<div
						class="all-apps-selected"
						draggable="true"
						ondragstart={(e) => handleSkillDragStart(e, selectedSkill)}
						title="Drag default slash command into OS chat input"
					>
						<span class="all-apps-item-name">/{selectedSkill.name}</span>
						<span class="sig-meta">Drag</span>
					</div>
					<div class="skill-command-preview">{selectedSkill.command}</div>
				{/if}
			</div>
		{/if}

		{#if skillsSync.error}
			<div class="group-sync-error">{skillsSync.error}</div>
		{:else if skillsSync.lastSyncedAt}
			<div class="group-sync-meta">Synced {formatSyncTime(skillsSync.lastSyncedAt)}</div>
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

		<button
			class="group-item"
			type="button"
			onclick={() => { browserBookmarksExpanded = !browserBookmarksExpanded; }}
		>
			<span>Browser Bookmarks</span>
			<span class="sig-meta">{browserSync.bookmarks.length}</span>
			<span class="group-caret">{browserBookmarksExpanded ? "▾" : "▸"}</span>
		</button>
		{#if browserBookmarksExpanded}
			<div class="browser-memory-dropdown">
				{#if browserSync.bookmarks.length === 0}
					<div class="browser-memory-empty">No bookmark memories synced yet.</div>
				{:else}
					{#each browserSync.bookmarks as item (item.id)}
						<div
							class="browser-memory-item"
							class:browser-memory-item--clickable={Boolean(item.url)}
							draggable="true"
							ondragstart={(e) => handleBookmarkDragStart(e, item)}
							onclick={() => handleBookmarkClick(item)}
							onkeydown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									handleBookmarkClick(item);
								}
							}}
							role="button"
							tabindex="0"
							title={item.url
								? "Click to open bookmark, or drag into OS chat input"
								: "Drag into OS chat input"}
						>
							<span class="browser-memory-title">{item.title}</span>
							{#if item.subtitle}
								<span class="browser-memory-subtitle">{item.subtitle}</span>
							{/if}
						</div>
					{/each}
				{/if}
			</div>
		{/if}

		<button
			class="group-item"
			type="button"
			onclick={() => { browserTranscriptionsExpanded = !browserTranscriptionsExpanded; }}
		>
			<span>Transcriptions</span>
			<span class="sig-meta">{browserSync.transcriptions.length}</span>
			<span class="group-caret">{browserTranscriptionsExpanded ? "▾" : "▸"}</span>
		</button>
		{#if browserTranscriptionsExpanded}
			<div class="browser-memory-dropdown">
				{#if browserSync.transcriptions.length === 0}
					<div class="browser-memory-empty">No transcriptions synced yet.</div>
				{:else}
					{#each browserSync.transcriptions as item (item.id)}
						<div
							class="browser-memory-item"
							draggable="true"
							ondragstart={(e) => handleMemoryDragStart(e, item)}
							title="Drag into OS chat input"
						>
							<span class="browser-memory-title">{item.title}</span>
							{#if item.subtitle}
								<span class="browser-memory-subtitle">{item.subtitle}</span>
							{/if}
						</div>
					{/each}
				{/if}
			</div>
		{/if}

		<button
			class="group-item"
			type="button"
			onclick={() => { browserSessionsExpanded = !browserSessionsExpanded; }}
		>
			<span>Browser Sessions</span>
			<span class="sig-meta">{browserSync.sessions.length}</span>
			<span class="group-caret">{browserSessionsExpanded ? "▾" : "▸"}</span>
		</button>
		{#if browserSessionsExpanded}
			<div class="browser-memory-dropdown">
				{#if browserSync.sessions.length === 0}
					<div class="browser-memory-empty">No browser session memories synced yet.</div>
				{:else}
					{#each browserSync.sessions as item (item.id)}
						<div
							class="browser-memory-item"
							draggable="true"
							ondragstart={(e) => handleMemoryDragStart(e, item)}
							title="Drag into OS chat input"
						>
							<span class="browser-memory-title">{item.title}</span>
							{#if item.subtitle}
								<span class="browser-memory-subtitle">{item.subtitle}</span>
							{/if}
						</div>
					{/each}
				{/if}
			</div>
		{/if}

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

	.skill-command-preview {
	font-family: var(--font-mono);
	font-size: 9px;
	line-height: 1.35;
	padding: 4px 6px;
	border: 1px dashed var(--sig-border);
	border-radius: 4px;
	color: var(--sig-text-muted);
	background: color-mix(in srgb, var(--sig-surface) 88%, transparent);
	word-break: break-word;
}
	.groups-subsection {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 2px 0 6px;
	}

	.browser-memory-dropdown {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 2px 4px 8px;
		max-height: 156px;
		overflow-y: auto;
	}

	.browser-memory-item {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 5px 6px;
		border-radius: 4px;
		border: 1px solid var(--sig-border);
		background: var(--sig-surface);
		cursor: grab;
	}

	.browser-memory-item--clickable {
		cursor: pointer;
	}

	.browser-memory-item--clickable:hover {
		border-color: var(--sig-border-strong);
		background: color-mix(in srgb, var(--sig-surface) 78%, var(--sig-highlight-muted));
	}

	.browser-memory-item:active {
		cursor: grabbing;
	}

	.browser-memory-title {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.browser-memory-subtitle {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.browser-memory-empty {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		padding: 4px 6px;
		border-radius: 4px;
		border: 1px dashed var(--sig-border);
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
