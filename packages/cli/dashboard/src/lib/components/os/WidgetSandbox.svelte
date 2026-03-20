<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { buildSrcdoc } from "./widget-theme";
	import { API_BASE } from "$lib/api";

	interface Props {
		html: string;
		serverId: string;
		expanded?: boolean;
	}

	const { html, serverId, expanded = false }: Props = $props();

	let iframe: HTMLIFrameElement | null = $state(null);
	let ready = $state(false);

	const srcdoc = $derived(buildSrcdoc(html, serverId));

	function handleMessage(e: MessageEvent): void {
		if (!iframe || e.source !== iframe.contentWindow) return;

		const data = e.data;
		if (!data || typeof data.type !== "string") return;

		if (data.type === "signet:ready") {
			ready = true;
			return;
		}

		if (data.type === "signet:callTool") {
			callTool(data.id, data.tool, data.args);
			return;
		}

		if (data.type === "signet:readResource") {
			readResource(data.id, data.uri);
			return;
		}
	}

	async function callTool(
		id: string,
		tool: string,
		args: Record<string, unknown>,
	): Promise<void> {
		try {
			const res = await fetch(`${API_BASE}/api/marketplace/mcp/call`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ serverId, toolName: tool, args }),
			});
			const data = await res.json();
			if (data.success) {
				postToWidget({ type: "signet:result", id, result: data.result });
			} else {
				postToWidget({
					type: "signet:error",
					id,
					error: data.error ?? "Tool call failed",
				});
			}
		} catch (err) {
			postToWidget({
				type: "signet:error",
				id,
				error: err instanceof Error ? err.message : "Unknown error",
			});
		}
	}

	async function readResource(id: string, uri: string): Promise<void> {
		try {
			const res = await fetch(
				`${API_BASE}/api/marketplace/mcp/read-resource`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ serverId, uri }),
				},
			);
			const data = await res.json();
			if (data.success) {
				postToWidget({ type: "signet:result", id, result: data.contents });
			} else {
				postToWidget({
					type: "signet:error",
					id,
					error: data.error ?? "Resource read failed",
				});
			}
		} catch (err) {
			postToWidget({
				type: "signet:error",
				id,
				error: err instanceof Error ? err.message : "Unknown error",
			});
		}
	}

	function postToWidget(msg: Record<string, unknown>): void {
		iframe?.contentWindow?.postMessage(msg, window.location.origin);
	}

	onMount(() => {
		window.addEventListener("message", handleMessage);
	});

	onDestroy(() => {
		window.removeEventListener("message", handleMessage);
	});
</script>

<div class="widget-sandbox" class:expanded>
	<iframe
		bind:this={iframe}
		{srcdoc}
		sandbox="allow-scripts"
		title="Widget: {serverId}"
		class="widget-iframe"
	></iframe>
	{#if !ready}
		<div class="widget-loading">
			<span class="widget-loading-text">Loading...</span>
		</div>
	{/if}
</div>

<style>
	.widget-sandbox {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
	}

	.widget-iframe {
		width: 100%;
		height: 100%;
		border: none;
		background: var(--sig-bg);
	}

	.widget-loading {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--sig-surface);
		z-index: 1;
	}

	.widget-loading-text {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
</style>
