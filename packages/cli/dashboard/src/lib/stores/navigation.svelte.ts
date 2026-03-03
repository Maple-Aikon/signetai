/**
 * Shared navigation state for the dashboard.
 *
 * Active tab is synced to location.hash for refresh persistence
 * and browser back/forward support.
 */

import { confirmDiscardChanges } from "$lib/stores/unsaved-changes.svelte";

export type TabId =
	| "config"
	| "settings"
	| "memory"
	| "embeddings"
	| "pipeline"
	| "logs"
	| "secrets"
	| "skills"
	| "tasks"
	| "connectors";

const VALID_TABS: ReadonlySet<string> = new Set<TabId>([
	"config",
	"settings",
	"memory",
	"embeddings",
	"pipeline",
	"logs",
	"secrets",
	"skills",
	"tasks",
	"connectors",
]);

function readTabFromHash(): TabId | null {
	if (typeof window === "undefined") return null;
	const hash = window.location.hash.slice(1);
	return VALID_TABS.has(hash) ? (hash as TabId) : null;
}

export const nav = $state({
	activeTab: "config" as TabId,
});

export function setTab(tab: TabId): boolean {
	if (tab === nav.activeTab) return true;
	if (!confirmDiscardChanges(`switch to ${tab}`)) return false;
	nav.activeTab = tab;
	if (typeof window !== "undefined") {
		history.replaceState(null, "", `#${tab}`);
	}
	return true;
}

/**
 * Read initial tab from URL hash and listen for hashchange events.
 * Call from onMount in the root page component.
 * Returns a cleanup function to remove the event listener.
 */
export function initNavFromHash(): () => void {
	const initial = readTabFromHash();
	if (initial) {
		nav.activeTab = initial;
	} else if (typeof window !== "undefined") {
		// No hash present — set it to the default tab
		history.replaceState(null, "", `#${nav.activeTab}`);
	}

	const onHashChange = () => {
		const tab = readTabFromHash();
		if (tab && tab !== nav.activeTab) nav.activeTab = tab;
	};
	window.addEventListener("hashchange", onHashChange);
	return () => window.removeEventListener("hashchange", onHashChange);
}
