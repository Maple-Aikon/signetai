<script lang="ts">
	import { onMount } from "svelte";
	import type { Agent } from "$lib/stores/agents.svelte";
	import WidgetSandbox from "$lib/components/os/WidgetSandbox.svelte";

	interface Props {
		agent: Agent;
	}

	const { agent }: Props = $props();

	type TabId = "terminal" | "tools" | "browser";

	const isMcp = $derived(agent.source.type === "mcp");
	let active = $state<TabId>("browser");

	// Default to browser for MCP, terminal for others
	$effect(() => {
		if (!isMcp && active === "browser") {
			active = "terminal";
		}
	});

	const tabs = $derived<{ id: TabId; label: string; enabled: boolean }[]>([
		{ id: "browser", label: "BROWSER", enabled: isMcp },
		{ id: "terminal", label: "TERMINAL", enabled: true },
		{ id: "tools", label: "TOOLS", enabled: false },
	]);

	let widgetHtml = $state<string | null>(null);
	let widgetError = $state(false);

	onMount(async () => {
		if (agent.source.type !== "mcp") return;
		const sid = agent.source.serverId;
		try {
			const base = typeof window !== "undefined" ? window.location.origin : "";
			const url = `${base}/api/os/widget/${encodeURIComponent(sid)}`;
			console.log("[ActivityPanel] fetching widget:", url);
			const res = await fetch(url);
			console.log("[ActivityPanel] fetch status:", res.status);
			if (!res.ok) { widgetError = true; return; }
			const raw = await res.text();
			console.log("[ActivityPanel] response size:", raw.length);
			const data = JSON.parse(raw);
			if (data && typeof data.html === "string" && data.html.length > 0) {
				console.log("[ActivityPanel] widget HTML loaded:", data.html.length, "chars");
				widgetHtml = data.html;
			} else {
				console.log("[ActivityPanel] no html in response:", Object.keys(data));
				widgetError = true;
			}
		} catch (err) {
			console.error("[ActivityPanel] widget fetch error:", err);
			widgetError = true;
		}
	});

	function formatTime(date: Date): string {
		return date.toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
	}

	function sourceLabel(src: Agent["source"]): string {
		switch (src.type) {
			case "clawdbot":
				return `clawdbot session ${src.sessionKey}`;
			case "process":
				return `process ${src.name} (PID ${src.pid})`;
			case "mcp":
				return `MCP server ${src.serverId}`;
			case "manual":
				return src.label;
		}
	}

	const now = new Date();

	const lines = $derived.by(() => {
		const entries: { time: string; label: string; value: string }[] = [];
		const ts = formatTime(now);

		entries.push({ time: ts, label: "", value: "Agent started" });
		entries.push({ time: ts, label: "Source", value: sourceLabel(agent.source) });

		if (agent.model) {
			entries.push({ time: ts, label: "Model", value: agent.model });
		}

		entries.push({ time: ts, label: "Status", value: agent.status });

		if (agent.lastActivity) {
			const laterTs = formatTime(new Date(now.getTime() + 5000));
			entries.push({
				time: laterTs,
				label: "Last activity",
				value: agent.lastActivity,
			});
		}

		return entries;
	});
</script>

<div class="activity">
	<div class="tab-bar">
		{#each tabs as tab (tab.id)}
			<button
				class="tab"
				class:tab--active={active === tab.id}
				class:tab--disabled={!tab.enabled}
				disabled={!tab.enabled}
				onclick={() => { if (tab.enabled) active = tab.id; }}
			>
				{tab.label}
			</button>
		{/each}
	</div>

	<div class="panel">
		{#if active === "terminal"}
			<div class="terminal">
				{#each lines as line (line.time + line.value)}
					<div class="term-line">
						<span class="term-ts">[{line.time}]</span>
						{#if line.label}
							<span class="term-label">{line.label}:</span>
						{/if}
						<span class="term-val">{line.value}</span>
					</div>
				{/each}
				<div class="term-cursor">█</div>
			</div>
		{:else if active === "tools"}
			<div class="placeholder">
				<span class="placeholder-text">Tool call history — coming in Phase 3</span>
			</div>
		{:else if active === "browser" && isMcp}
			{#if widgetHtml && agent.source.type === "mcp"}
				<div class="widget-wrap">
					<WidgetSandbox html={widgetHtml} serverId={agent.source.serverId} />
				</div>
			{:else if widgetError}
				<div class="placeholder">
					<span class="placeholder-text">Widget failed to load — try refreshing</span>
				</div>
			{:else}
				<div class="placeholder">
					<span class="placeholder-text placeholder-text--loading">Loading widget…</span>
				</div>
			{/if}
		{:else}
			<div class="placeholder">
				<span class="placeholder-text">Browser view — not available</span>
			</div>
		{/if}
	</div>
</div>

<style>
	.activity {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 400px;
	}

	.tab-bar {
		display: flex;
		gap: 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
		flex-shrink: 0;
	}

	.tab {
		padding: 8px 14px;
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.1em;
		color: rgba(255, 255, 255, 0.35);
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		cursor: pointer;
		transition: color 0.15s ease, border-color 0.15s ease;
	}

	.tab:hover:not(:disabled) {
		color: rgba(255, 255, 255, 0.6);
	}

	.tab--active {
		color: #00ff41;
		border-bottom-color: #00ff41;
	}

	.tab--disabled {
		opacity: 0.3;
		cursor: default;
	}

	.panel {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.terminal {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 12px;
		background: #0c0c0c;
		scroll-behavior: smooth;
	}

	.term-line {
		display: flex;
		gap: 6px;
		font-family: var(--font-mono, monospace);
		font-size: 12px;
		line-height: 1.7;
		flex-wrap: wrap;
	}

	.term-ts {
		color: #00ff41;
		flex-shrink: 0;
	}

	.term-label {
		color: rgba(255, 255, 255, 0.5);
		flex-shrink: 0;
	}

	.term-val {
		color: rgba(255, 255, 255, 0.85);
	}

	.term-cursor {
		color: #00ff41;
		font-family: var(--font-mono, monospace);
		font-size: 12px;
		line-height: 1.7;
		animation: cursor-blink 1s step-end infinite;
	}

	@keyframes cursor-blink {
		0%, 50% { opacity: 1; }
		51%, 100% { opacity: 0; }
	}

	.placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		min-height: 0;
		background: #0c0c0c;
	}

	.placeholder-text {
		font-family: var(--font-mono, monospace);
		font-size: 11px;
		color: rgba(255, 255, 255, 0.25);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.placeholder-text--loading {
		animation: loading-pulse 1.5s ease-in-out infinite;
	}

	@keyframes loading-pulse {
		0%, 100% { opacity: 0.25; }
		50% { opacity: 0.6; }
	}

	.widget-wrap {
		width: 100%;
		height: 100%;
		min-height: 400px;
		background: var(--sig-bg, #0c0c0c);
		position: relative;
		display: flex;
		flex-direction: column;
	}

	.widget-wrap :global(.widget-sandbox) {
		flex: 1;
		min-height: 0;
	}

	.widget-wrap :global(.widget-iframe) {
		width: 100%;
		height: 100%;
	}
</style>
