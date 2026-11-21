<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="display === 'bar' && colors.length" :class="[$style.bar, { [$style.compact]: compact }]" aria-hidden="true" data-note-channel-colors>
	<span v-for="color in colors" :key="color" :class="$style.segment" :style="{ backgroundColor: color }"></span>
</div>
<MkA v-else-if="display !== 'bar' && channel" :class="$style.link" :to="to ?? `/channels/${channel.id}`"><i class="ti ti-device-tv"></i> {{ channel.name }}</MkA>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { NotePlacement } from '@/utility/multi-note.js';

const props = withDefaults(defineProps<{
	channel?: { id: string; name: string; color: string } | null;
	placements?: readonly NotePlacement[] | null;
	display?: 'bar' | 'link';
	compact?: boolean;
	to?: string;
}>(), { display: 'link', compact: false });

const colors = computed(() => [...new Set((props.placements != null
	? props.placements.filter(item => item.state === 'active')
		.sort((left, right) => left.origin.localeCompare(right.origin, 'en') || left.channelId.localeCompare(right.channelId, 'en'))
		.map(item => item.color)
	: [props.channel?.color])
	.filter((color): color is string => typeof color === 'string' && color.trim() !== '')
	.map(color => {
		const value = color.trim();
		if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) return value;
		const hex = value.slice(1).toLowerCase();
		return '#' + (hex.length === 3 ? [...hex].map(char => char + char).join('') : hex);
	}))].slice(0, 3));
</script>

<style lang="scss" module>
.bar {
	display: flex;
	flex-direction: column;
	position: absolute;
	top: 8px;
	left: 8px;
	width: 5px;
	height: calc(100% - 16px);
	border-radius: 999px;
	overflow: hidden;
	pointer-events: none;
}
.segment { flex: 1; min-height: 0; }
.bar.compact { height: calc(100% - 6px); }
.link { opacity: 0.7; font-size: 80%; }
@container (max-width: 350px) {
	.bar { top: 6px; left: 6px; width: 4px; height: calc(100% - 12px); }
}
</style>
