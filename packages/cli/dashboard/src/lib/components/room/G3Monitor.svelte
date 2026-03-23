<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import type { Agent } from "$lib/stores/agents.svelte";
	import CRTEffect from "./CRTEffect.svelte";

	interface Props {
		agent: Agent;
		selected?: boolean;
		focused?: boolean;
		widgetHtml?: string | null;
		widgetLoading?: boolean;
		onclick?: () => void;
	}

	const { agent, selected = false, focused = false, widgetHtml = null, widgetLoading = false, onclick }: Props = $props();

	const statusColor: Record<Agent["status"], string> = {
		active: "#22c55e",
		idle: "#eab308",
		error: "#ef4444",
		offline: "#6b7280",
	};

	const statusLabel: Record<Agent["status"], string> = {
		active: "ONLINE",
		idle: "IDLE",
		error: "ERROR",
		offline: "OFFLINE",
	};

	/* ── Typewriter effect for lastActivity ──────────────── */
	let displayedActivity = $state("");
	let cursorVisible = $state(true);
	let typeTimer: ReturnType<typeof setTimeout> | null = null;
	let cursorTimer: ReturnType<typeof setInterval> | null = null;
	let prevActivity = "";

	function typeText(text: string): void {
		if (typeTimer) clearTimeout(typeTimer);
		displayedActivity = "";
		let i = 0;
		function step(): void {
			if (i < text.length) {
				displayedActivity = text.slice(0, i + 1);
				i++;
				typeTimer = setTimeout(step, 18 + Math.random() * 30);
			}
		}
		step();
	}

	$effect(() => {
		const activity = agent.lastActivity ?? "";
		if (activity !== prevActivity) {
			prevActivity = activity;
			typeText(activity);
		}
	});

	onMount(() => {
		// initial type
		if (agent.lastActivity) {
			typeText(agent.lastActivity);
		}
		// cursor blink
		cursorTimer = setInterval(() => {
			cursorVisible = !cursorVisible;
		}, 530);
	});

	onDestroy(() => {
		if (typeTimer) clearTimeout(typeTimer);
		if (cursorTimer) clearInterval(cursorTimer);
	});

	/* ── Source-specific display info ─────────────────────── */
	const isMcp = $derived(agent.source.type === "mcp");
	const isProcess = $derived(agent.source.type === "process");
	const mcpServerId = $derived(isMcp ? (agent.source as { type: "mcp"; serverId: string }).serverId : null);
	const processInfo = $derived(isProcess ? (agent.source as { type: "process"; pid: number; name: string }) : null);
</script>

<button
	class="monitor"
	class:monitor--selected={selected}
	class:monitor--focused={focused}
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
				<!-- Top bar: name + status -->
				<div class="screen-topbar">
					<span class="monitor-name">{agent.name}</span>
					<span
						class="status-indicator"
						class:status-indicator--active={agent.status === "active"}
						class:status-indicator--error={agent.status === "error"}
						style="color: {statusColor[agent.status]};"
					>
						<span
							class="status-dot"
							class:status-dot--blink={agent.status === "active"}
							style="background: {statusColor[agent.status]}; box-shadow: 0 0 4px {statusColor[agent.status]};"
						></span>
						{statusLabel[agent.status]}
					</span>
				</div>

				<!-- Source-specific info -->
				<div class="screen-info">
					{#if isMcp && mcpServerId}
						<div class="info-line info-line--server">
							<span class="info-label">SRV</span>
							<span class="info-value info-value--green">{mcpServerId}</span>
						</div>
						{#if agent.toolCount != null}
							<div class="info-line">
								<span class="info-label">TOOLS</span>
								<span class="info-value info-value--cyan">{agent.toolCount}</span>
							</div>
						{/if}
					{:else if isProcess && processInfo}
						<div class="info-line">
							<span class="info-label">PROC</span>
							<span class="info-value info-value--green">{processInfo.name}</span>
						</div>
						<div class="info-line">
							<span class="info-label">PID</span>
							<span class="info-value info-value--cyan">{processInfo.pid}</span>
							{#if agent.status === "active"}
								<span class="running-badge">
									<span class="running-dot"></span>
									RUNNING
								</span>
							{/if}
						</div>
					{:else}
						<div class="info-line">
							<span class="info-label">TYPE</span>
							<span class="info-value">{agent.source.type}</span>
						</div>
					{/if}

					{#if agent.model}
						<div class="info-line">
							<span class="info-label">MDL</span>
							<span class="info-value info-value--dim">{agent.model}</span>
						</div>
					{/if}
				</div>

				<!-- Activity output area -->
				<div class="screen-output">
					<span class="prompt-char">›</span>
					<span class="output-text">{displayedActivity}</span>
					<span class="cursor-blink" class:cursor-blink--hidden={!cursorVisible}>▌</span>
				</div>
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

	.monitor--focused .monitor-bezel {
		box-shadow:
			0 0 0 1px rgba(0, 255, 65, 0.3),
			0 0 16px rgba(0, 255, 65, 0.08),
			0 2px 8px rgba(0, 0, 0, 0.6),
			inset 0 1px 0 rgba(255, 255, 255, 0.06);
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

	/* ── Screen content layout ────────────────────────────── */
	.monitor-content {
		position: relative;
		z-index: 4;
		display: flex;
		flex-direction: column;
		padding: 6px 7px;
		height: 100%;
		gap: 0;
	}

	/* ── Top bar ──────────────────────────────────────────── */
	.screen-topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 4px;
		padding-bottom: 3px;
		border-bottom: 1px solid rgba(0, 255, 65, 0.08);
		margin-bottom: 4px;
		flex-shrink: 0;
	}

	.monitor-name {
		font-family: var(--font-mono), monospace;
		font-size: 10px;
		font-weight: 700;
		color: rgba(255, 255, 255, 0.9);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.status-indicator {
		display: flex;
		align-items: center;
		gap: 3px;
		font-family: var(--font-mono), monospace;
		font-size: 7px;
		font-weight: 600;
		letter-spacing: 0.1em;
		flex-shrink: 0;
		text-transform: uppercase;
	}

	.status-dot {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.status-dot--blink {
		animation: dot-blink 1.5s ease-in-out infinite;
	}

	@keyframes dot-blink {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.3; }
	}

	/* ── Info lines ───────────────────────────────────────── */
	.screen-info {
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex-shrink: 0;
	}

	.info-line {
		display: flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono), monospace;
		font-size: 8px;
		line-height: 1.4;
	}

	.info-label {
		color: rgba(255, 255, 255, 0.25);
		font-weight: 600;
		letter-spacing: 0.06em;
		flex-shrink: 0;
	}

	.info-value {
		color: rgba(255, 255, 255, 0.55);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.info-value--green {
		color: #00ff41;
		text-shadow: 0 0 6px rgba(0, 255, 65, 0.3);
	}

	.info-value--cyan {
		color: #00e5ff;
		text-shadow: 0 0 6px rgba(0, 229, 255, 0.2);
	}

	.info-value--dim {
		color: rgba(255, 255, 255, 0.3);
		font-size: 7px;
	}

	/* ── Running badge ────────────────────────────────────── */
	.running-badge {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		margin-left: auto;
		font-family: var(--font-mono), monospace;
		font-size: 7px;
		font-weight: 600;
		color: #22c55e;
		letter-spacing: 0.08em;
	}

	.running-dot {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: #22c55e;
		animation: running-pulse 1s ease-in-out infinite;
	}

	@keyframes running-pulse {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.4; transform: scale(0.7); }
	}

	/* ── Output area (bottom, acts as terminal output) ──── */
	.screen-output {
		margin-top: auto;
		display: flex;
		align-items: baseline;
		gap: 3px;
		padding-top: 3px;
		border-top: 1px solid rgba(0, 255, 65, 0.05);
		overflow: hidden;
		flex-shrink: 0;
		min-height: 14px;
	}

	.prompt-char {
		font-family: var(--font-mono), monospace;
		font-size: 9px;
		color: rgba(0, 255, 65, 0.5);
		flex-shrink: 0;
		line-height: 1;
	}

	.output-text {
		font-family: var(--font-mono), monospace;
		font-size: 8px;
		color: rgba(0, 255, 65, 0.7);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		text-shadow: 0 0 8px rgba(0, 255, 65, 0.15);
	}

	.cursor-blink {
		font-family: var(--font-mono), monospace;
		font-size: 9px;
		color: rgba(0, 255, 65, 0.6);
		flex-shrink: 0;
		line-height: 1;
		transition: opacity 0.08s ease;
	}

	.cursor-blink--hidden {
		opacity: 0;
	}

	/* ── Stand ────────────────────────────────────────────── */
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
		.status-dot--blink {
			animation: none;
		}
		.running-dot {
			animation: none;
		}
	}
</style>
