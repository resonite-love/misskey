<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="display === 'bar'" :class="[$style.bar, { [$style.compact]: compact }]" :style="{ background: channel.color }" aria-hidden="true"></div>
<MkA v-else :class="$style.link" :to="to ?? `/channels/${channel.id}`"><i class="ti ti-device-tv"></i> {{ channel.name }}</MkA>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
	channel: { id: string; name: string; color: string };
	display?: 'bar' | 'link';
	compact?: boolean;
	to?: string;
}>(), { display: 'link', compact: false });
</script>

<style lang="scss" module>
.bar {
	position: absolute;
	top: 8px;
	left: 8px;
	width: 5px;
	height: calc(100% - 16px);
	border-radius: 999px;
	pointer-events: none;
}
.bar.compact { height: calc(100% - 6px); }
.link { opacity: 0.7; font-size: 80%; }
@container (max-width: 350px) {
	.bar { top: 6px; left: 6px; width: 4px; height: calc(100% - 12px); }
}
</style>
