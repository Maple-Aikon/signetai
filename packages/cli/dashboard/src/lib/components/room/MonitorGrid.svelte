<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import {
		room,
		startPolling,
		stopPolling,
		selectAgent,
		getGridSlots,
	} from "$lib/stores/agents.svelte";
	import G3Monitor from "./G3Monitor.svelte";
	import ZoomView from "./ZoomView.svelte";
	import Plus from "@lucide/svelte/icons/plus";

	onMount(() => {
		startPolling();
	});

	onDestroy(() => {
		stopPolling();
	});

	const slots = $derived(getGridSlots());
	const activeCount = $derived(
		room.agents.filter((a) => a.status === "active").length,
	);
	const selected = $derived(
		room.selectedId
			? room.agents.find((a) => a.id === room.selectedId) ?? null
			: null,
	);
</script>

{#if selected}
	<ZoomView agent={selected} onback={() => selectAgent(null)} />
{:else}
	<div class="control-room">
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
						<div class="grid-cell">
							<G3Monitor
								agent={slot}
								selected={false}
								onclick={() => selectAgent(slot.id)}
							/>
						</div>
					{:else}
						<div class="grid-cell grid-cell--empty">
							<button class="empty-slot" aria-label="Add agent">
								<Plus class="empty-icon" />
							</button>
						</div>
					{/if}
				{/each}
			</div>
		</div>

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

	.room-header {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 12px 16px;
		flex-shrink: 0;
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
	}

	.agent-count {
		font-family: var(--font-mono), monospace;
		font-size: 9px;
		color: rgba(255, 255, 255, 0.25);
		letter-spacing: 0.06em;
	}

	.grid-container {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 8px 16px 32px;
		min-height: 0;
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

	/* Floor grid lines */
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
	}
</style>
