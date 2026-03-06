<script lang="ts">
	import ArchetypeSelect from './ArchetypeSelect.svelte';
	import StartingLoadout from './StartingLoadout.svelte';

	let step = $state<'archetype' | 'loadout' | 'done'>('archetype');
	let chosenArchetype = $state<string>('');

	interface Props {
		onComplete: (result: { archetype: string; skills: string[] }) => void;
	}
	let { onComplete }: Props = $props();

	function handleArchetypeChosen(archetype: string) {
		chosenArchetype = archetype;
		step = 'loadout';
	}

	function handleLoadoutComplete(skills: string[]) {
		step = 'done';
		onComplete({ archetype: chosenArchetype, skills });
	}
</script>

<div class="agent-forge-shell">
	<div class="forge-header">
		<div class="forge-title rpg-text-gold">&#x2692; Agent Forge</div>
		<div class="forge-subtitle sig-eyebrow">Craft your agent's identity</div>
		<div class="forge-steps">
			<span class="forge-step" class:active={step === 'archetype'}>1 &#xB7; Archetype</span>
			<span class="forge-divider">&#x2014;&#x2014;</span>
			<span class="forge-step" class:active={step === 'loadout'}>2 &#xB7; Loadout</span>
			<span class="forge-divider">&#x2014;&#x2014;</span>
			<span class="forge-step" class:active={step === 'done'}>3 &#xB7; Complete</span>
		</div>
	</div>

	<div class="forge-body">
		{#if step === 'archetype'}
			<ArchetypeSelect onSelect={handleArchetypeChosen} />
		{:else if step === 'loadout'}
			<StartingLoadout archetype={chosenArchetype} onComplete={handleLoadoutComplete} />
		{:else}
			<div class="forge-complete">
				<div class="rpg-text-gold sig-heading mb-2">&#x2694; Agent Forged!</div>
				<div class="sig-label">Your agent is ready to begin the journey.</div>
			</div>
		{/if}
	</div>
</div>

<style>
	.agent-forge-shell {
		display: flex;
		flex-direction: column;
		gap: 24px;
		padding: 32px;
		max-width: 640px;
		margin: 0 auto;
		position: relative;
	}
	.forge-header { text-align: center; }
	.forge-title {
		font-family: var(--font-display);
		font-size: 28px;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		margin-bottom: 4px;
	}
	.forge-steps {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		margin-top: 12px;
	}
	.forge-step {
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
		transition: color 0.2s;
	}
	.forge-step.active {
		color: var(--rpg-gold);
		text-shadow: 0 0 8px rgba(245,158,11,0.5);
	}
	.forge-divider {
		color: var(--sig-border-strong);
		font-family: var(--font-mono);
		font-size: 9px;
	}
	.forge-complete { text-align: center; padding: 40px 0; }
	.forge-body { animation: rpg-slide-in 0.3s ease both; }
</style>
