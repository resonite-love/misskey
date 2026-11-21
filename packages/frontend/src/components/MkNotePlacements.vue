<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.row" :aria-label="i18n.ts._multiNote.placements">
	<template v-if="placements">
		<span v-if="includeDefault" :class="$style.chip">{{ i18n.ts._multiNote.defaultDestination }}</span>
		<template v-for="item in shown" :key="JSON.stringify([item.origin, item.channelId])">
			<MkA v-if="item.state === 'active'" :class="$style.chip" :to="channelPath(item)" @click.stop>
				<i class="ti ti-device-tv" :style="{ color: item.color ?? undefined }" aria-hidden="true"></i> {{ label(item) }}
			</MkA>
			<span v-else :class="$style.chip">{{ label(item) }} · {{ i18n.ts._multiNote[item.state] }}</span>
		</template>
		<button v-if="placements.length > 3" type="button" class="_textButton" :aria-expanded="expanded" @click.stop="expanded = !expanded">
			{{ expanded ? i18n.ts.showLess : i18n.tsx._multiNote.moreChannels({ count: placements.length - 3 }) }}
		</button>
		<small v-if="!unavailable && includeDefault === false && !placements.some(item => ['active', 'pending', 'unavailable'].includes(item.state))">{{ i18n.ts._multiNote.noPlacements }}</small>
	</template>
	<small v-if="!placements || unavailable">{{ i18n.ts._multiNote.unavailable }}</small>
</div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { url } from '@@/js/config.js';
import { i18n } from '@/i18n.js';
import type { NotePlacement } from '@/utility/multi-note.js';

const props = defineProps<{ placements?: readonly NotePlacement[] | null; includeDefault?: boolean | null; unavailable?: boolean }>();
const expanded = ref(false);
const shown = computed(() => expanded.value ? props.placements : props.placements?.slice(0, 3));

function label(item: NotePlacement): string {
	const name = item.name ?? i18n.ts.channel;
	return item.origin === url ? name : `${name} @${new URL(item.origin).host}`;
}

function channelPath(item: NotePlacement): string {
	const id = encodeURIComponent(item.channelId);
	return item.origin === url ? `/channels/${id}` : `/gridspace/channels/${id}?placement=1`;
}
</script>

<style lang="scss" module>
.row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; margin: 4px 0; font-size: .85em; }
.chip { border-radius: 8px; padding: 2px 6px; background: var(--MI_THEME-buttonBg); overflow-wrap: anywhere; }
</style>
