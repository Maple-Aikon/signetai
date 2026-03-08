<script lang="ts">
import { onMount } from "svelte";
import { fetchChangelog, fetchRoadmap, type ChangelogDoc } from "$lib/api";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import Github from "@lucide/svelte/icons/github";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";

type View = "roadmap" | "changelog";

let view = $state<View>("roadmap");
let roadmap = $state<ChangelogDoc | null>(null);
let changelog = $state<ChangelogDoc | null>(null);
let loading = $state(true);
let error = $state(false);

async function load() {
	loading = true;
	error = false;
	try {
		const [rm, cl] = await Promise.all([fetchRoadmap(), fetchChangelog()]);
		roadmap = rm;
		changelog = cl;
		if (!rm && !cl) error = true;
	} catch {
		error = true;
	} finally {
		loading = false;
	}
}

onMount(load);

function sourceLabel(doc: ChangelogDoc | null): string {
	if (!doc) return "";
	const ago = Math.round((Date.now() - doc.cachedAt) / 1000 / 60);
	const src = doc.source === "github" ? "github" : "local copy";
	return ago < 1 ? `${src} · just now` : `${src} · ${ago}m ago`;
}

const activeDoc = $derived(view === "roadmap" ? roadmap : changelog);
</script>

<div class="flex flex-col h-full overflow-hidden">
	<!-- Header / toggle -->
	<div class="flex items-center gap-1 px-4 py-2 border-b border-[var(--sig-border)] shrink-0">
		<button
			class="px-3 py-1 text-[11px] uppercase tracking-[0.08em] font-[family-name:var(--font-mono)]
				transition-colors duration-150
				{view === 'roadmap'
					? 'text-[var(--sig-text-bright)] border-b border-[var(--sig-accent)]'
					: 'text-[var(--sig-text-muted)] hover:text-[var(--sig-text)]'}"
			onclick={() => (view = "roadmap")}
		>
			Roadmap
		</button>
		<button
			class="px-3 py-1 text-[11px] uppercase tracking-[0.08em] font-[family-name:var(--font-mono)]
				transition-colors duration-150
				{view === 'changelog'
					? 'text-[var(--sig-text-bright)] border-b border-[var(--sig-accent)]'
					: 'text-[var(--sig-text-muted)] hover:text-[var(--sig-text)]'}"
			onclick={() => (view = "changelog")}
		>
			Changelog
		</button>

		<div class="ml-auto flex items-center gap-2">
			{#if !loading && activeDoc}
				<span class="sig-meta text-[var(--sig-text-muted)] flex items-center gap-1">
					<Github class="size-3" />
					{sourceLabel(activeDoc)}
				</span>
			{/if}
			<button
				class="text-[var(--sig-text-muted)] hover:text-[var(--sig-text)] transition-colors"
				onclick={load}
				title="Refresh"
			>
				<RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
			</button>
		</div>
	</div>

	<!-- Content -->
	<div class="flex-1 overflow-y-auto px-6 py-4">
		{#if loading}
			<div class="flex flex-col gap-3 max-w-2xl">
				<Skeleton class="h-6 w-48" />
				<Skeleton class="h-4 w-full" />
				<Skeleton class="h-4 w-3/4" />
				<Skeleton class="h-4 w-5/6" />
				<Skeleton class="h-4 w-full" />
				<Skeleton class="h-4 w-2/3" />
			</div>
		{:else if error || !activeDoc}
			<div class="flex flex-col items-center justify-center h-full gap-3 text-[var(--sig-text-muted)]">
				<span class="sig-label">couldn't reach github or find local files</span>
				<button
					class="text-[11px] uppercase tracking-[0.06em] font-[family-name:var(--font-mono)]
						text-[var(--sig-accent)] hover:opacity-80 transition-opacity"
					onclick={load}
				>
					retry
				</button>
			</div>
		{:else}
			<div class="changelog-md max-w-2xl">
				{@html activeDoc.html}
			</div>
		{/if}
	</div>
</div>

<style>
	.changelog-md :global(h1) {
		font-family: var(--font-display);
		font-size: var(--font-size-lg);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-bright);
		margin-bottom: var(--space-sm);
		margin-top: var(--space-lg);
	}
	.changelog-md :global(h2) {
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sig-text-bright);
		margin-top: var(--space-lg);
		margin-bottom: var(--space-xs);
		padding-bottom: var(--space-xs);
		border-bottom: 1px solid var(--sig-border);
	}
	.changelog-md :global(h3) {
		font-family: var(--font-mono);
		font-size: var(--font-size-base);
		font-weight: 600;
		color: var(--sig-text);
		margin-top: var(--space-md);
		margin-bottom: var(--space-xs);
	}
	.changelog-md :global(p) {
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		color: var(--sig-text-muted);
		line-height: 1.6;
		margin-bottom: var(--space-sm);
	}
	.changelog-md :global(ul) {
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		color: var(--sig-text-muted);
		padding-left: var(--space-md);
		margin-bottom: var(--space-sm);
		line-height: 1.7;
	}
	.changelog-md :global(li) {
		margin-bottom: 2px;
	}
	.changelog-md :global(code) {
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		background: var(--sig-surface-raised);
		color: var(--sig-accent);
		padding: 1px 4px;
		border-radius: 2px;
	}
	.changelog-md :global(strong) {
		color: var(--sig-text);
		font-weight: 600;
	}
	.changelog-md :global(hr) {
		border: none;
		border-top: 1px solid var(--sig-border);
		margin: var(--space-lg) 0;
	}
	.changelog-md :global(a) {
		color: var(--sig-accent);
		text-decoration: none;
	}
	.changelog-md :global(a:hover) {
		text-decoration: underline;
	}
</style>
