<script lang="ts">
	import type { Agent } from "$lib/stores/agents.svelte";
	import CRTEffect from "./CRTEffect.svelte";

	interface Props {
		agent: Agent;
		selected?: boolean;
		onclick?: () => void;
	}

	const { agent, selected = false, onclick }: Props = $props();

	const statusColor: Record<Agent["status"], string> = {
		active: "#22c55e",
		idle: "#eab308",
		error: "#ef4444",
		offline: "#6b7280",
	};
</script>

<button
	class="monitor"
	class:monitor--selected={selected}
	class:monitor--error={agent.status === "error"}
	class:monitor--idle={agent.status === "idle"}
	class:monitor--offline={agent.status === "offline"}
	data-color={agent.color}
	{onclick}
>
	<div class="monitor-bezel">
		<div class="monitor-screen">
			<CRTEffect flicker={agent.status === "active"} scanlines vignette />

			<div class="monitor-content">
				<div class="monitor-header">
					<span
						class="status-dot"
						style="background: {statusColor[agent.status]}; box-shadow: 0 0 6px {statusColor[agent.status]};"
					></span>
					<span class="monitor-name">{agent.name}</span>
				</div>

				<div class="monitor-role">{agent.role}</div>

				{#if agent.lastActivity}
					<div class="monitor-activity">{agent.lastActivity}</div>
				{/if}

				{#if agent.model}
					<div class="monitor-model">{agent.model}</div>
				{/if}
			</div>
		</div>
	</div>

	<div class="monitor-stand"></div>
</button>

<style>
	.monitor {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0;
		padding: 0;
		border: none;
		background: transparent;
		cursor: pointer;
		transition: transform 0.2s ease, filter 0.2s ease;
		width: 100%;
		aspect-ratio: 4 / 3.2;
	}

	.monitor:hover {
		transform: scale(1.03);
		z-index: 1;
	}

	.monitor--selected {
		transform: scale(1.05);
		z-index: 2;
	}

	.monitor--selected .monitor-bezel {
		box-shadow:
			0 0 20px rgba(255, 255, 255, 0.08),
			0 0 40px rgba(var(--glow-r, 100), var(--glow-g, 200), var(--glow-b, 255), 0.15),
			inset 0 1px 0 rgba(255, 255, 255, 0.1);
	}

	.monitor-bezel {
		position: relative;
		width: 100%;
		flex: 1;
		border-radius: 6px 6px 4px 4px;
		background: linear-gradient(145deg, #1a1a20, #111115);
		box-shadow:
			0 2px 8px rgba(0, 0, 0, 0.6),
			inset 0 1px 0 rgba(255, 255, 255, 0.06),
			inset 0 -1px 0 rgba(0, 0, 0, 0.8);
		padding: 6px;
		overflow: hidden;
	}

	.monitor-screen {
		position: relative;
		width: 100%;
		height: 100%;
		border-radius: 3px;
		background: #050508;
		overflow: hidden;
	}

	/* Color-coded ambient glow on active monitors */
	.monitor[data-color="bondi"] .monitor-screen { background: linear-gradient(170deg, #060d12, #050508 40%); }
	.monitor[data-color="tangerine"] .monitor-screen { background: linear-gradient(170deg, #120c06, #050508 40%); }
	.monitor[data-color="grape"] .monitor-screen { background: linear-gradient(170deg, #0c0612, #050508 40%); }
	.monitor[data-color="lime"] .monitor-screen { background: linear-gradient(170deg, #0a1206, #050508 40%); }
	.monitor[data-color="strawberry"] .monitor-screen { background: linear-gradient(170deg, #120608, #050508 40%); }
	.monitor[data-color="blueberry"] .monitor-screen { background: linear-gradient(170deg, #06081a, #050508 40%); }
	.monitor[data-color="sage"] .monitor-screen { background: linear-gradient(170deg, #0a120c, #050508 40%); }
	.monitor[data-color="ruby"] .monitor-screen { background: linear-gradient(170deg, #12060a, #050508 40%); }
	.monitor[data-color="indigo"] .monitor-screen { background: linear-gradient(170deg, #080612, #050508 40%); }

	.monitor--offline .monitor-screen {
		background: #050508;
		opacity: 0.5;
	}

	.monitor-content {
		position: relative;
		z-index: 4;
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px;
		height: 100%;
	}

	.monitor-header {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.status-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.monitor-name {
		font-family: var(--font-mono), monospace;
		font-size: 11px;
		font-weight: 600;
		color: rgba(255, 255, 255, 0.9);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.monitor-role {
		font-family: var(--font-mono), monospace;
		font-size: 9px;
		color: rgba(255, 255, 255, 0.4);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.monitor-activity {
		margin-top: auto;
		font-family: var(--font-mono), monospace;
		font-size: 9px;
		color: rgba(255, 255, 255, 0.5);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.monitor-model {
		font-family: var(--font-mono), monospace;
		font-size: 8px;
		color: rgba(255, 255, 255, 0.25);
		letter-spacing: 0.04em;
	}

	.monitor-stand {
		width: 40%;
		height: 6px;
		background: linear-gradient(180deg, #1a1a20, #111115);
		border-radius: 0 0 3px 3px;
		box-shadow:
			0 2px 4px rgba(0, 0, 0, 0.4),
			inset 0 1px 0 rgba(255, 255, 255, 0.04);
	}

	/* Error pulsing */
	.monitor--error .monitor-bezel {
		animation: error-pulse 2s ease-in-out infinite;
	}

	@keyframes error-pulse {
		0%, 100% { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.06); }
		50% { box-shadow: 0 2px 12px rgba(239, 68, 68, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.06); }
	}

	@media (prefers-reduced-motion: reduce) {
		.monitor {
			transition: none;
		}
		.monitor--error .monitor-bezel {
			animation: none;
		}
	}
</style>
