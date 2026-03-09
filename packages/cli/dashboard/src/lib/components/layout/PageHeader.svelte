<script lang="ts">
import type { TabId } from "$lib/stores/navigation.svelte";

interface Props {
	activeTab: TabId;
}

const { activeTab }: Props = $props();
</script>

<!-- Preserved for layout structure; all tabs now use PageBanner -->
<header
	class="hidden flex h-12 shrink-0 items-center justify-between
		border-b border-[var(--sig-border)] px-4
		bg-[var(--sig-surface)]"
>
</header>
