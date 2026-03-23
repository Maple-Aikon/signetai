<script lang="ts">
	import CRTEffect from './CRTEffect.svelte';

	interface Props {
		name: string;
		role?: string;
		color: string;
		status: 'active' | 'idle' | 'error' | 'offline';
		selected?: boolean;
		onclick?: () => void;
		children?: import('svelte').Snippet;
	}

	const {
		name,
		role = '',
		color,
		status,
		selected = false,
		onclick,
		children
	}: Props = $props();

	const colorClass = $derived(`g3--${color}`);
	const statusClass = $derived(`g3--${status}`);
</script>

<button
	class="g3 {colorClass} {statusClass}"
	class:g3--selected={selected}
	onclick={onclick}
	type="button"
	aria-label="Agent: {name}"
>
	<!-- Outer translucent shell — the iconic egg body -->
	<div class="g3-body">
		<!-- Faux internal components visible through translucent shell -->
		<div class="g3-internals">
			<div class="g3-internal-board"></div>
			<div class="g3-internal-fan"></div>
			<div class="g3-internal-chip"></div>
		</div>

		<!-- Inner bezel / darker frame around the screen -->
		<div class="g3-bezel">
			<!-- Screen area with CRT curvature -->
			<div class="g3-screen">
				<div class="g3-screen-content">
					{#if children}
						{@render children()}
					{:else}
						<div class="g3-screen-static"></div>
					{/if}
				</div>
				<CRTEffect flicker={status === 'active' || status === 'idle'} />
				<!-- Screen glare reflection -->
				<div class="g3-screen-glare"></div>
			</div>
		</div>

		<!-- Chin area — name plate, CD slot, logo, LED -->
		<div class="g3-chin">
			<div class="g3-cd-slot"></div>
			<div class="g3-logo">
				<svg class="g3-apple-icon" viewBox="0 0 170 200" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
					<path d="M150.4 172.2c-3.5 8.2-7.7 15.7-12.5 22.6-6.5 9.4-11.9 15.9-16 19.5-6.4 5.9-13.2 8.9-20.5 9.2-5.2 0-11.5-1.5-18.8-4.5-7.3-3-14.1-4.5-20.2-4.5-6.5 0-13.5 1.5-20.9 4.5-7.4 3-13.4 4.6-18 4.8-7 .4-14-2.7-20.9-9.4-4.4-3.9-10-10.6-16.6-20.2C-0.3 184.4-5.5 173.2-9.6 160.8c-4.4-13.4-6.6-26.3-6.6-38.8 0-14.3 3.1-26.7 9.3-37 4.9-8.3 11.4-14.8 19.5-19.6 8.2-4.8 17-7.2 26.4-7.5 5.5 0 12.8 1.7 21.8 5.1 9 3.4 14.8 5.1 17.3 5.1 1.9 0 8.3-2 19.2-5.9 10.3-3.7 19-5.2 26.1-4.6 19.3 1.6 33.8 9.2 43.4 23-17.3 10.5-25.8 25.1-25.6 44 .2 14.7 5.5 26.9 15.8 36.6 4.7 4.5 10 7.9 15.8 10.4-1.3 3.7-2.6 7.2-4 10.6zM104.9 5.4c0 11.5-4.2 22.3-12.6 32.2-10.1 11.9-22.4 18.7-35.7 17.6-.2-1.4-.3-2.9-.3-4.5 0-11.1 4.8-22.9 13.4-32.6 4.3-4.9 9.7-9 16.3-12.2 6.6-3.2 12.8-4.9 18.6-5.2.2 1.6.3 3.2.3 4.7z" transform="translate(10, -2) scale(0.82)"/>
				</svg>
			</div>
			<div class="g3-nameplate">
				<span class="g3-name">{name}</span>
				{#if role}
					<span class="g3-role">{role}</span>
				{/if}
			</div>
			<div class="g3-led"></div>
		</div>
	</div>

	<!-- Base / stand shadow -->
	<div class="g3-shadow"></div>
</button>

<style>
	/* ─── Color variants ─── */
	.g3--bondi {
		--g3-shell: rgba(0, 188, 212, 0.35);
		--g3-solid: #00838f;
	}
	.g3--tangerine {
		--g3-shell: rgba(255, 152, 0, 0.35);
		--g3-solid: #e65100;
	}
	.g3--grape {
		--g3-shell: rgba(156, 39, 176, 0.35);
		--g3-solid: #6a1b9a;
	}
	.g3--lime {
		--g3-shell: rgba(139, 195, 74, 0.35);
		--g3-solid: #558b2f;
	}
	.g3--strawberry {
		--g3-shell: rgba(244, 67, 54, 0.35);
		--g3-solid: #c62828;
	}
	.g3--blueberry {
		--g3-shell: rgba(63, 81, 181, 0.35);
		--g3-solid: #283593;
	}
	.g3--sage {
		--g3-shell: rgba(120, 144, 156, 0.35);
		--g3-solid: #546e7a;
	}
	.g3--ruby {
		--g3-shell: rgba(198, 40, 40, 0.35);
		--g3-solid: #b71c1c;
	}
	.g3--indigo {
		--g3-shell: rgba(26, 35, 78, 0.35);
		--g3-solid: #1a237e;
	}
	.g3--snow {
		--g3-shell: rgba(236, 239, 241, 0.35);
		--g3-solid: #cfd8dc;
	}
	.g3--graphite {
		--g3-shell: rgba(69, 90, 100, 0.35);
		--g3-solid: #37474f;
	}
	.g3--flower {
		--g3-shell: rgba(233, 30, 99, 0.35);
		--g3-solid: #ad1457;
	}

	/* ─── Root button ─── */
	.g3 {
		--g3-shell: rgba(0, 188, 212, 0.35);
		--g3-solid: #00838f;

		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		border: none;
		background: none;
		padding: 0;
		cursor: pointer;
		transition: transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
		outline: none;
		-webkit-tap-highlight-color: transparent;
		width: 220px;
	}

	.g3:hover {
		transform: scale(1.02);
	}

	.g3:hover .g3-body {
		filter: brightness(1.08);
	}

	.g3:hover .g3-screen {
		box-shadow:
			inset 0 0 30px rgba(0, 0, 0, 0.5),
			inset 0 3px 8px rgba(0, 0, 0, 0.3),
			0 0 15px rgba(180, 220, 255, 0.12);
	}

	.g3:focus-visible .g3-body {
		outline: 2px solid rgba(255, 255, 255, 0.5);
		outline-offset: 3px;
	}

	.g3--selected .g3-body {
		outline: 2px solid var(--g3-solid);
		outline-offset: 3px;
	}

	/* ─── Body — the egg-shaped shell ─── */
	.g3-body {
		position: relative;
		width: 200px;
		height: 220px;
		/* Egg-like: more rounded on top, flatter on bottom */
		border-radius: 28px 28px 20px 20px / 32px 32px 18px 18px;
		background:
			linear-gradient(
				165deg,
				var(--g3-shell) 0%,
				color-mix(in srgb, var(--g3-solid), transparent 55%) 40%,
				color-mix(in srgb, var(--g3-solid), #1a1a2e 30%) 100%
			);
		box-shadow:
			/* Outer plastic edge highlight */
			inset 1px 1px 0 rgba(255, 255, 255, 0.15),
			inset -1px -1px 0 rgba(0, 0, 0, 0.15),
			/* Depth shadow beneath */
			0 8px 24px rgba(0, 0, 0, 0.35),
			0 2px 8px rgba(0, 0, 0, 0.2);
		overflow: hidden;
		transition:
			filter 0.3s ease,
			outline-color 0.3s ease;
	}

	/* ─── Translucent internals visible through shell ─── */
	.g3-internals {
		position: absolute;
		inset: 0;
		z-index: 0;
		opacity: 0.12;
		pointer-events: none;
	}

	.g3-internal-board {
		position: absolute;
		bottom: 10px;
		right: 10px;
		width: 70px;
		height: 50px;
		background:
			repeating-linear-gradient(
				90deg,
				rgba(100, 200, 100, 0.3) 0px,
				rgba(100, 200, 100, 0.3) 1px,
				transparent 1px,
				transparent 6px
			),
			repeating-linear-gradient(
				0deg,
				rgba(100, 200, 100, 0.3) 0px,
				rgba(100, 200, 100, 0.3) 1px,
				transparent 1px,
				transparent 6px
			);
		border-radius: 3px;
		border: 1px solid rgba(100, 200, 100, 0.2);
	}

	.g3-internal-fan {
		position: absolute;
		top: 15px;
		right: 15px;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		border: 2px solid rgba(180, 180, 180, 0.4);
		background: radial-gradient(circle, transparent 40%, rgba(100, 100, 100, 0.2) 100%);
	}

	.g3-internal-chip {
		position: absolute;
		bottom: 25px;
		left: 15px;
		width: 22px;
		height: 22px;
		background: rgba(60, 60, 60, 0.4);
		border-radius: 2px;
		border: 1px solid rgba(150, 150, 150, 0.2);
	}

	/* ─── Bezel — darker inner frame ─── */
	.g3-bezel {
		position: absolute;
		top: 14px;
		left: 14px;
		right: 14px;
		bottom: 72px;
		background: linear-gradient(180deg, #2a2a32 0%, #1e1e26 100%);
		border-radius: 14px 14px 10px 10px;
		padding: 8px;
		box-shadow:
			inset 0 1px 3px rgba(0, 0, 0, 0.5),
			0 1px 0 rgba(255, 255, 255, 0.04);
		z-index: 1;
	}

	/* ─── Screen ─── */
	.g3-screen {
		position: relative;
		width: 100%;
		height: 100%;
		border-radius: 8px;
		background: #0a0e14;
		overflow: hidden;
		/* CRT concave curvature effect */
		box-shadow:
			inset 0 0 25px rgba(0, 0, 0, 0.6),
			inset 0 2px 6px rgba(0, 0, 0, 0.4);
		transition: box-shadow 0.4s ease;
	}

	/* ─── Screen content area ─── */
	.g3-screen-content {
		position: relative;
		width: 100%;
		height: 100%;
		z-index: 1;
		overflow: hidden;
		border-radius: inherit;
	}

	/* ─── Default static pattern when no content ─── */
	.g3-screen-static {
		width: 100%;
		height: 100%;
		background:
			radial-gradient(ellipse at 30% 40%, rgba(30, 40, 55, 0.6) 0%, transparent 60%),
			radial-gradient(ellipse at 70% 60%, rgba(20, 30, 45, 0.4) 0%, transparent 50%);
		animation: static-drift 12s ease-in-out infinite alternate;
	}

	@keyframes static-drift {
		0% {
			background-position:
				0% 0%,
				100% 100%;
		}
		100% {
			background-position:
				5% 3%,
				95% 97%;
		}
	}

	/* ─── Screen glare — plastic reflection ─── */
	.g3-screen-glare {
		position: absolute;
		inset: 0;
		z-index: 4;
		pointer-events: none;
		border-radius: inherit;
		background: linear-gradient(
			135deg,
			rgba(255, 255, 255, 0.07) 0%,
			rgba(255, 255, 255, 0.02) 30%,
			transparent 50%
		);
	}

	/* ─── Chin ─── */
	.g3-chin {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		height: 68px;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		z-index: 1;
		padding-top: 4px;
	}

	/* CD slot */
	.g3-cd-slot {
		width: 56px;
		height: 3px;
		background: linear-gradient(180deg, rgba(0, 0, 0, 0.35) 0%, rgba(0, 0, 0, 0.15) 100%);
		border-radius: 2px;
		box-shadow: 0 1px 0 rgba(255, 255, 255, 0.05);
		margin-bottom: 3px;
	}

	/* Apple logo */
	.g3-logo {
		width: 12px;
		height: 14px;
		color: rgba(255, 255, 255, 0.18);
		margin-bottom: 1px;
	}

	.g3-apple-icon {
		width: 100%;
		height: 100%;
		display: block;
	}

	/* Name plate */
	.g3-nameplate {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0;
		line-height: 1;
	}

	.g3-name {
		font-size: 10px;
		font-weight: 600;
		color: rgba(255, 255, 255, 0.55);
		letter-spacing: 0.05em;
		text-transform: uppercase;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 140px;
	}

	.g3-role {
		font-size: 8px;
		font-weight: 400;
		color: rgba(255, 255, 255, 0.3);
		letter-spacing: 0.03em;
		margin-top: 1px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 140px;
	}

	/* Status LED */
	.g3-led {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		margin-top: 3px;
		transition:
			background 0.4s ease,
			box-shadow 0.4s ease;
	}

	/* ─── Drop shadow under the whole unit ─── */
	.g3-shadow {
		width: 160px;
		height: 12px;
		margin-top: -2px;
		background: radial-gradient(
			ellipse at center,
			rgba(0, 0, 0, 0.3) 0%,
			transparent 70%
		);
		border-radius: 50%;
		transition: opacity 0.3s ease;
	}

	.g3:hover .g3-shadow {
		opacity: 0.7;
	}

	/* ═══════════════════════════════════════════
	   Status variants
	   ═══════════════════════════════════════════ */

	/* ── Active ── */
	.g3--active .g3-led {
		background: #4caf50;
		box-shadow: 0 0 6px rgba(76, 175, 80, 0.7), 0 0 2px rgba(76, 175, 80, 0.9);
	}

	.g3--active .g3-screen {
		box-shadow:
			inset 0 0 25px rgba(0, 0, 0, 0.4),
			inset 0 2px 6px rgba(0, 0, 0, 0.3),
			0 0 8px rgba(120, 180, 255, 0.06);
	}

	.g3--active .g3-screen-static {
		background:
			radial-gradient(ellipse at 30% 40%, rgba(40, 65, 90, 0.7) 0%, transparent 60%),
			radial-gradient(ellipse at 70% 60%, rgba(30, 50, 75, 0.5) 0%, transparent 50%);
	}

	/* ── Idle ── */
	.g3--idle .g3-led {
		background: #ffa726;
		box-shadow: 0 0 5px rgba(255, 167, 38, 0.6), 0 0 2px rgba(255, 167, 38, 0.8);
		animation: led-pulse 3s ease-in-out infinite;
	}

	.g3--idle .g3-screen-content {
		opacity: 0.6;
	}

	.g3--idle .g3-screen-static {
		animation: static-drift 12s ease-in-out infinite alternate;
	}

	@keyframes led-pulse {
		0%,
		100% {
			box-shadow: 0 0 5px rgba(255, 167, 38, 0.6), 0 0 2px rgba(255, 167, 38, 0.8);
		}
		50% {
			box-shadow: 0 0 8px rgba(255, 167, 38, 0.3), 0 0 2px rgba(255, 167, 38, 0.5);
		}
	}

	/* ── Error ── */
	.g3--error .g3-led {
		background: #ef5350;
		box-shadow: 0 0 6px rgba(239, 83, 80, 0.7), 0 0 2px rgba(239, 83, 80, 0.9);
		animation: led-error-blink 1.5s ease-in-out infinite;
	}

	.g3--error .g3-screen::after {
		content: '';
		position: absolute;
		inset: 0;
		background: rgba(200, 30, 30, 0.08);
		border-radius: inherit;
		z-index: 5;
		pointer-events: none;
	}

	@keyframes led-error-blink {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
	}

	/* ── Offline ── */
	.g3--offline .g3-led {
		background: #616161;
		box-shadow: none;
	}

	.g3--offline .g3-screen {
		background: #050508;
		box-shadow: inset 0 0 20px rgba(0, 0, 0, 0.8);
	}

	.g3--offline .g3-screen-content {
		opacity: 0;
	}

	.g3--offline .g3-screen-glare {
		opacity: 0.5;
	}

	.g3--offline .g3-body {
		filter: brightness(0.85) saturate(0.6);
	}
</style>
