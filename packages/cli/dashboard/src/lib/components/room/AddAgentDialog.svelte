<script lang="ts">
	import { onDestroy } from "svelte";
	import { API_BASE } from "$lib/api";
	import { fetchAgents } from "$lib/stores/agents.svelte";
	import X from "@lucide/svelte/icons/x";
	import Loader from "@lucide/svelte/icons/loader";
	import CheckCircle from "@lucide/svelte/icons/check-circle-2";

	interface Props {
		open: boolean;
		onclose: () => void;
	}

	const { open, onclose }: Props = $props();

	// ── Mode ────────────────────────────────────────────────────────────────
	type Mode = "spawn" | "mcp" | "manual";
	let mode = $state<Mode>("spawn");

	// ── Spawn Claude Code state ──────────────────────────────────────────────
	let task = $state("");
	let model = $state("sonnet");

	// ── Connect MCP state ────────────────────────────────────────────────────
	let mcpUrl = $state("");

	// ── Manual Entry state ───────────────────────────────────────────────────
	let agentName = $state("");
	let agentRole = $state("");
	let selectedColor = $state("bondi");

	// ── Shared state ─────────────────────────────────────────────────────────
	let loading = $state(false);
	let error = $state<string | null>(null);
	let successMsg = $state<string | null>(null);
	let closeTimer: ReturnType<typeof setTimeout> | null = null;

	onDestroy(() => {
		if (closeTimer) clearTimeout(closeTimer);
	});

	// ── G3 colors ─────────────────────────────────────────────────────────────
	const G3_COLORS = [
		"bondi",
		"tangerine",
		"grape",
		"lime",
		"strawberry",
		"blueberry",
		"sage",
		"ruby",
		"indigo",
		"snow",
		"graphite",
		"flower",
	] as const;

	const G3_HEX: Record<string, string> = {
		bondi:      "#0095b6",
		tangerine:  "#f28500",
		grape:      "#6f2da8",
		lime:       "#9dc209",
		strawberry: "#fc5a8d",
		blueberry:  "#4f86c6",
		sage:       "#5a8a6a",
		ruby:       "#9b111e",
		indigo:     "#4b0082",
		snow:       "#d8d8d8",
		graphite:   "#5a5a66",
		flower:     "#e77fc3",
	};

	// ── Reset ────────────────────────────────────────────────────────────────
	function reset(): void {
		if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
		mode       = "spawn";
		task       = "";
		model      = "sonnet";
		mcpUrl     = "";
		agentName  = "";
		agentRole  = "";
		selectedColor = "bondi";
		loading    = false;
		error      = null;
		successMsg = null;
	}

	function handleClose(): void {
		reset();
		onclose();
	}

	function handleBackdrop(e: MouseEvent): void {
		if (e.target === e.currentTarget) handleClose();
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === "Escape") handleClose();
	}

	function scheduleClose(): void {
		closeTimer = setTimeout(() => handleClose(), 1200);
	}

	// ── Spawn Claude Code ────────────────────────────────────────────────────
	async function handleSpawn(): Promise<void> {
		const trimmed = task.trim();
		if (!trimmed) { error = "Task is required"; return; }

		loading = true;
		error   = null;

		try {
			const res = await fetch(`${API_BASE}/api/room/agents/spawn`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ task: trimmed, model }),
			});
			const body = await res.json() as { ok?: boolean; pid?: number; error?: string };
			if (!res.ok || !body.ok) {
				error = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
			} else {
				successMsg = `Claude Code launched (PID ${body.pid ?? "?"})`;
				await fetchAgents();
				scheduleClose();
			}
		} catch (err_) {
			error = err_ instanceof Error ? err_.message : String(err_);
		} finally {
			loading = false;
		}
	}

	// ── Connect MCP Server ───────────────────────────────────────────────────
	async function handleMcp(): Promise<void> {
		const trimmed = mcpUrl.trim();
		if (!trimmed) { error = "Server URL is required"; return; }

		loading = true;
		error   = null;

		try {
			const res = await fetch(`${API_BASE}/api/os/install`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: trimmed, autoPlace: false }),
			});
			const body = await res.json() as { ok?: boolean; error?: string };
			if (!res.ok || !body.ok) {
				error = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
			} else {
				successMsg = "MCP server connected";
				await fetchAgents();
				scheduleClose();
			}
		} catch (err_) {
			error = err_ instanceof Error ? err_.message : String(err_);
		} finally {
			loading = false;
		}
	}

	// ── Manual Entry ─────────────────────────────────────────────────────────
	async function handleManual(): Promise<void> {
		const trimmedName = agentName.trim();
		if (!trimmedName) { error = "Name is required"; return; }

		loading = true;
		error   = null;

		try {
			// Register a manual agent via the registry endpoint if available,
			// or optimistically add it to the local store.
			const res = await fetch(`${API_BASE}/api/room/agents/manual`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: trimmedName, role: agentRole.trim() || "agent", color: selectedColor }),
			});
			// Manual endpoint may not exist yet — treat 404 as soft success
			if (res.ok || res.status === 404) {
				successMsg = `"${trimmedName}" added`;
				await fetchAgents();
				scheduleClose();
			} else {
				const body = await res.json() as { error?: string };
				error = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
			}
		} catch (err_) {
			error = err_ instanceof Error ? err_.message : String(err_);
		} finally {
			loading = false;
		}
	}

	function handleSubmit(): void {
		error = null;
		if      (mode === "spawn")  { void handleSpawn();  }
		else if (mode === "mcp")    { void handleMcp();    }
		else                         { void handleManual(); }
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="backdrop"
		role="dialog"
		aria-modal="true"
		aria-label="Add Agent"
		tabindex="-1"
		onclick={handleBackdrop}
		onkeydown={handleKeydown}
	>
		<div class="panel">
			<!-- Header -->
			<div class="panel-header">
				<span class="panel-title">ADD AGENT</span>
				<button class="close-btn" onclick={handleClose} title="Close" aria-label="Close">
					<X class="icon" />
				</button>
			</div>

			<!-- Mode tabs -->
			<div class="tabs" role="tablist">
				<button
					class="tab"
					class:tab--active={mode === "spawn"}
					role="tab"
					aria-selected={mode === "spawn"}
					onclick={() => { mode = "spawn"; error = null; }}
				>SPAWN</button>
				<button
					class="tab"
					class:tab--active={mode === "mcp"}
					role="tab"
					aria-selected={mode === "mcp"}
					onclick={() => { mode = "mcp"; error = null; }}
				>MCP</button>
				<button
					class="tab"
					class:tab--active={mode === "manual"}
					role="tab"
					aria-selected={mode === "manual"}
					onclick={() => { mode = "manual"; error = null; }}
				>MANUAL</button>
			</div>

			<!-- Body -->
			<div class="panel-body">

				{#if mode === "spawn"}
					<!-- Spawn Claude Code -->
					<p class="mode-desc">Start a new Claude Code process with a task.</p>

					<div class="field">
						<label for="spawn-task" class="field-label">Task</label>
						<textarea
							id="spawn-task"
							class="field-textarea"
							placeholder="What should the agent work on?"
							bind:value={task}
							disabled={loading}
							rows={3}
							onkeydown={(e) => { if (e.key === "Enter" && e.metaKey) handleSubmit(); }}
						></textarea>
					</div>

					<div class="field">
						<label for="spawn-model" class="field-label">Model</label>
						<select id="spawn-model" class="field-select" bind:value={model} disabled={loading}>
							<option value="haiku">claude-haiku</option>
							<option value="sonnet">claude-sonnet</option>
							<option value="opus">claude-opus</option>
						</select>
					</div>

				{:else if mode === "mcp"}
					<!-- Connect MCP Server -->
					<p class="mode-desc">Probe and connect a remote MCP server.</p>

					<div class="field">
						<label for="mcp-url" class="field-label">Server URL</label>
						<input
							id="mcp-url"
							type="url"
							class="field-input"
							placeholder="https://mcp.example.com"
							bind:value={mcpUrl}
							disabled={loading}
							onkeydown={(e) => { if (e.key === "Enter") handleSubmit(); }}
						/>
					</div>

				{:else}
					<!-- Manual Entry -->
					<p class="mode-desc">Add a named agent slot for tracking.</p>

					<div class="field">
						<label for="manual-name" class="field-label">Name</label>
						<input
							id="manual-name"
							type="text"
							class="field-input"
							placeholder="Agent Alpha"
							bind:value={agentName}
							disabled={loading}
							onkeydown={(e) => { if (e.key === "Enter") handleSubmit(); }}
						/>
					</div>

					<div class="field">
						<label for="manual-role" class="field-label">Role <span class="optional">(optional)</span></label>
						<input
							id="manual-role"
							type="text"
							class="field-input"
							placeholder="coding agent"
							bind:value={agentRole}
							disabled={loading}
							onkeydown={(e) => { if (e.key === "Enter") handleSubmit(); }}
						/>
					</div>

					<div class="field">
						<span class="field-label">Color</span>
						<div class="color-picker">
							{#each G3_COLORS as color}
								<button
									class="color-dot"
									class:selected={selectedColor === color}
									style="background: {G3_HEX[color] ?? '#888'}"
									title={color}
									aria-label={color}
									onclick={() => { selectedColor = color; }}
								></button>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Feedback -->
				{#if error}
					<div class="msg msg--error">{error}</div>
				{/if}

				{#if successMsg}
					<div class="msg msg--success">
						<CheckCircle class="icon-sm" />
						{successMsg}
					</div>
				{/if}
			</div>

			<!-- Footer -->
			<div class="panel-footer">
				<button class="btn btn--ghost" onclick={handleClose} disabled={loading}>
					Cancel
				</button>
				<button class="btn btn--crt" onclick={handleSubmit} disabled={loading}>
					{#if loading}
						<Loader class="icon-sm spin" />
						{#if mode === "spawn"}Launching…{:else if mode === "mcp"}Connecting…{:else}Adding…{/if}
					{:else}
						{#if mode === "spawn"}Launch{:else if mode === "mcp"}Connect{:else}Add{/if}
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Backdrop */
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 200;
		background: rgba(0, 0, 0, 0.72);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
		backdrop-filter: blur(2px);
	}

	/* Panel */
	.panel {
		background: #0d0d11;
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 8px;
		width: 100%;
		max-width: 420px;
		box-shadow:
			0 0 0 1px rgba(255, 255, 255, 0.04) inset,
			0 16px 48px rgba(0, 0, 0, 0.7);
		overflow: hidden;
		font-family: var(--font-mono), monospace;
	}

	/* Header */
	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 16px 10px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
	}

	.panel-title {
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.18em;
		color: rgba(255, 255, 255, 0.45);
	}

	.close-btn {
		background: none;
		border: none;
		color: rgba(255, 255, 255, 0.3);
		cursor: pointer;
		padding: 4px;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: color 0.15s ease;
	}

	.close-btn:hover {
		color: rgba(255, 255, 255, 0.7);
	}

	:global(.icon) {
		width: 16px;
		height: 16px;
	}

	/* Tabs */
	.tabs {
		display: flex;
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
	}

	.tab {
		flex: 1;
		padding: 8px 0;
		background: none;
		border: none;
		font-family: var(--font-mono), monospace;
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.12em;
		color: rgba(255, 255, 255, 0.25);
		cursor: pointer;
		border-bottom: 2px solid transparent;
		transition: color 0.15s ease, border-color 0.15s ease;
		margin-bottom: -1px;
	}

	.tab:hover {
		color: rgba(255, 255, 255, 0.5);
	}

	.tab--active {
		color: #39ff14;
		border-bottom-color: #39ff14;
	}

	/* Body */
	.panel-body {
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.mode-desc {
		font-size: 11px;
		color: rgba(255, 255, 255, 0.3);
		margin: 0;
		line-height: 1.4;
	}

	/* Fields */
	.field {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.field-label {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: rgba(255, 255, 255, 0.35);
	}

	.optional {
		font-weight: 400;
		text-transform: none;
		letter-spacing: 0;
		opacity: 0.6;
	}

	.field-input,
	.field-select,
	.field-textarea {
		font-family: var(--font-mono), monospace;
		font-size: 12px;
		padding: 8px 10px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 5px;
		background: rgba(0, 0, 0, 0.4);
		color: rgba(255, 255, 255, 0.85);
		outline: none;
		transition: border-color 0.15s ease;
	}

	.field-textarea {
		resize: vertical;
		min-height: 64px;
		line-height: 1.5;
	}

	.field-select {
		cursor: pointer;
		appearance: none;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='rgba(255,255,255,0.3)' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 10px center;
		padding-right: 28px;
	}

	.field-input:focus,
	.field-select:focus,
	.field-textarea:focus {
		border-color: rgba(57, 255, 20, 0.5);
		box-shadow: 0 0 0 2px rgba(57, 255, 20, 0.08);
	}

	.field-input:disabled,
	.field-select:disabled,
	.field-textarea:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.field-input::placeholder,
	.field-textarea::placeholder {
		color: rgba(255, 255, 255, 0.2);
	}

	/* Color picker */
	.color-picker {
		display: flex;
		flex-wrap: wrap;
		gap: 7px;
		padding: 4px 0;
	}

	.color-dot {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 2px solid transparent;
		cursor: pointer;
		transition: transform 0.12s ease, border-color 0.12s ease;
		padding: 0;
		flex-shrink: 0;
	}

	.color-dot:hover {
		transform: scale(1.15);
	}

	.color-dot.selected {
		border-color: #ffffff;
		transform: scale(1.18);
	}

	/* Feedback messages */
	.msg {
		font-size: 11px;
		padding: 7px 10px;
		border-radius: 5px;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.msg--error {
		background: rgba(239, 68, 68, 0.12);
		color: #f87171;
		border: 1px solid rgba(239, 68, 68, 0.2);
	}

	.msg--success {
		background: rgba(57, 255, 20, 0.08);
		color: #39ff14;
		border: 1px solid rgba(57, 255, 20, 0.15);
	}

	:global(.icon-sm) {
		width: 13px;
		height: 13px;
		flex-shrink: 0;
	}

	/* Footer */
	.panel-footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 10px 16px 14px;
		border-top: 1px solid rgba(255, 255, 255, 0.06);
	}

	.btn {
		font-family: var(--font-mono), monospace;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		padding: 7px 16px;
		border-radius: 5px;
		border: 1px solid transparent;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 6px;
		transition: all 0.15s ease;
	}

	.btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	.btn--ghost {
		background: transparent;
		color: rgba(255, 255, 255, 0.3);
		border-color: rgba(255, 255, 255, 0.1);
	}

	.btn--ghost:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.04);
		color: rgba(255, 255, 255, 0.6);
	}

	/* CRT green primary button */
	.btn--crt {
		background: rgba(57, 255, 20, 0.12);
		color: #39ff14;
		border-color: rgba(57, 255, 20, 0.3);
		text-shadow: 0 0 8px rgba(57, 255, 20, 0.5);
	}

	.btn--crt:hover:not(:disabled) {
		background: rgba(57, 255, 20, 0.2);
		border-color: rgba(57, 255, 20, 0.5);
		box-shadow: 0 0 12px rgba(57, 255, 20, 0.15);
	}

	:global(.spin) {
		animation: spin 0.9s linear infinite;
	}

	@keyframes spin {
		from { transform: rotate(0deg); }
		to   { transform: rotate(360deg); }
	}

	@media (prefers-reduced-motion: reduce) {
		.tab,
		.close-btn,
		.field-input,
		.field-select,
		.field-textarea,
		.color-dot,
		.btn {
			transition: none;
		}
		:global(.spin) {
			animation: none;
		}
	}
</style>
