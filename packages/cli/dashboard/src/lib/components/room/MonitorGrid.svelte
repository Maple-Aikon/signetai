<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import {
		room,
		startPolling,
		stopPolling,
		selectAgent,
		getGridSlots,
	} from "$lib/stores/agents.svelte";
	import { fetchWidgetHtml } from "$lib/stores/os.svelte";
	import { buildSrcdoc } from "$lib/components/os/widget-theme";
	import G3Monitor from "./G3Monitor.svelte";
	import ZoomView from "./ZoomView.svelte";
	import AddAgentDialog from "./AddAgentDialog.svelte";
	import Plus from "@lucide/svelte/icons/plus";

	/* ── Widget HTML cache for MCP monitor previews ──────── */
	let widgetHtmlMap = $state(new Map<string, string>());
	let widgetLoadingSet = $state(new Set<string>());

	/** Fetch widget HTML for all MCP agents */
	async function loadWidgetPreviews(): Promise<void> {
		const mcpAgents = room.agents.filter(
			(a) => a.source.type === "mcp",
		);
		for (const agent of mcpAgents) {
			const serverId = (agent.source as { type: "mcp"; serverId: string }).serverId;
			// Skip if already loaded
			if (widgetHtmlMap.has(serverId)) continue;
			// Mark as loading
			widgetLoadingSet = new Set([...widgetLoadingSet, serverId]);
			// Fetch in background (don't await in sequence — fire them all)
			fetchWidgetHtml(serverId).then((html) => {
				if (html) {
					const srcdoc = buildSrcdoc(html, serverId);
					widgetHtmlMap = new Map([...widgetHtmlMap, [serverId, srcdoc]]);
				}
				// Remove from loading set
				const next = new Set(widgetLoadingSet);
				next.delete(serverId);
				widgetLoadingSet = next;
			});
		}
	}

	onMount(() => {
		startPolling();
		window.addEventListener("keydown", handleKeydown);
		// Initial load of widget previews (after first agent fetch settles)
		setTimeout(loadWidgetPreviews, 1500);
	});

	onDestroy(() => {
		stopPolling();
		window.removeEventListener("keydown", handleKeydown);
	});

	// Re-load widget previews when agents change (new MCP agent discovered)
	$effect(() => {
		// Depend on agent list length and source types
		const mcpCount = room.agents.filter((a) => a.source.type === "mcp").length;
		if (mcpCount > 0) {
			loadWidgetPreviews();
		}
	});

	const slots = $derived(getGridSlots());
	const activeCount = $derived(
		room.agents.filter((a) => a.status === "active").length,
	);
	const idleCount = $derived(
		room.agents.filter((a) => a.status === "idle").length,
	);
	const errorCount = $derived(
		room.agents.filter((a) => a.status === "error").length,
	);
	const selected = $derived(
		room.selectedId
			? room.agents.find((a) => a.id === room.selectedId) ?? null
			: null,
	);

	let dialogOpen = $state(false);

	/* ── Keyboard navigation ─────────────────────────────── */
	let focusedIndex = $state(-1);

	const COLS = 4;
	const ROWS = 3;

	function handleKeydown(e: KeyboardEvent): void {
		// Ignore if typing in an input
		if (
			e.target instanceof HTMLInputElement ||
			e.target instanceof HTMLTextAreaElement
		) {
			return;
		}

		// Escape from zoom view
		if (e.key === "Escape") {
			if (room.selectedId) {
				e.preventDefault();
				selectAgent(null);
				return;
			}
			// Reset focus
			focusedIndex = -1;
			return;
		}

		// Number keys 1-9 to select monitor (grid mode only)
		if (!room.selectedId && e.key >= "1" && e.key <= "9") {
			const idx = parseInt(e.key) - 1;
			const slot = slots[idx];
			if (slot) {
				e.preventDefault();
				selectAgent(slot.id);
			}
			return;
		}

		// Arrow key navigation (grid mode only)
		if (!room.selectedId && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
			e.preventDefault();

			if (focusedIndex < 0) {
				focusedIndex = 0;
				return;
			}

			let row = Math.floor(focusedIndex / COLS);
			let col = focusedIndex % COLS;

			switch (e.key) {
				case "ArrowUp":    row = (row - 1 + ROWS) % ROWS; break;
				case "ArrowDown":  row = (row + 1) % ROWS; break;
				case "ArrowLeft":  col = (col - 1 + COLS) % COLS; break;
				case "ArrowRight": col = (col + 1) % COLS; break;
			}

			focusedIndex = row * COLS + col;
			return;
		}

		// Enter to select focused monitor
		if (!room.selectedId && e.key === "Enter" && focusedIndex >= 0) {
			const slot = slots[focusedIndex];
			if (slot) {
				e.preventDefault();
				selectAgent(slot.id);
			}
			return;
		}
	}

	/* ── Last scan timer ─────────────────────────────────── */
	let lastScanAgo = $state("0s");
	let scanTimer: ReturnType<typeof setInterval> | null = null;
	let lastScanTime = $state(Date.now());

	// Update lastScanTime when agents refresh
	$effect(() => {
		// Reading room.agents triggers re-run on agent data changes
		if (room.agents) {
			lastScanTime = Date.now();
		}
	});

	onMount(() => {
		scanTimer = setInterval(() => {
			const diff = Math.floor((Date.now() - lastScanTime) / 1000);
			lastScanAgo = `${diff}s`;
		}, 1000);
	});

	onDestroy(() => {
		if (scanTimer) clearInterval(scanTimer);
	});

	/* ── Room status derivation ──────────────────────────── */
	const roomStatus = $derived(
		errorCount > 0 ? "DEGRADED" : activeCount > 0 ? "OPERATIONAL" : "STANDBY"
	);

	/* ── Ambient glow intensity based on active agents ──── */
	const glowIntensity = $derived(Math.min(activeCount * 0.04, 0.3));
</script>

<AddAgentDialog open={dialogOpen} onclose={() => { dialogOpen = false; }} />

{#if selected}
	<ZoomView agent={selected} onback={() => selectAgent(null)} />
{:else}
	<div class="control-room" style="--glow-intensity: {glowIntensity};">
		<!-- Atmospheric overlays -->
		<div class="atmosphere-fog" aria-hidden="true"></div>
		<div class="atmosphere-ambient" aria-hidden="true"></div>
		<div class="atmosphere-desk-glow" aria-hidden="true"></div>

		<header class="room-header">
			<div class="room-title">
				<span class="title-text">Agent Control Room</span>
				<span class="agent-count">{room.agents.length} agents · {activeCount} active</span>
			</div>
		</header>

		<div class="grid-container">
			<div class="monitor-grid">
				{#each slots as slot, i (slot?.id ?? `empty-${i}`)}
					{#if slot}
						{@const sid = slot.source.type === "mcp" ? (slot.source as { type: "mcp"; serverId: string }).serverId : null}
						<div class="grid-cell">
							<G3Monitor
								agent={slot}
								selected={false}
								focused={focusedIndex === i}
								widgetHtml={sid ? widgetHtmlMap.get(sid) ?? null : null}
								widgetLoading={sid ? widgetLoadingSet.has(sid) : false}
								onclick={() => selectAgent(slot.id)}
							/>
						</div>
					{:else}
						<div class="grid-cell grid-cell--empty" class:grid-cell--nav-focused={focusedIndex === i}>
							<button class="empty-slot" aria-label="Add agent" onclick={() => { dialogOpen = true; }}>
								<Plus class="empty-icon" />
							</button>
						</div>
					{/if}
				{/each}
			</div>
		</div>

		<!-- Status bar -->
		<footer class="room-status-bar">
			<div class="status-bar-inner">
				<div class="status-group">
					<span class="sb-item sb-item--active">
						<span class="sb-dot sb-dot--active"></span>
						{activeCount} ACTIVE
					</span>
					<span class="sb-item sb-item--idle">
						<span class="sb-dot sb-dot--idle"></span>
						{idleCount} IDLE
					</span>
					<span class="sb-item sb-item--error">
						<span class="sb-dot sb-dot--error"></span>
						{errorCount} ERROR
					</span>
				</div>
				<span class="sb-sep">│</span>
				<span class="sb-item sb-label">
					ROOM STATUS: <span class="sb-value" class:sb-value--ok={roomStatus === "OPERATIONAL"} class:sb-value--warn={roomStatus === "DEGRADED"} class:sb-value--standby={roomStatus === "STANDBY"}>{roomStatus}</span>
				</span>
				<span class="sb-sep">│</span>
				<span class="sb-item sb-label">
					LAST SCAN: <span class="sb-value">{lastScanAgo} AGO</span>
				</span>
			</div>
		</footer>

		<!-- Floor grid reflection -->
		<div class="floor-grid" aria-hidden="true"></div>
	</div>
{/if}

<style>
	.control-room {
		position: relative;
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		background: #0a0a0c;
		overflow: hidden;

		/* Subtle noise texture */
		background-image:
			url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
		background-size: 256px 256px;
	}

	/* ── Atmospheric overlays ─────────────────────────────── */

	/* Top fog/haze */
	.atmosphere-fog {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 120px;
		background: linear-gradient(
			180deg,
			rgba(8, 8, 12, 0.7) 0%,
			rgba(8, 8, 12, 0.3) 40%,
			transparent 100%
		);
		pointer-events: none;
		z-index: 1;
	}

	/* Ambient glow that pulses with active agent count */
	.atmosphere-ambient {
		position: absolute;
		inset: 0;
		background: radial-gradient(
			ellipse 80% 60% at 50% 50%,
			rgba(0, 255, 65, var(--glow-intensity, 0.05)),
			transparent 70%
		);
		pointer-events: none;
		z-index: 0;
		animation: ambient-pulse 6s ease-in-out infinite;
	}

	@keyframes ambient-pulse {
		0%, 100% { opacity: 0.6; }
		50% { opacity: 1; }
	}

	/* Desk reflection glow at bottom center */
	.atmosphere-desk-glow {
		position: absolute;
		bottom: 0;
		left: 50%;
		transform: translateX(-50%);
		width: 70%;
		height: 100px;
		background: radial-gradient(
			ellipse 100% 100% at 50% 100%,
			rgba(100, 180, 255, 0.04) 0%,
			rgba(0, 255, 65, 0.02) 40%,
			transparent 80%
		);
		pointer-events: none;
		z-index: 0;
	}

	/* ── Header ───────────────────────────────────────────── */
	.room-header {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 12px 16px;
		flex-shrink: 0;
		z-index: 2;
		position: relative;
	}

	.room-title {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
	}

	.title-text {
		font-family: var(--font-mono), monospace;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: rgba(255, 255, 255, 0.5);
		text-shadow:
			0 0 10px rgba(0, 255, 65, 0.15),
			0 0 30px rgba(0, 255, 65, 0.05);
	}

	.agent-count {
		font-family: var(--font-mono), monospace;
		font-size: 9px;
		color: rgba(255, 255, 255, 0.25);
		letter-spacing: 0.06em;
	}

	/* ── Grid ─────────────────────────────────────────────── */
	.grid-container {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 8px 16px 12px;
		min-height: 0;
		z-index: 2;
		position: relative;
	}

	.monitor-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		grid-template-rows: repeat(3, 1fr);
		gap: 12px;
		width: 100%;
		max-width: 900px;
		height: 100%;
		max-height: 620px;
	}

	.grid-cell {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 0;
		min-height: 0;
	}

	.grid-cell--empty {
		opacity: 0.4;
		transition: opacity 0.2s ease;
	}

	.grid-cell--empty:hover {
		opacity: 0.7;
	}

	.grid-cell--nav-focused {
		opacity: 0.8;
	}

	.grid-cell--nav-focused .empty-slot {
		border-color: rgba(0, 255, 65, 0.3);
		background: rgba(0, 255, 65, 0.02);
	}

	.empty-slot {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		aspect-ratio: 4 / 3.2;
		border: 1px dashed rgba(255, 255, 255, 0.12);
		border-radius: 6px;
		background: transparent;
		cursor: pointer;
		transition: border-color 0.2s ease, background 0.2s ease;
		color: rgba(255, 255, 255, 0.2);
	}

	.empty-slot:hover {
		border-color: rgba(255, 255, 255, 0.25);
		background: rgba(255, 255, 255, 0.02);
		color: rgba(255, 255, 255, 0.4);
	}

	:global(.empty-icon) {
		width: 18px;
		height: 18px;
	}

	/* ── Status bar ───────────────────────────────────────── */
	.room-status-bar {
		flex-shrink: 0;
		border-top: 1px solid rgba(255, 255, 255, 0.06);
		padding: 5px 16px;
		z-index: 2;
		position: relative;
	}

	.status-bar-inner {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0;
		font-family: var(--font-mono), monospace;
		font-size: 9px;
		letter-spacing: 0.04em;
	}

	.status-group {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.sb-item {
		display: flex;
		align-items: center;
		gap: 4px;
		color: rgba(255, 255, 255, 0.35);
	}

	.sb-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.sb-dot--active {
		background: #22c55e;
		box-shadow: 0 0 4px rgba(34, 197, 94, 0.5);
	}

	.sb-dot--idle {
		background: #eab308;
		box-shadow: 0 0 4px rgba(234, 179, 8, 0.3);
	}

	.sb-dot--error {
		background: #ef4444;
		box-shadow: 0 0 4px rgba(239, 68, 68, 0.4);
	}

	.sb-sep {
		margin: 0 10px;
		color: rgba(255, 255, 255, 0.12);
		font-size: 10px;
	}

	.sb-label {
		color: rgba(255, 255, 255, 0.25);
	}

	.sb-value {
		color: rgba(255, 255, 255, 0.45);
		font-weight: 600;
	}

	.sb-value--ok {
		color: #22c55e;
	}

	.sb-value--warn {
		color: #ef4444;
	}

	.sb-value--standby {
		color: #eab308;
	}

	/* ── Floor grid lines ─────────────────────────────────── */
	.floor-grid {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		height: 60px;
		background:
			linear-gradient(to top, rgba(255, 255, 255, 0.015), transparent),
			repeating-linear-gradient(
				90deg,
				transparent,
				transparent 59px,
				rgba(255, 255, 255, 0.02) 59px,
				rgba(255, 255, 255, 0.02) 60px
			),
			repeating-linear-gradient(
				0deg,
				transparent,
				transparent 14px,
				rgba(255, 255, 255, 0.015) 14px,
				rgba(255, 255, 255, 0.015) 15px
			);
		pointer-events: none;
		mask-image: linear-gradient(to top, rgba(0, 0, 0, 0.6), transparent);
	}

	@media (prefers-reduced-motion: reduce) {
		.grid-cell--empty {
			transition: none;
		}
		.empty-slot {
			transition: none;
		}
		.atmosphere-ambient {
			animation: none;
		}
	}
</style>
