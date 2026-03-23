<script lang="ts">
	import type { Agent } from "$lib/stores/agents.svelte";
	import ArrowLeft from "@lucide/svelte/icons/arrow-left";
	import Send from "@lucide/svelte/icons/send";
	import CRTEffect from "./CRTEffect.svelte";
	import ActivityPanel from "./ActivityPanel.svelte";

	interface Props {
		agent: Agent;
		onback: () => void;
	}

	const { agent, onback }: Props = $props();

	const statusColor: Record<Agent["status"], string> = {
		active: "#22c55e",
		idle: "#eab308",
		error: "#ef4444",
		offline: "#6b7280",
	};

	const g3Colors: Record<string, string> = {
		bondi: "#00bcd4",
		tangerine: "#ff9800",
		grape: "#9c27b0",
		lime: "#8bc34a",
		strawberry: "#e91e63",
		blueberry: "#3f51b5",
		sage: "#78a67a",
		ruby: "#d32f2f",
		indigo: "#5c6bc0",
		snow: "#e0e0e0",
		graphite: "#616161",
		flower: "#ba68c8",
	};

	const dot = $derived(g3Colors[agent.color] ?? "#888");

	function sourceLabel(src: Agent["source"]): string {
		switch (src.type) {
			case "clawdbot":
				return "clawdbot";
			case "process":
				return "process";
			case "mcp":
				return "mcp";
			case "manual":
				return "manual";
		}
	}
</script>

<div class="zoom" data-color={agent.color}>
	<CRTEffect flicker={false} scanlines vignette />

	<!-- Header -->
	<header class="zoom-header">
		<button class="back-btn" onclick={onback} aria-label="Back to grid">
			<ArrowLeft class="back-icon" />
			<span class="back-label">GRID</span>
		</button>

		<div class="header-center">
			<span class="agent-dot" style="background: {dot}; box-shadow: 0 0 8px {dot};"></span>
			<span class="agent-name">{agent.name}</span>
		</div>

		<div class="header-right">
			<span
				class="status-badge"
				style="color: {statusColor[agent.status]}; border-color: {statusColor[agent.status]}40;"
			>
				<span class="status-pip" style="background: {statusColor[agent.status]};"></span>
				{agent.status}
			</span>
		</div>
	</header>

	<!-- Split pane -->
	<div class="split">
		<!-- Chat panel -->
		<section class="chat-panel">
			<div class="chat-messages">
				<div class="chat-empty">
					<span class="empty-text">
						Chat with {agent.name} — coming in Phase 3
					</span>
				</div>
			</div>
			<div class="chat-input-bar">
				<input
					type="text"
					class="chat-input"
					placeholder="Message {agent.name}..."
					disabled
				/>
				<button class="send-btn" disabled aria-label="Send message">
					<Send class="send-icon" />
				</button>
			</div>
		</section>

		<!-- Activity panel -->
		<section class="activity-panel">
			<ActivityPanel {agent} />
		</section>
	</div>

	<!-- Bottom status bar -->
	<footer class="status-bar">
		<div class="stat">
			<span class="stat-pip" style="background: {statusColor[agent.status]};"></span>
			<span class="stat-val">{agent.status}</span>
		</div>
		<div class="stat-sep"></div>
		<div class="stat">
			<span class="stat-lbl">Model</span>
			<span class="stat-val">{agent.model ?? "—"}</span>
		</div>
		<div class="stat-sep"></div>
		<div class="stat">
			<span class="stat-lbl">Source</span>
			<span class="stat-val">{sourceLabel(agent.source)}</span>
		</div>
		<div class="stat-sep"></div>
		<div class="stat">
			<span class="stat-lbl">Role</span>
			<span class="stat-val">{agent.role}</span>
		</div>
	</footer>
</div>

<style>
	/* ── CRT turn-on animation ────────────────────────────── */
	@keyframes crt-on {
		0% {
			clip-path: inset(49.5% 0 49.5% 0);
			opacity: 0;
			filter: brightness(3);
		}
		40% {
			clip-path: inset(0 0 0 0);
			opacity: 1;
			filter: brightness(1.5);
		}
		100% {
			clip-path: inset(0 0 0 0);
			opacity: 1;
			filter: brightness(1);
		}
	}

	.zoom {
		position: relative;
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		background: #0a0a0c;
		color: rgba(255, 255, 255, 0.85);
		animation: crt-on 0.5s ease-out both;
		overflow: hidden;
	}

	/* ── Header ───────────────────────────────────────────── */
	.zoom-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 16px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
		flex-shrink: 0;
		z-index: 5;
	}

	.back-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.04);
		color: rgba(255, 255, 255, 0.6);
		cursor: pointer;
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		transition: all 0.15s ease;
	}

	.back-btn:hover {
		border-color: rgba(255, 255, 255, 0.3);
		color: rgba(255, 255, 255, 0.9);
		background: rgba(255, 255, 255, 0.08);
	}

	:global(.back-icon) {
		width: 14px;
		height: 14px;
	}

	.back-label {
		line-height: 1;
	}

	.header-center {
		display: flex;
		align-items: center;
		gap: 8px;
		position: absolute;
		left: 50%;
		transform: translateX(-50%);
	}

	.agent-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.agent-name {
		font-family: var(--font-mono, monospace);
		font-size: 13px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: rgba(255, 255, 255, 0.9);
	}

	.header-right {
		display: flex;
		align-items: center;
	}

	.status-badge {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 10px;
		border: 1px solid;
		border-radius: 10px;
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.status-pip {
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}

	/* ── Split pane ───────────────────────────────────────── */
	.split {
		flex: 1;
		display: grid;
		grid-template-columns: 1fr 1fr;
		min-height: 0;
		z-index: 5;
	}

	/* ── Chat panel ───────────────────────────────────────── */
	.chat-panel {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-right: 1px solid rgba(255, 255, 255, 0.08);
	}

	.chat-messages {
		flex: 1;
		overflow-y: auto;
		padding: 16px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.chat-empty {
		text-align: center;
	}

	.empty-text {
		font-family: var(--font-mono, monospace);
		font-size: 11px;
		color: rgba(255, 255, 255, 0.25);
		letter-spacing: 0.04em;
	}

	.chat-input-bar {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 12px;
		border-top: 1px solid rgba(255, 255, 255, 0.08);
		flex-shrink: 0;
	}

	.chat-input {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: 12px;
		color: rgba(255, 255, 255, 0.85);
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 6px;
		padding: 6px 10px;
		outline: none;
	}

	.chat-input::placeholder {
		color: rgba(255, 255, 255, 0.25);
	}

	.chat-input:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.send-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.04);
		color: rgba(255, 255, 255, 0.3);
		cursor: default;
		flex-shrink: 0;
	}

	.send-btn:disabled {
		opacity: 0.3;
	}

	:global(.send-icon) {
		width: 14px;
		height: 14px;
	}

	/* ── Activity panel ───────────────────────────────────── */
	.activity-panel {
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: #0c0c0c;
	}

	/* ── Status bar ───────────────────────────────────────── */
	.status-bar {
		display: flex;
		align-items: center;
		gap: 0;
		padding: 6px 16px;
		border-top: 1px solid rgba(255, 255, 255, 0.08);
		flex-shrink: 0;
		z-index: 5;
	}

	.stat {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.stat-pip {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.stat-lbl {
		font-family: var(--font-mono, monospace);
		font-size: 9px;
		color: rgba(255, 255, 255, 0.3);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.stat-val {
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		color: rgba(255, 255, 255, 0.6);
	}

	.stat-sep {
		width: 1px;
		height: 12px;
		background: rgba(255, 255, 255, 0.1);
		margin: 0 14px;
	}

	@media (prefers-reduced-motion: reduce) {
		.zoom {
			animation: none;
		}
	}
</style>
