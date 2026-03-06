<script lang="ts">
	interface Props {
		archetype: string;
		onComplete: (skills: string[]) => void;
	}
	let { archetype, onComplete }: Props = $props();

	const LOADOUT_OPTIONS: Record<string, string[]> = {
		coder: ['git-tools', 'code-review', 'deploy-agent', 'debug-assistant'],
		analyst: ['data-analyst', 'report-writer', 'web-researcher', 'chart-builder'],
		operator: ['task-runner', 'cron-manager', 'alert-system', 'multi-agent'],
		generalist: ['web-search', 'note-taker', 'email-helper', 'file-organiser'],
	};

	let options = $derived(LOADOUT_OPTIONS[archetype] ?? LOADOUT_OPTIONS.generalist);
	let selected = $state<Set<string>>(new Set());

	function toggle(skill: string) {
		const next = new Set(selected);
		if (next.has(skill)) { next.delete(skill); } else { next.add(skill); }
		selected = next;
	}
</script>

<div class="loadout-wrap">
	<h3 class="sig-heading text-center mb-4">Choose Starting Loadout</h3>
	<p class="sig-eyebrow text-center mb-6" style="color:var(--sig-text-muted)">
		Select up to 4 skill packs to equip at creation
	</p>

	<div class="loadout-grid">
		{#each options as skill (skill)}
			<button
				type="button"
				class="loadout-item"
				class:loadout-selected={selected.has(skill)}
				onclick={() => toggle(skill)}
			>
				<span class="loadout-check">{selected.has(skill) ? '\u2713' : '\u25CB'}</span>
				<span class="loadout-name">{skill}</span>
			</button>
		{/each}
	</div>

	<button
		type="button"
		class="loadout-confirm"
		onclick={() => onComplete([...selected])}
	>
		&#x2694; Begin Journey ({selected.size} selected)
	</button>
</div>

<style>
	.loadout-wrap { display: flex; flex-direction: column; gap: 16px; }
	.loadout-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 8px;
	}
	.loadout-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border: 1px solid var(--sig-border-strong);
		background: var(--sig-surface-raised);
		cursor: pointer;
		transition: all 0.15s;
		text-align: left;
	}
	.loadout-item:hover {
		border-color: var(--rpg-gold);
		color: var(--rpg-gold);
	}
	.loadout-selected {
		border-color: var(--rpg-gold) !important;
		background: var(--rpg-gold-dim) !important;
		color: var(--rpg-gold) !important;
	}
	.loadout-check {
		font-size: 12px;
		flex-shrink: 0;
		width: 16px;
	}
	.loadout-name {
		font-family: var(--font-mono);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.loadout-confirm {
		padding: 12px 24px;
		background: var(--rpg-gold);
		color: black;
		border: none;
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		cursor: pointer;
		transition: all 0.15s;
		align-self: center;
		min-width: 200px;
	}
	.loadout-confirm:hover {
		background: #fbbf24;
		box-shadow: var(--rpg-gold-glow);
	}
</style>
