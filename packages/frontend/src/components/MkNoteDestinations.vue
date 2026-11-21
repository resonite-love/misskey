<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<fieldset :class="$style.root" :disabled="disabled">
	<legend>{{ i18n.ts._multiNote.destinations }}</legend>
	<div :class="$style.row">
		<label :class="$style.chip"><input type="checkbox" :checked="model.includeDefault" @change="model = { ...model, includeDefault: !model.includeDefault }">{{ i18n.ts._multiNote.defaultDestination }}</label>
		<button v-for="item in visibleChannels" :key="channelKey(item)" type="button" class="_button" :class="$style.chip" :title="item.name + ' · ' + item.origin" :aria-label="i18n.tsx._multiNote.removeSelection({ name: item.name + ' · ' + siteName(item.origin) })" @click="toggle(item)">
			<i class="ti ti-device-tv" :style="{ color: item.color }" aria-hidden="true"></i>
			<span :class="$style.name">{{ item.name }}</span><small :class="$style.site" :title="item.origin">{{ siteName(item.origin) }}</small>
			<i class="ti ti-x" aria-hidden="true"></i>
		</button>
		<button v-if="model.channels.length > 3" type="button" class="_textButton" :aria-expanded="expanded" @click="expanded = !expanded">{{ expanded ? i18n.ts.showLess : i18n.tsx._multiNote.moreChannels({ count: model.channels.length - 3 }) }}</button>
		<button type="button" class="_textButton" :aria-expanded="open" @click="open = !open"><i class="ti ti-plus" aria-hidden="true"></i> {{ i18n.ts._multiNote.chooseChannels }}</button>
	</div>
	<div v-if="open" :class="$style.picker">
		<div :class="$style.filters">
			<MkButton small :disabled="disabled" aria-haspopup="menu" :aria-expanded="menuOpen" :aria-label="i18n.ts._multiNote.channelList + ' · ' + groupLabel" @click="chooseGroup">
				{{ groupLabel }} <i class="ti ti-chevron-down" aria-hidden="true"></i>
			</MkButton>
			<MkInput v-if="group === 'search'" v-model="query" type="search" small :disabled="disabled" :ariaLabel="i18n.ts.search" :placeholder="i18n.ts.search">
				<template #prefix><i class="ti ti-search" aria-hidden="true"></i></template>
			</MkInput>
		</div>
		<div :class="$style.results">
			<label v-for="item in candidates" :key="channelKey(item)" :class="$style.option" :title="item.name + ' · ' + item.origin">
				<input type="checkbox" :checked="model.channels.some(selected => sameChannel(selected, item))" @change="toggle(item)">
				<i class="ti ti-device-tv" :style="{ color: item.color }" aria-hidden="true"></i>
				<span :class="$style.name">{{ item.name }}</span>
				<small :class="$style.site" :title="item.origin">{{ siteName(item.origin) }}</small>
				<small v-if="item.isSensitive" :class="$style.sensitive" :title="i18n.ts._gridspace.channelSensitive">{{ i18n.ts._gridspace.channelSensitive }}</small>
			</label>
		</div>
		<div v-if="empty" :class="$style.row" role="status">
			<span>{{ i18n.ts.noResults }}</span>
			<button v-if="group === 'favorite'" type="button" class="_textButton" @click="group = 'search'">{{ i18n.ts.search }}</button>
		</div>
		<div v-if="busy && !disabled" role="status" :aria-label="i18n.ts.loading"><MkLoading inline mini/></div>
		<div v-if="hasFailed || hasMore" :class="$style.row">
			<span v-if="hasFailed" role="status">{{ i18n.ts.somethingHappened }}</span>
			<button type="button" class="_textButton" :disabled="disabled || busy" @click="loadNext">
				<i :class="hasMore ? 'ti ti-chevron-down' : 'ti ti-refresh'" aria-hidden="true"></i>
				{{ hasMore ? i18n.ts.loadMore : i18n.ts.retry }}
			</button>
		</div>
	</div>
	<p v-if="!model.channels.length && !model.includeDefault" role="status">{{ i18n.ts._multiNote.noDestinations }}</p>
	<p v-else-if="model.channels.length && visibility !== 'public'" role="status">{{ i18n.ts._multiNote.requiresPublic }}</p>
	<p v-else-if="model.includeDefault && model.channels.some(item => item.allowRenoteToExternal === false)" role="status">{{ i18n.ts._multiNote.externalRenoteRestricted }}</p>
	<p v-else-if="!model.includeDefault">{{ i18n.ts._multiNote.channelOnly }}</p>
	<p v-else-if="model.channels.length">{{ localOnly ? i18n.tsx._multiNote.mixedLocal({ count: model.channels.length }) : i18n.tsx._multiNote.mixedFederated({ count: model.channels.length }) }}</p>
</fieldset>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import MkInput from '@/components/MkInput.vue';
import MkButton from '@/components/MkButton.vue';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { sameChannel } from '@/utility/multi-note.js';
import type { NoteDestinations, PostingChannel } from '@/utility/multi-note.js';

const props = defineProps<{ visibility: string; disabled?: boolean; localOnly?: boolean; localOrigin: string; peerEnabled?: boolean; token?: string }>();
const model = defineModel<NoteDestinations>({ required: true });
const open = ref(false);
const expanded = ref(false);
const query = ref('');
type Side = 'local' | 'peer';
type Group = 'favorite' | 'following' | 'featured' | 'search';
type CandidatePage = { items: PostingChannel[]; status: 'idle' | 'loading' | 'ready' | 'failed'; next?: string };

const group = ref<Group>('favorite');
const groups = computed(() => [
	{ value: 'favorite', label: i18n.ts.favorites },
	{ value: 'following', label: i18n.ts._channel.following },
	{ value: 'featured', label: i18n.ts._channel.featured },
	{ value: 'search', label: i18n.ts.search },
] satisfies { value: Group; label: string }[]);
const groupLabel = computed(() => groups.value.find(item => item.value === group.value)!.label);
const menuOpen = ref(false);

function chooseGroup(event: MouseEvent) {
	if (props.disabled || menuOpen.value) return;
	menuOpen.value = true;
	os.popupMenu(groups.value.map(item => ({
		text: item.label,
		caption: item.value === group.value ? i18n.ts.inUse : undefined,
		active: computed(() => item.value === group.value),
		action: () => { if (open.value && !props.disabled) group.value = item.value; },
	})), event.currentTarget, { onClosing: () => { menuOpen.value = false; } });
}

const sides = computed<Side[]>(() => props.peerEnabled ? ['local', 'peer'] : ['local']);

function initialPages(): Record<Side, CandidatePage> {
	return { local: { items: [], status: 'idle' }, peer: { items: [], status: 'idle' } };
}

const pages = ref(initialPages());
const busy = computed(() => sides.value.some(side => ['idle', 'loading'].includes(pages.value[side].status)));
const hasFailed = computed(() => sides.value.some(side => pages.value[side].status === 'failed'));
const hasMore = computed(() => sides.value.some(side => pages.value[side].status !== 'failed' && pages.value[side].next));
const empty = computed(() => sides.value.every(side => {
	const page = pages.value[side];
	return page.status === 'ready' && !page.items.length && !page.next;
}));
const candidates = computed(() => {
	const items: PostingChannel[] = [];
	const lists = sides.value.map(side => pages.value[side].items);
	const length = Math.max(...lists.map(list => list.length));
	for (let rank = 0; rank < length; rank++) {
		for (const list of lists) {
			const item = list[rank];
			if (item) items.push(item);
		}
	}
	return items;
});
const visibleChannels = computed(() => expanded.value ? model.value.channels : model.value.channels.slice(0, 3));
let generation = 0;

function channelKey(item: PostingChannel): string {
	return JSON.stringify([item.origin, item.channelId]);
}

function siteName(origin: string): string {
	return origin === props.localOrigin ? i18n.ts._multiNote.localSiteName : i18n.ts._multiNote.peerSiteName;
}

function toggle(channel: PostingChannel) {
	if (props.disabled) return;
	const channels = model.value.channels;
	model.value = { ...model.value, channels: channels.some(item => sameChannel(item, channel))
		? channels.filter(item => !sameChannel(item, channel)) : [...channels, channel] };
}

async function loadNext() {
	if (!open.value || props.disabled || busy.value) return;
	const targets = sides.value.filter(side => pages.value[side].status === 'failed' || pages.value[side].next);
	await Promise.allSettled(targets.map(side => load(side)));
}

async function load(side: Side) {
	const page = pages.value[side];
	if (!open.value || props.disabled || !sides.value.includes(side) || page.status === 'loading') return;
	const current = generation;
	const cursor = page.next;
	page.status = 'loading';
	try {
		let origin = props.localOrigin;
		let channels;
		let next;
		if (side === 'peer') {
			const response = await misskeyApi('gridspace/multi-note/channels', { list: group.value, query: group.value === 'search' ? query.value.trim() : undefined, limit: 20, before: cursor }, props.token);
			if (!response.enabled) throw new Error(i18n.ts._gridspace.channelsUnavailable);
			origin = new URL(response.origin).origin;
			channels = response.channels;
			next = response.next ?? undefined;
		} else {
			const params = { limit: 20, untilId: cursor };
			switch (group.value) {
				case 'featured': channels = await misskeyApi('channels/featured', {}, props.token); break;
				case 'following': channels = await misskeyApi('channels/followed', params, props.token); break;
				case 'favorite': channels = await misskeyApi('channels/my-favorites', {}, props.token); break;
				case 'search': channels = await misskeyApi('channels/search', { ...params, query: query.value.trim() }, props.token); break;
			}
			next = (group.value === 'search' || group.value === 'following') && channels.length === 20 ? channels.at(-1)?.id : undefined;
		}
		if (current !== generation) return;
		const seen = new Set(page.items.map(channelKey));
		for (const item of channels) {
			const channel = { origin, channelId: item.id, name: item.name, color: item.color, isSensitive: item.isSensitive,
				allowRenoteToExternal: 'allowRenoteToExternal' in item ? item.allowRenoteToExternal : undefined };
			const key = channelKey(channel);
			if (item.isArchived || seen.has(key)) continue;
			seen.add(key);
			page.items.push(channel);
		}
		page.next = next !== cursor ? next : undefined;
		page.status = 'ready';
	} catch {
		if (current === generation) page.status = 'failed';
	}
}

watch([open, group, query, () => props.localOrigin, () => props.token, sides, () => props.disabled], (_, previous, onCleanup) => {
	generation++;
	pages.value = initialPages();
	if (!open.value || props.disabled) return;
	const loadBoth = () => { for (const side of sides.value) void load(side); };
	if (group.value === 'search' && query.value !== previous[2]) {
		const timer = window.setTimeout(loadBoth, 180);
		onCleanup(() => window.clearTimeout(timer));
	} else {
		loadBoth();
	}
}, { flush: 'sync' });
onBeforeUnmount(() => { generation++; });
</script>

<style lang="scss" module>
.root {
	min-width: 0;
	margin: 0 16px;
	padding: 4px 0 8px;
	border: 0;
	font-size: .9em;

	legend { font-weight: bold; }
	p { margin: 8px 0 0; }
}

.row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.chip { display: inline-flex; align-items: center; max-width: 100%; gap: 4px; padding: 3px 8px; border-radius: 12px; background: var(--MI_THEME-buttonBg); overflow-wrap: anywhere; }
.picker { display: grid; gap: 8px; margin-top: 8px; }
.filters { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
.filters > :last-child:not(:first-child) { flex: 1 1 10em; min-width: 0; }
.results { display: grid; max-height: 14em; overflow-y: auto; }
.results:empty, .picker > .row:empty { display: none; }
.option { display: flex; align-items: center; min-width: 0; gap: 6px; white-space: nowrap; padding: 5px 4px; cursor: pointer; border-radius: var(--MI-radius); }
.option:hover, .option:focus-within { background: var(--MI_THEME-buttonBg); }
.name, .sensitive { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.site { flex: none; padding: 1px 5px; border: 1px solid var(--MI_THEME-divider); border-radius: 4px; background: var(--MI_THEME-buttonBg); font-size: .8em; line-height: 1.2; white-space: nowrap; }
.sensitive { color: var(--MI_THEME-fgTransparentWeak); }
</style>
