<script lang="ts">
	import { tick } from "svelte";
	import Send from "@lucide/svelte/icons/send";
	import Bot from "@lucide/svelte/icons/bot";
	import User from "@lucide/svelte/icons/user";
	import Wrench from "@lucide/svelte/icons/wrench";
	import ExternalLink from "@lucide/svelte/icons/external-link";
	import { API_BASE } from "$lib/api";
	import { os, moveToGrid, fetchWidgetHtml, fetchTrayEntries } from "$lib/stores/os.svelte";

	interface ToolCall {
		tool: string;
		server: string;
		result?: unknown;
		error?: string;
	}

	interface ChatMessage {
		role: "user" | "agent";
		content: string;
		timestamp: number;
		toolCalls?: ToolCall[];
		openedWidget?: string;  // server ID of widget that was opened
	}

	let messages = $state<ChatMessage[]>([]);
	let input = $state("");
	let loading = $state(false);
	let loadingStatus = $state("");
	let chatEl: HTMLDivElement | null = $state(null);

	async function scrollToBottom() {
		await tick();
		if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
	}

	/**
	 * Place a widget on the grid and load its HTML.
	 * Returns true if the widget was placed/already on grid.
	 */
	async function openWidgetForServer(serverId: string): Promise<boolean> {
		const entry = os.entries.find((e) => e.id === serverId);
		if (!entry) {
			// Refresh tray entries in case the server was just installed
			await fetchTrayEntries();
			const refreshed = os.entries.find((e) => e.id === serverId);
			if (!refreshed) return false;
		}

		const target = os.entries.find((e) => e.id === serverId);
		if (!target) return false;

		// Move to grid if not already there
		if (target.state !== "grid") {
			await moveToGrid(serverId);
		}

		// Ensure widget HTML is loaded
		await fetchWidgetHtml(serverId);

		// Highlight the widget briefly
		highlightWidget(serverId);

		return true;
	}

	/** Flash a highlight border on a widget to draw attention */
	function highlightWidget(serverId: string): void {
		const gridItems = document.querySelectorAll('.grid-item');
		for (const item of gridItems) {
			const card = item.querySelector('.widget-card');
			if (!card) continue;
			// Check if this grid item contains the target widget
			const titleEl = item.querySelector('.widget-title');
			const entry = os.entries.find((e) => e.id === serverId);
			if (titleEl && entry && titleEl.textContent?.toLowerCase().includes(entry.name.toLowerCase())) {
				item.classList.add('widget-chat-highlight');
				item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
				setTimeout(() => item.classList.remove('widget-chat-highlight'), 2000);
				break;
			}
		}
	}

	async function send() {
		const text = input.trim();
		if (!text || loading) return;

		messages.push({ role: "user", content: text, timestamp: Date.now() });
		input = "";
		loading = true;
		loadingStatus = "thinking...";
		scrollToBottom();

		try {
			const res = await fetch(`${API_BASE}/api/os/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: text }),
			});
			const data = await res.json();
			const toolCalls: ToolCall[] = data.toolCalls ?? [];

			// If tools were called, open the related widget(s)
			let openedWidget: string | undefined;
			if (toolCalls.length > 0) {
				const serverIds = [...new Set(toolCalls.map((tc) => tc.server))];
				for (const sid of serverIds) {
					loadingStatus = `opening ${sid.replace('ghl-', '')}...`;
					const opened = await openWidgetForServer(sid);
					if (opened) openedWidget = sid;
				}
			}

			messages.push({
				role: "agent",
				content: data.response ?? data.error ?? "No response",
				timestamp: Date.now(),
				toolCalls,
				openedWidget,
			});
		} catch (err) {
			messages.push({
				role: "agent",
				content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
				timestamp: Date.now(),
			});
		} finally {
			loading = false;
			loadingStatus = "";
			scrollToBottom();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	function formatTime(ts: number): string {
		return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	function getWidgetName(serverId: string): string {
		const entry = os.entries.find((e) => e.id === serverId);
		return entry?.name ?? serverId;
	}

	function scrollToWidget(serverId: string): void {
		highlightWidget(serverId);
	}
</script>

<div class="agent-chat">
	<!-- Message history -->
	<div class="chat-messages" bind:this={chatEl}>
		{#if messages.length === 0}
			<div class="chat-empty">
				<Bot class="size-5 opacity-30" />
				<span class="sig-label" style="color: var(--sig-text-muted)">
					Ask me anything — I'll pull up the right app and show you the data live.
				</span>
			</div>
		{/if}

		{#each messages as msg (msg.timestamp)}
			<div class="chat-msg chat-msg--{msg.role}">
				<div class="chat-msg-icon">
					{#if msg.role === "user"}
						<User class="size-3" />
					{:else}
						<Bot class="size-3" />
					{/if}
				</div>
				<div class="chat-msg-body">
					<div class="chat-msg-content">{msg.content}</div>
					{#if msg.toolCalls && msg.toolCalls.length > 0}
						<div class="chat-tool-calls">
							{#each msg.toolCalls as tc}
								<div class="chat-tool-call">
									<Wrench class="size-2.5" />
									<span class="chat-tool-name">{tc.server}/{tc.tool}</span>
									{#if tc.error}
										<span class="chat-tool-error">failed</span>
									{:else}
										<span class="chat-tool-ok">done</span>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
					{#if msg.openedWidget}
						<button
							class="chat-widget-link"
							onclick={() => scrollToWidget(msg.openedWidget!)}
						>
							<ExternalLink class="size-2.5" />
							<span>Showing in {getWidgetName(msg.openedWidget)}</span>
						</button>
					{/if}
					<span class="chat-msg-time">{formatTime(msg.timestamp)}</span>
				</div>
			</div>
		{/each}

		{#if loading}
			<div class="chat-msg chat-msg--agent">
				<div class="chat-msg-icon">
					<Bot class="size-3" />
				</div>
				<div class="chat-msg-body">
					<div class="chat-thinking">
						<span class="dot"></span>
						<span class="dot"></span>
						<span class="dot"></span>
						<span class="chat-status-text">{loadingStatus}</span>
					</div>
				</div>
			</div>
		{/if}
	</div>

	<!-- Input bar -->
	<div class="chat-input-bar">
		<input
			type="text"
			class="chat-input"
			placeholder="Ask your agent..."
			bind:value={input}
			onkeydown={handleKeydown}
			disabled={loading}
		/>
		<button
			class="chat-send-btn"
			title="Send message"
			onclick={send}
			disabled={loading || !input.trim()}
		>
			<Send class="size-3.5" />
		</button>
	</div>
</div>

<style>
	.agent-chat {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--sig-border);
		background: var(--sig-bg);
		max-height: 280px;
		min-height: 120px;
	}

	.chat-messages {
		flex: 1;
		overflow-y: auto;
		padding: var(--space-sm) var(--space-md);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.chat-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: var(--space-lg) var(--space-md);
		text-align: center;
		opacity: 0.7;
	}

	.chat-msg {
		display: flex;
		gap: 8px;
		max-width: 85%;
		animation: chatFadeIn 0.15s ease-out;
	}

	.chat-msg--user {
		align-self: flex-end;
		flex-direction: row-reverse;
	}

	.chat-msg--agent {
		align-self: flex-start;
	}

	.chat-msg-icon {
		display: flex;
		align-items: flex-start;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: var(--sig-surface);
		border: 1px solid var(--sig-border);
		color: var(--sig-text-muted);
		flex-shrink: 0;
		padding-top: 4px;
	}

	.chat-msg--user .chat-msg-icon {
		background: color-mix(in srgb, var(--sig-accent) 15%, var(--sig-surface));
		border-color: color-mix(in srgb, var(--sig-accent) 30%, var(--sig-border));
		color: var(--sig-accent);
	}

	.chat-msg-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.chat-msg-content {
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 1.5;
		color: var(--sig-text);
		background: var(--sig-surface);
		border: 1px solid var(--sig-border);
		border-radius: 8px;
		padding: 6px 10px;
		word-break: break-word;
	}

	.chat-msg--user .chat-msg-content {
		background: color-mix(in srgb, var(--sig-accent) 8%, var(--sig-surface));
		border-color: color-mix(in srgb, var(--sig-accent) 20%, var(--sig-border));
	}

	.chat-msg-time {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		padding: 0 4px;
		opacity: 0.6;
	}

	.chat-msg--user .chat-msg-time {
		text-align: right;
	}

	.chat-tool-calls {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-top: 2px;
	}

	.chat-tool-call {
		display: flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		padding: 2px 6px;
		background: color-mix(in srgb, var(--sig-accent) 5%, var(--sig-bg));
		border-radius: 4px;
		border: 1px solid var(--sig-border);
	}

	.chat-tool-name {
		font-weight: 600;
		color: var(--sig-accent);
	}

	.chat-tool-ok {
		color: var(--sig-success, #5a7a5a);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.chat-tool-error {
		color: var(--sig-danger, #7a4a4a);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.chat-widget-link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-accent);
		padding: 2px 8px;
		background: color-mix(in srgb, var(--sig-accent) 8%, var(--sig-bg));
		border: 1px solid color-mix(in srgb, var(--sig-accent) 25%, var(--sig-border));
		border-radius: 4px;
		cursor: pointer;
		margin-top: 2px;
		transition: all 0.15s ease;
	}

	.chat-widget-link:hover {
		background: color-mix(in srgb, var(--sig-accent) 15%, var(--sig-bg));
		border-color: var(--sig-accent);
	}

	/* Thinking dots */
	.chat-thinking {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px 10px;
		background: var(--sig-surface);
		border: 1px solid var(--sig-border);
		border-radius: 8px;
	}

	.chat-status-text {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		margin-left: 4px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--sig-text-muted);
		animation: dotPulse 1.2s ease-in-out infinite;
	}

	.dot:nth-child(2) {
		animation-delay: 0.2s;
	}

	.dot:nth-child(3) {
		animation-delay: 0.4s;
	}

	@keyframes dotPulse {
		0%, 60%, 100% {
			opacity: 0.2;
			transform: scale(0.8);
		}
		30% {
			opacity: 1;
			transform: scale(1);
		}
	}

	@keyframes chatFadeIn {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	/* Input bar */
	.chat-input-bar {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px var(--space-md);
		border-top: 1px solid var(--sig-border);
		background: var(--sig-surface);
		flex-shrink: 0;
	}

	.chat-input {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--sig-text);
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		border-radius: 6px;
		padding: 6px 10px;
		outline: none;
		transition: border-color var(--dur) var(--ease);
	}

	.chat-input::placeholder {
		color: var(--sig-text-muted);
		opacity: 0.6;
	}

	.chat-input:focus {
		border-color: var(--sig-accent);
	}

	.chat-input:disabled {
		opacity: 0.5;
	}

	.chat-send-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		padding: 0;
		border: 1px solid var(--sig-border);
		border-radius: 6px;
		background: var(--sig-surface);
		color: var(--sig-text-muted);
		cursor: pointer;
		transition: all var(--dur) var(--ease);
		flex-shrink: 0;
	}

	.chat-send-btn:hover:not(:disabled) {
		border-color: var(--sig-accent);
		color: var(--sig-accent);
		background: color-mix(in srgb, var(--sig-accent) 8%, var(--sig-surface));
	}

	.chat-send-btn:disabled {
		opacity: 0.3;
		cursor: default;
	}
</style>
