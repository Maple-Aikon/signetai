<script lang="ts">
	interface Props {
		flicker?: boolean;
		scanlines?: boolean;
		vignette?: boolean;
	}

	const { flicker = true, scanlines = true, vignette = true }: Props = $props();
</script>

<div class="crt" class:crt--flicker={flicker}>
	{#if scanlines}
		<div class="crt-scanlines"></div>
	{/if}
	{#if vignette}
		<div class="crt-vignette"></div>
	{/if}
</div>

<style>
	.crt {
		position: absolute;
		inset: 0;
		pointer-events: none;
		border-radius: inherit;
		z-index: 3;
		overflow: hidden;
	}

	.crt-scanlines {
		position: absolute;
		inset: 0;
		background: repeating-linear-gradient(
			0deg,
			transparent,
			transparent 1px,
			rgba(0, 0, 0, 0.08) 1px,
			rgba(0, 0, 0, 0.08) 2px
		);
		border-radius: inherit;
		z-index: 1;
	}

	.crt-vignette {
		position: absolute;
		inset: 0;
		background: radial-gradient(
			ellipse at center,
			transparent 50%,
			rgba(0, 0, 0, 0.15) 75%,
			rgba(0, 0, 0, 0.4) 100%
		);
		border-radius: inherit;
		z-index: 2;
	}

	.crt--flicker {
		animation: crt-flicker 8s infinite;
	}

	@keyframes crt-flicker {
		0%,
		100% {
			opacity: 1;
		}
		92% {
			opacity: 1;
		}
		93% {
			opacity: 0.92;
		}
		94% {
			opacity: 1;
		}
		95% {
			opacity: 0.95;
		}
		96% {
			opacity: 1;
		}
	}
</style>
