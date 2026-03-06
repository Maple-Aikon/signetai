<script lang="ts">
	interface Archetype {
		id: string;
		name: string;
		description: string;
		icon: string;
		color: string;
		rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
		bonuses: string[];
	}

	const ARCHETYPES: Archetype[] = [
		{
			id: 'coder',
			name: 'The Artificer',
			description: 'Master of code and systems. +25% pipeline throughput.',
			icon: '\u2699',
			color: 'var(--rpg-teal)',
			rarity: 'rare',
			bonuses: ['+25% pipeline speed', '+10% memory retention', 'Embedded coding skills'],
		},
		{
			id: 'analyst',
			name: 'The Scholar',
			description: 'Seeker of truth. Memory capacity doubled.',
			icon: '\uD83D\uDCDC',
			color: 'var(--rpg-purple)',
			rarity: 'epic',
			bonuses: ['2\u00D7 memory capacity', '+15% search accuracy', 'Enhanced timeline view'],
		},
		{
			id: 'operator',
			name: 'The Commander',
			description: 'Deploys quests with precision. Task automation unlocked.',
			icon: '\u2694',
			color: 'var(--rpg-gold)',
			rarity: 'legendary',
			bonuses: ['Advanced Quest Board', '+20% task success rate', 'Multi-harness sync'],
		},
		{
			id: 'generalist',
			name: 'The Wanderer',
			description: 'Balanced across all disciplines. No specialisation, no limits.',
			icon: '\uD83D\uDDFA',
			color: 'var(--sig-text-muted)',
			rarity: 'uncommon',
			bonuses: ['Balanced stats', 'All tabs unlocked', 'Freedom of choice'],
		},
	];

	interface Props {
		onSelect: (id: string) => void;
	}
	let { onSelect }: Props = $props();
	let hovered = $state<string | null>(null);
</script>

<div class="archetype-grid">
	<h3 class="archetype-heading sig-heading">Choose Your Archetype</h3>
	<div class="archetype-cards">
		{#each ARCHETYPES as arch (arch.id)}
			<button
				type="button"
				class="archetype-card rarity-{arch.rarity}"
				class:hovered={hovered === arch.id}
				onmouseenter={() => hovered = arch.id}
				onmouseleave={() => hovered = null}
				onclick={() => onSelect(arch.id)}
			>
				<div class="arch-icon" style="color:{arch.color}">{arch.icon}</div>
				<div class="arch-name" style="color:{arch.color}">{arch.name}</div>
				<div class="arch-rarity sig-eyebrow" style="color:{arch.color}">
					{arch.rarity.toUpperCase()}
				</div>
				<p class="arch-desc">{arch.description}</p>
				<ul class="arch-bonuses">
					{#each arch.bonuses as bonus (bonus)}
						<li class="arch-bonus">
							<span style="color:{arch.color}">\u25B8</span> {bonus}
						</li>
					{/each}
				</ul>
				<div class="arch-select-btn" style="border-color:{arch.color};color:{arch.color}">
					SELECT
				</div>
			</button>
		{/each}
	</div>
</div>

<style>
	.archetype-heading {
		text-align: center;
		margin-bottom: 20px;
		color: var(--sig-text-bright);
	}
	.archetype-cards {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 12px;
	}
	.archetype-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 16px;
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		cursor: pointer;
		text-align: left;
		transition: all 0.2s ease;
		position: relative;
	}
	.archetype-card:hover {
		transform: translateY(-2px);
		box-shadow: 0 8px 24px rgba(0,0,0,0.4);
	}
	.arch-icon {
		font-size: 28px;
		line-height: 1;
		margin-bottom: 4px;
	}
	.arch-name {
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.arch-rarity {
		letter-spacing: 0.1em;
		margin-bottom: 4px;
	}
	.arch-desc {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		line-height: 1.5;
		margin: 0;
	}
	.arch-bonuses {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.arch-bonus {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text);
	}
	.arch-select-btn {
		margin-top: auto;
		padding: 6px 12px;
		border: 1px solid;
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		text-align: center;
		opacity: 0;
		transition: opacity 0.15s;
	}
	.archetype-card:hover .arch-select-btn { opacity: 1; }
	@media (max-width: 560px) {
		.archetype-cards { grid-template-columns: 1fr; }
	}
</style>
