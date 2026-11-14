<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="[$style.root, { [$style.noGap]: noGap, '_gaps': !noGap }]" data-note-list-layout>
	<div v-for="(item, index) in items" :key="getKey(item)" :data-scroll-anchor="getKey(item)" :class="{ '_gaps': !noGap }">
		<div v-if="dateSeparators && index > 0 && isSeparatorNeeded(getDate(items[index - 1]), getDate(item))" :class="[$style.date, { [$style.noGap]: noGap }]">
			<span><i class="ti ti-chevron-up"></i> {{ getSeparatorInfo(getDate(items[index - 1]), getDate(item))?.prevText }}</span>
			<span :class="$style.divider"></span>
			<span>{{ getSeparatorInfo(getDate(items[index - 1]), getDate(item))?.nextText }} <i class="ti ti-chevron-down"></i></span>
		</div>
		<div :class="$style.note" data-note-list-item><slot :item="item"/></div>
		<slot name="after" :item="item"/>
	</div>
</div>
</template>

<script setup lang="ts" generic="T">
import { isSeparatorNeeded, getSeparatorInfo } from '@/utility/timeline-date-separate.js';
withDefaults(defineProps<{ items: readonly T[]; getKey: (item: T) => string; getDate: (item: T) => string; noGap?: boolean; dateSeparators?: boolean }>(), { noGap: false, dateSeparators: true });
</script>

<style lang="scss" module>
.root { container-type: inline-size; background: var(--MI_THEME-bg); }
.note { background: var(--MI_THEME-panel); border-radius: var(--MI-radius); overflow: clip; }
.noGap { background: var(--MI_THEME-panel); }
.noGap .note { border-radius: 0; border-bottom: solid .5px var(--MI_THEME-divider); }
.root:not(.noGap) .note > :deep([data-gridspace-private-row] > [data-gridspace-private-note]) { border-bottom: 0; }
.date { display: flex; font-size: 85%; align-items: center; justify-content: center; gap: 1em; opacity: .75; padding: 8px; margin: 0 auto; }
.date.noGap { border-bottom: solid .5px var(--MI_THEME-divider); }
.divider { height: 1em; width: 1px; background: var(--MI_THEME-divider); }
</style>
