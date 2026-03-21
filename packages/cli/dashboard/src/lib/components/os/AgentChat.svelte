<script lang="ts">
	import { tick } from "svelte";
	import Send from "@lucide/svelte/icons/send";
	import Bot from "@lucide/svelte/icons/bot";
	import User from "@lucide/svelte/icons/user";
	import Wrench from "@lucide/svelte/icons/wrench";
	import { API_BASE } from "$lib/api";

	interface ChatMessage {
		role: "user" | "agent";
		content: string;
		timestamp: number;
		toolCalls?: Array<{ tool: string; server: string; result?: string }>;
	}

	let messages = $state<ChatMessage[]>([]);
	let input = $state("");
	let loading = $state(false);
	let chatEl: HTMLDivElement | null = $state(null);

	async function scrollToBottom() {
		await tick();
		if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
	}

	async function send() {
		const text = input.trim();
		if (!text || loading) return;

		messages.push({ role: "user", content: text, timestamp: Date.now() });
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
				role: "agent",
				content: data.response ?? data.error ?? "No response",
				timestamp: Date.now(),
				toolCalls: data.toolCalls,
			});
		} catch (err) {
			messages.push({
				role: "agent",
				content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
				timestamp: Date.now(),
			});
		} finally {
			loading = false;
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
</script>

<div class="agent-chat">
	<!-- Message history -->
	<div class="chat-messages" bind:this={chatEl}>
		{#if messages.length === 0}
			<div class="chat-empty">
				<Bot class="size-5 opacity-30" />
				<span class="sig-label" style="color: var(--sig-text-muted)">
					Ask your agent to query tools, filter data, or run actions across your MCP servers.
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
									{#if tc.result}
										<span class="chat-tool-result">{tc.result}</span>
									{/if}
								</div>
							{/each}
						</div>
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

	.chat-tool-result {
		opacity: 0.7;
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
