<script lang="ts">
	import { tick } from "svelte";
	import type { Agent } from "$lib/stores/agents.svelte";
	import { API_BASE } from "$lib/api";
	import { sendWidgetAction } from "$lib/stores/os.svelte";
	import ArrowLeft from "@lucide/svelte/icons/arrow-left";
	import Send from "@lucide/svelte/icons/send";
	import Wrench from "@lucide/svelte/icons/wrench";
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

	/* ── Chat state ─────────────────────────────────────── */

	interface ToolCall {
		tool: string;
		server: string;
		result?: unknown;
		error?: string;
	}

	interface ChatMessage {
		id: number;
		role: "user" | "agent";
		content: string;
		ts: number;
		toolCalls?: ToolCall[];
	}

	let messages = $state<ChatMessage[]>([]);
	let input = $state("");
	let loading = $state(false);
	let msgId = 0;
	let chatEl: HTMLDivElement | null = $state(null);

	async function scrollToBottom(): Promise<void> {
		await tick();
		if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
	}

	async function send(): Promise<void> {
		const text = input.trim();
		if (!text || loading) return;

		messages.push({ id: ++msgId, role: "user", content: text, ts: Date.now() });
		input = "";
		loading = true;
		scrollToBottom();

		try {
			const res = await fetch(`${API_BASE}/api/os/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: text }),
			});
			const data = await res.json();
			messages.push({
				id: ++msgId,
				role: "agent",
				content: data.response ?? "No response",
				ts: Date.now(),
				toolCalls: data.toolCalls,
			});

			// Play cursor automation in widget — cursor drives the UI for mutations
			if (agent.source.type === "mcp" && data.cursorSteps && data.cursorSteps.length > 0) {
				sendWidgetAction(agent.source.serverId, "cursor", { steps: data.cursorSteps });
			}
		} catch (err) {
			messages.push({
				id: ++msgId,
				role: "agent",
				content: `Error: ${err instanceof Error ? err.message : String(err)}`,
				ts: Date.now(),
			});
		} finally {
			loading = false;
			scrollToBottom();
		}
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	function formatTime(ts: number): string {
		return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
			<div class="chat-messages" bind:this={chatEl}>
				{#if messages.length === 0 && !loading}
					<div class="chat-empty">
						<span class="empty-text">Message {agent.name}...</span>
					</div>
				{/if}

				{#each messages as msg (msg.id)}
					<div class="chat-msg chat-msg--{msg.role}">
						<div class="chat-bubble chat-bubble--{msg.role}">
							<span class="chat-text">{msg.content}</span>
							{#if msg.toolCalls && msg.toolCalls.length > 0}
								<div class="chat-tools">
									{#each msg.toolCalls as tc}
										<span class="tool-badge">
											<Wrench class="tool-icon" />
											<span class="tool-name">{tc.server}/{tc.tool}</span>
											{#if tc.error}
												<span class="tool-status tool-status--fail">failed</span>
											{:else}
												<span class="tool-status tool-status--ok">done</span>
											{/if}
										</span>
									{/each}
								</div>
							{/if}
						</div>
						<span class="chat-ts">{formatTime(msg.ts)}</span>
					</div>
				{/each}

				{#if loading}
					<div class="chat-msg chat-msg--agent">
						<div class="chat-bubble chat-bubble--agent">
							<span class="thinking-dots">
								<span class="tdot"></span>
								<span class="tdot"></span>
								<span class="tdot"></span>
							</span>
						</div>
					</div>
				{/if}
			</div>
			<div class="chat-input-bar">
				<input
					type="text"
					class="chat-input"
					placeholder="Message {agent.name}..."
					bind:value={input}
					onkeydown={handleKeydown}
					disabled={loading}
				/>
				<button
					class="send-btn"
					aria-label="Send message"
					onclick={send}
					disabled={loading || !input.trim()}
				>
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
		grid-template-rows: 1fr;
		min-height: 0;
		z-index: 5;
		overflow: hidden;
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
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		scroll-behavior: smooth;
	}

	.chat-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		text-align: center;
	}

	.empty-text {
		font-family: var(--font-mono, monospace);
		font-size: 11px;
		color: rgba(255, 255, 255, 0.25);
		letter-spacing: 0.04em;
	}

	/* ── Chat messages ────────────────────────────────────── */
	.chat-msg {
		display: flex;
		flex-direction: column;
		max-width: 85%;
		animation: msg-in 0.15s ease-out;
	}

	.chat-msg--user {
		align-self: flex-end;
	}

	.chat-msg--agent {
		align-self: flex-start;
	}

	.chat-bubble {
		font-family: var(--font-mono, monospace);
		font-size: 12px;
		line-height: 1.5;
		padding: 6px 10px;
		border-radius: 6px;
		word-break: break-word;
	}

	.chat-bubble--user {
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.12);
		color: rgba(255, 255, 255, 0.85);
	}

	.chat-bubble--agent {
		background: rgba(0, 255, 65, 0.06);
		border: 1px solid rgba(0, 255, 65, 0.15);
		color: #00ff41;
	}

	.chat-text {
		white-space: pre-wrap;
	}

	.chat-ts {
		font-family: var(--font-mono, monospace);
		font-size: 9px;
		color: rgba(255, 255, 255, 0.2);
		padding: 2px 4px 0;
	}

	.chat-msg--user .chat-ts {
		text-align: right;
	}

	/* ── Tool call badges ─────────────────────────────────── */
	.chat-tools {
		display: flex;
		flex-direction: column;
		gap: 3px;
		margin-top: 6px;
	}

	.tool-badge {
		display: flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		padding: 2px 6px;
		background: rgba(0, 255, 65, 0.04);
		border: 1px solid rgba(0, 255, 65, 0.1);
		border-radius: 3px;
		color: rgba(255, 255, 255, 0.5);
	}

	:global(.tool-icon) {
		width: 10px;
		height: 10px;
		flex-shrink: 0;
	}

	.tool-name {
		font-weight: 600;
		color: #00ff41;
	}

	.tool-status {
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.tool-status--ok {
		color: #22c55e;
	}

	.tool-status--fail {
		color: #ef4444;
	}

	/* ── Thinking dots ────────────────────────────────────── */
	.thinking-dots {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.tdot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: #00ff41;
		animation: dot-pulse 1.2s ease-in-out infinite;
	}

	.tdot:nth-child(2) { animation-delay: 0.2s; }
	.tdot:nth-child(3) { animation-delay: 0.4s; }

	@keyframes dot-pulse {
		0%, 60%, 100% { opacity: 0.2; transform: scale(0.8); }
		30% { opacity: 1; transform: scale(1); }
	}

	@keyframes msg-in {
		from { opacity: 0; transform: translateY(4px); }
		to { opacity: 1; transform: translateY(0); }
	}

	/* ── Input bar ────────────────────────────────────────── */
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
		transition: border-color 0.15s ease;
	}

	.chat-input:focus {
		border-color: rgba(0, 255, 65, 0.4);
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
		cursor: pointer;
		flex-shrink: 0;
		transition: all 0.15s ease;
	}

	.send-btn:hover:not(:disabled) {
		border-color: rgba(0, 255, 65, 0.4);
		color: #00ff41;
		background: rgba(0, 255, 65, 0.06);
	}

	.send-btn:disabled {
		opacity: 0.3;
		cursor: default;
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
		overflow: auto;
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
