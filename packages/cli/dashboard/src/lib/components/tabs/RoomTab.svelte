<script lang="ts">
	import MonitorGrid from "$lib/components/room/MonitorGrid.svelte";
</script>

<div class="room-tab">
	<MonitorGrid />
</div>

<style>
	.room-tab {
		display: flex;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		background: #0a0a0c;
	}
</style>
