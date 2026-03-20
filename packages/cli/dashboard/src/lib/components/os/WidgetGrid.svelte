<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import type { AppTrayEntry, GridPosition } from "$lib/stores/os.svelte";
	import { os, updateGridPosition, moveToTray, collapseWidget, findFreeGridPosition } from "$lib/stores/os.svelte";
	import WidgetCard from "./WidgetCard.svelte";

	interface Props {
		apps: AppTrayEntry[];
		ongriddrop: (appId: string, x: number, y: number) => void;
		/** Resolve the default widget size for a given appId (used for collision detection on drop) */
		resolveDefaultSize?: (appId: string) => { w: number; h: number };
	}

	const { apps, ongriddrop, resolveDefaultSize }: Props = $props();

	// Grid config: 12 columns, each row = 80px
	const GRID_COLS = 12;
	const ROW_HEIGHT = 80;
	const GAP = 8;

	// Drag state
	let dragId = $state<string | null>(null);
	let dragStartX = $state(0);
	let dragStartY = $state(0);
	let dragOffsetX = $state(0);
	let dragOffsetY = $state(0);
	let gridEl = $state<HTMLDivElement | null>(null);

	// Track active drag listeners for cleanup
	let activeMoveListener: ((e: PointerEvent) => void) | null = null;
	let activeUpListener: (() => void) | null = null;

	function cleanupDragListeners(): void {
		if (activeMoveListener) {
			window.removeEventListener("pointermove", activeMoveListener);
			activeMoveListener = null;
		}
		if (activeUpListener) {
			window.removeEventListener("pointerup", activeUpListener);
			activeUpListener = null;
		}
	}

	onDestroy(() => {
		cleanupDragListeners();
		window.removeEventListener("keydown", handleKeydown);
	});

	// Focus mode

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === "Escape" && os.focusedId) {
			collapseWidget();
		}
	}

	onMount(() => {
		window.addEventListener("keydown", handleKeydown);
	});

	const focusedApp = $derived(os.focusedId ? apps.find((a) => a.id === os.focusedId) ?? null : null);

	// Compute max rows needed
	const maxRow = $derived.by(() => {
		let max = 6; // Minimum 6 rows
		for (const app of apps) {
			if (app.gridPosition) {
				const bottom = app.gridPosition.y + app.gridPosition.h;
				if (bottom > max) max = bottom;
			}
		}
		return max + 2; // Extra space at bottom
	});

	function getStyle(pos: GridPosition | undefined): string {
		if (!pos) return "";
		return `grid-column: ${pos.x + 1} / span ${pos.w}; grid-row: ${pos.y + 1} / span ${pos.h};`;
	}

	function handleDragStart(id: string, e: PointerEvent): void {
		// Clean up any lingering listeners from a previous drag
		cleanupDragListeners();

		dragId = id;
		dragStartX = e.clientX;
		dragStartY = e.clientY;
		dragOffsetX = 0;
		dragOffsetY = 0;

		const onMove = (me: PointerEvent) => {
			dragOffsetX = me.clientX - dragStartX;
			dragOffsetY = me.clientY - dragStartY;
		};

		const onUp = () => {
			cleanupDragListeners();
			commitDrag();
		};

		activeMoveListener = onMove;
		activeUpListener = onUp;
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	/** Find the nearest non-colliding position by spiraling outward */
	function findFreePosition(desired: GridPosition, excludeId: string): GridPosition {
		const occupied = apps.flatMap((a) =>
			a.id !== excludeId && a.gridPosition ? [a.gridPosition] : [],
		);
		return findFreeGridPosition(occupied, { w: desired.w, h: desired.h }, { x: desired.x, y: desired.y });
	}

	function commitDrag(): void {
		if (!dragId || !gridEl) {
			dragId = null;
			return;
		}

		const app = apps.find((a) => a.id === dragId);
		if (!app?.gridPosition) {
			dragId = null;
			return;
		}

		// Convert pixel offset to grid units
		const cellWidth = gridEl.clientWidth / GRID_COLS;
		const dx = Math.round(dragOffsetX / cellWidth);
		const dy = Math.round(dragOffsetY / ROW_HEIGHT);

		if (dx === 0 && dy === 0) {
			dragId = null;
			return;
		}

		const desired: GridPosition = {
			x: Math.max(0, Math.min(GRID_COLS - app.gridPosition.w, app.gridPosition.x + dx)),
			y: Math.max(0, app.gridPosition.y + dy),
			w: app.gridPosition.w,
			h: app.gridPosition.h,
		};

		// Resolve collisions — find nearest free spot
		const newPos = findFreePosition(desired, app.id);

		updateGridPosition(app.id, newPos);
		dragId = null;
		dragOffsetX = 0;
		dragOffsetY = 0;
	}

	async function handleRemove(id: string): Promise<void> {
		await moveToTray(id);
	}

	// Drag-over for tray → grid drops
	function handleGridDragOver(e: DragEvent): void {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
	}

	function handleGridDrop(e: DragEvent): void {
		e.preventDefault();
		const appId = e.dataTransfer?.getData("text/plain");
		if (!appId || !gridEl) return;

		const rect = gridEl.getBoundingClientRect();
		const cellWidth = rect.width / GRID_COLS;
		const rawX = Math.max(0, Math.min(GRID_COLS - 1, Math.floor((e.clientX - rect.left) / cellWidth)));
		const rawY = Math.max(0, Math.floor((e.clientY - rect.top) / ROW_HEIGHT));

		// Use manifest size if available, otherwise fall back to default
		const size = resolveDefaultSize ? resolveDefaultSize(appId) : { w: 4, h: 3 };
		const desired: GridPosition = { x: rawX, y: rawY, ...size };
		const resolved = findFreePosition(desired, appId);

		ongriddrop(appId, resolved.x, resolved.y);
	}
</script>

<div
	class="widget-grid"
	class:has-focus={os.focusedId !== null}
	bind:this={gridEl}
	style="grid-template-rows: repeat({maxRow}, {ROW_HEIGHT}px); gap: {GAP}px;"
	ondragover={handleGridDragOver}
	ondrop={handleGridDrop}
	role="grid"
>
	{#if apps.length === 0}
		<div class="grid-empty">
			<span class="sig-label">Drag apps from the tray below to place them here</span>
		</div>
	{/if}

	{#each apps as app (app.id)}
		{@const isDragging = dragId === app.id}
		<div
			class="grid-item"
			class:grid-item--dragging={isDragging}
			style="{getStyle(app.gridPosition)}{isDragging ? ` transform: translate(${dragOffsetX}px, ${dragOffsetY}px);` : ''}"
		>
			<WidgetCard
				{app}
				onremove={handleRemove}
				ondragstart={handleDragStart}
			/>
		</div>
	{/each}

	{#if focusedApp}
		<div
			class="widget-focus-backdrop"
			onclick={collapseWidget}
			onkeydown={(e) => e.key === "Escape" && collapseWidget()}
			role="dialog"
			aria-modal="true"
			tabindex="-1"
		>
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div class="widget-focus-panel" onclick={(e) => e.stopPropagation()}>
				<WidgetCard
					app={focusedApp}
					onremove={() => collapseWidget()}
					ondragstart={() => {}}
				/>
			</div>
		</div>
	{/if}
</div>

<style>
	.widget-grid {
		display: grid;
		grid-template-columns: repeat(12, 1fr);
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
		padding: var(--space-md);
		position: relative;

		/* Blueprint grid lines */
		background-image:
			linear-gradient(var(--sig-grid-line) 1px, transparent 1px),
			linear-gradient(90deg, var(--sig-grid-line) 1px, transparent 1px);
		background-size: calc(100% / 12) 80px;
	}

	.grid-empty {
		grid-column: 1 / -1;
		grid-row: 1 / 4;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px dashed var(--sig-border-strong);
		border-radius: var(--radius);
		padding: var(--space-xl);
	}

	.grid-item {
		position: relative;
		z-index: 1;
		transition: box-shadow 0.15s ease;
	}

	.grid-item--dragging {
		z-index: 100;
		opacity: 0.85;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		pointer-events: none;
	}

	.widget-grid.has-focus .grid-item {
		opacity: 0.15;
		pointer-events: none;
	}

	.widget-focus-backdrop {
		position: fixed;
		inset: 0;
		z-index: 200;
		background: rgba(0, 0, 0, 0.8);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 32px;
	}

	.widget-focus-panel {
		width: 100%;
		max-width: 900px;
		height: 80vh;
		border-radius: 12px;
		overflow: hidden;
	}
</style>
