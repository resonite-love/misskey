<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<component :is="prefer.s.enablePullToRefresh ? MkPullToRefresh : 'div'" :refresher="() => reloadTimeline()">
	<MkLoading v-if="isFetching"/>

	<MkError v-else-if="paginator1.error.value" @retry="init()"/>

	<div v-else-if="mergedItems.length === 0" key="_empty_">
		<slot name="empty">
			<MkResult type="empty" :text="i18n.ts.noNotes"/>
		</slot>
	</div>

	<div v-else ref="rootEl">
		<div v-if="queuedCount > 0" :class="$style.new">
			<div :class="$style.newBg1"></div>
			<div :class="$style.newBg2"></div>
			<button class="_button" :class="$style.newButton" @click="releaseQueue()">
				<i class="ti ti-circle-arrow-up"></i>
				{{ i18n.ts.newNote }}
			</button>
		</div>
		<component
			:is="prefer.s.animation ? TransitionGroup : 'div'"
			:class="$style.notes"
			:enterActiveClass="$style.transition_x_enterActive"
			:leaveActiveClass="$style.transition_x_leaveActive"
			:enterFromClass="$style.transition_x_enterFrom"
			:leaveToClass="$style.transition_x_leaveTo"
			:moveClass="$style.transition_x_move"
			tag="div"
		>
			<template v-for="(note, i) in mergedItems" :key="note.id">
				<div
					v-if="i > 0 && isSeparatorNeeded(mergedItems[i -1].createdAt, note.createdAt)"
					:data-scroll-anchor="note.id"
				>
					<div :class="$style.date">
						<span><i class="ti ti-chevron-up"></i> {{
							getSeparatorInfo(mergedItems[i - 1].createdAt, note.createdAt)?.prevText
						}}</span>
						<span style="height: 1em; width: 1px; background: var(--MI_THEME-divider);"></span>
						<span>{{ getSeparatorInfo(mergedItems[i - 1].createdAt, note.createdAt)?.nextText }} <i
							class="ti ti-chevron-down"
						></i></span>
					</div>
					<MkNote :class="$style.note" :note="note" :withHardMute="true"/>
				</div>
				<div v-else-if="note._shouldInsertAd_" :data-scroll-anchor="note.id">
					<MkNote :class="$style.note" :note="note" :withHardMute="true"/>
					<div :class="$style.ad">
						<MkAd :preferForms="['horizontal', 'horizontal-big']"/>
					</div>
				</div>
				<MkNote v-else :class="$style.note" :note="note" :withHardMute="true" :data-scroll-anchor="note.id"/>
			</template>
		</component>
		<button
			v-show="canFetchOlder" key="_more_"
			v-appear="prefer.s.enableInfiniteScroll ? fetchOlder : null"
			:disabled="fetchingOlder" class="_button" :class="$style.more"
			@click="fetchOlder"
		>
			<div v-if="!fetchingOlder">{{ i18n.ts.loadMore }}</div>
			<MkLoading v-else :inline="true"/>
		</button>
	</div>
</component>
</template>

<script lang="ts" setup>
import {
	computed,
	watch,
	onUnmounted,
	provide,
	useTemplateRef,
	TransitionGroup,
	onMounted,
	shallowRef,
	ref,
	markRaw,
} from 'vue';
import * as Misskey from 'misskey-js';
import { useInterval } from '@@/js/use-interval.js';
import { useDocumentVisibility } from '@@/js/use-document-visibility.js';
import { getScrollContainer, scrollToTop } from '@@/js/scroll.js';
import type { SoundStore } from '@/preferences/def.js';
import type { MisskeyEntity } from '@/utility/paginator.js';
import MkPullToRefresh from '@/components/MkPullToRefresh.vue';
import { useStream } from '@/stream.js';
import * as sound from '@/utility/sound.js';
import { $i } from '@/i.js';
import { instance } from '@/instance.js';
import { prefer } from '@/preferences.js';
import { store } from '@/store.js';
import MkNote from '@/components/MkNote.vue';
import { i18n } from '@/i18n.js';
import { useGlobalEvent } from '@/events.js';
import { isSeparatorNeeded, getSeparatorInfo } from '@/utility/timeline-date-separate.js';
import { Paginator } from '@/utility/paginator.js';

const props = withDefaults(defineProps<{
	sound?: boolean;
	customSound?: SoundStore | null;
	withRenotes?: boolean;
	withReplies?: boolean;
	withSensitive?: boolean;
	onlyFiles?: boolean;
	withLocalOnly?: boolean;
}>(), {
	withRenotes: true,
	withReplies: false,
	withSensitive: true,
	onlyFiles: false,
	withLocalOnly: true,
	sound: false,
	customSound: null,
});

const rlRelayHosts = [
	'misskey.kontovr.site',
	'kawane.misskey.online',
	'misskey.natsuneko.com',
	'okinosan.net',
	'ningen.ahoaho.jp',
	'mi.harumakizaemon.net',
	'misskey.resonite.love',
	'pl.ijs01140.dev',
];

provide('inTimeline', true);
provide('tl_withSensitive', computed(() => props.withSensitive));
provide('inChannel', false);

// Paginator 1: hybrid-timeline (ホーム+ローカル)
// minItemsToShow: 1で1件取れたら即表示
const paginator1 = markRaw(new Paginator('notes/hybrid-timeline', {
	minItemsToShow: 1,
	computedParams: computed(() => ({
		withRenotes: props.withRenotes,
		withReplies: props.withReplies,
		withFiles: props.onlyFiles ? true : undefined,
	})),
	useShallowRef: true,
}));

// Paginator 2: global-timeline (rlRelayHostsのみ、ローカル除外)
// limit: 100で多く取得、minItemsToShow: 1で1件でも取れたら即表示
const paginator2 = markRaw(new Paginator('notes/global-timeline', {
	limit: 100,
	minItemsToShow: 1,
	computedParams: computed(() => ({
		withRenotes: props.withRenotes,
		withFiles: props.onlyFiles ? true : undefined,
	})),
	useShallowRef: true,
	customFilter: (notes: any[]) => {
		return notes.filter(note => note.user?.host != null && rlRelayHosts.includes(note.user.host));
	},
}));

type NoteWithMeta = Misskey.entities.Note & MisskeyEntity;

// マージしたitems
const mergedItems = computed(() => {
	const items1 = paginator1.items.value as NoteWithMeta[];
	const items2 = paginator2.items.value as NoteWithMeta[];
	const seenIds = new Set<string>();
	const merged: NoteWithMeta[] = [];

	for (const note of [...items1, ...items2]) {
		if (!seenIds.has(note.id)) {
			seenIds.add(note.id);
			merged.push(note);
		}
	}

	merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
	return merged;
});

// hybrid-timelineが取得できたら先に表示（GTLフィルターは遅いので待たない）
const isFetching = computed(() => paginator1.fetching.value);
const queuedCount = computed(() => paginator1.queuedAheadItemsCount.value + paginator2.queuedAheadItemsCount.value);
const canFetchOlder = computed(() => paginator1.canFetchOlder.value || paginator2.canFetchOlder.value);
const fetchingOlder = computed(() => paginator1.fetchingOlder.value || paginator2.fetchingOlder.value);

function init() {
	paginator1.init();
	paginator2.init();
}

onMounted(() => {
	init();

	if (paginator1.computedParams) {
		watch(paginator1.computedParams, () => paginator1.reload(), { immediate: false, deep: true });
	}
	if (paginator2.computedParams) {
		watch(paginator2.computedParams, () => paginator2.reload(), { immediate: false, deep: true });
	}
});

function isTop() {
	if (scrollContainer == null) return true;
	if (rootEl.value == null) return true;
	const scrollTop = scrollContainer.scrollTop;
	const tlTop = rootEl.value.offsetTop - scrollContainer.offsetTop;
	return scrollTop <= tlTop;
}

let scrollContainer: HTMLElement | null = null;

function onScrollContainerScroll() {
	if (isTop()) {
		paginator1.releaseQueue();
		paginator2.releaseQueue();
	}
}

const rootEl = useTemplateRef('rootEl');
watch(rootEl, (el) => {
	if (el && scrollContainer == null) {
		scrollContainer = getScrollContainer(el);
		if (scrollContainer == null) return;
		scrollContainer.addEventListener('scroll', onScrollContainerScroll, { passive: true });
	}
}, { immediate: true });

onUnmounted(() => {
	if (scrollContainer) {
		scrollContainer.removeEventListener('scroll', onScrollContainerScroll);
	}
});

const visibility = useDocumentVisibility();
let isPausingUpdate = false;

watch(visibility, () => {
	if (visibility.value === 'hidden') {
		isPausingUpdate = true;
	} else {
		isPausingUpdate = false;
		if (isTop()) {
			releaseQueue();
		}
	}
});

let adInsertionCounter = 0;

const MIN_POLLING_INTERVAL = 1000 * 10;
const POLLING_INTERVAL =
	prefer.s.pollingInterval === 1 ? MIN_POLLING_INTERVAL * 1.5 * 1.5 :
	prefer.s.pollingInterval === 2 ? MIN_POLLING_INTERVAL * 1.5 :
	prefer.s.pollingInterval === 3 ? MIN_POLLING_INTERVAL :
	MIN_POLLING_INTERVAL;

if (!store.s.realtimeMode) {
	useInterval(async () => {
		paginator1.fetchNewer({ toQueue: !isTop() || isPausingUpdate });
		paginator2.fetchNewer({ toQueue: !isTop() || isPausingUpdate });
	}, POLLING_INTERVAL, {
		immediate: false,
		afterMounted: true,
	});

	useGlobalEvent('notePosted', () => {
		paginator1.fetchNewer({ toQueue: !isTop() || isPausingUpdate });
		paginator2.fetchNewer({ toQueue: !isTop() || isPausingUpdate });
	});
}

useGlobalEvent('noteDeleted', (noteId) => {
	paginator1.removeItem(noteId);
	paginator2.removeItem(noteId);
});

function releaseQueue() {
	paginator1.releaseQueue();
	paginator2.releaseQueue();
	scrollToTop(rootEl.value!);
}

function fetchOlder() {
	paginator1.fetchOlder();
	paginator2.fetchOlder();
}

function prepend(note: Misskey.entities.Note & MisskeyEntity, toPaginator: 1 | 2) {
	adInsertionCounter++;

	if (instance.notesPerOneAd > 0 && adInsertionCounter % instance.notesPerOneAd === 0) {
		note._shouldInsertAd_ = true;
	}

	const paginator = toPaginator === 1 ? paginator1 : paginator2;

	if (isTop() && !isPausingUpdate) {
		paginator.prepend(note);
	} else {
		paginator.enqueue(note);
	}

	if (props.sound) {
		if (props.customSound) {
			sound.playMisskeySfxFile(props.customSound);
		} else {
			sound.playMisskeySfx($i && (note.userId === $i.id) ? 'noteMy' : 'note');
		}
	}
}

const stream = store.s.realtimeMode ? useStream() : null;

const connections = {
	hybridTimeline: null as Misskey.IChannelConnection<Misskey.Channels['hybridTimeline']> | null,
	globalTimeline: null as Misskey.IChannelConnection<Misskey.Channels['globalTimeline']> | null,
};

function connectChannel() {
	if (stream == null) return;

	// hybridTimeline: ホーム+ローカル
	connections.hybridTimeline = stream.useChannel('hybridTimeline', {
		withRenotes: props.withRenotes,
		withReplies: props.withReplies,
		withFiles: props.onlyFiles ? true : undefined,
	});
	connections.hybridTimeline.on('note', (note) => prepend(note, 1));

	// globalTimeline: rlRelayHostsのみ（ローカル除外）
	connections.globalTimeline = stream.useChannel('globalTimeline', {
		withRenotes: props.withRenotes,
		withFiles: props.onlyFiles ? true : undefined,
	});
	connections.globalTimeline.on('note', (note) => {
		if (note.user?.host != null && rlRelayHosts.includes(note.user.host)) {
			prepend(note, 2);
		}
	});
}

function disconnectChannel() {
	if (connections.hybridTimeline) {
		connections.hybridTimeline.dispose();
		connections.hybridTimeline = null;
	}
	if (connections.globalTimeline) {
		connections.globalTimeline.dispose();
		connections.globalTimeline = null;
	}
}

if (store.s.realtimeMode) {
	connectChannel();
}

watch(() => props.withSensitive, reloadTimeline);

onUnmounted(() => {
	disconnectChannel();
});

function reloadTimeline() {
	return new Promise<void>((res) => {
		adInsertionCounter = 0;
		Promise.all([paginator1.reload(), paginator2.reload()]).then(() => res());
	});
}

defineExpose({
	reloadTimeline,
});
</script>

<style lang="scss" module>
.transition_x_move {
	transition: transform 0.7s cubic-bezier(0.23, 1, 0.32, 1);
}

.transition_x_enterActive {
	transition: transform 0.7s cubic-bezier(0.23, 1, 0.32, 1), opacity 0.7s cubic-bezier(0.23, 1, 0.32, 1);

	&.note,
	.note {
		content-visibility: visible !important;
	}
}

.transition_x_leaveActive {
	transition: height 0.2s cubic-bezier(0, .5, .5, 1), opacity 0.2s cubic-bezier(0, .5, .5, 1);
}

.transition_x_enterFrom {
	opacity: 0;
	transform: translateY(max(-64px, -100%));
}

@supports (interpolate-size: allow-keywords) {
	.transition_x_leaveTo {
		interpolate-size: allow-keywords;
		height: 0;
	}
}

.transition_x_leaveTo {
	opacity: 0;
}

.notes {
	container-type: inline-size;
	background: var(--MI_THEME-panel);
}

.note:not(:empty) {
	border-bottom: solid 0.5px var(--MI_THEME-divider);
}

.new {
	--gapFill: 0.5px;
	position: sticky;
	top: calc(var(--MI-stickyTop, 0px) - var(--gapFill));
	z-index: 1000;
	width: 100%;
	box-sizing: border-box;
	padding: calc(10px + var(--gapFill)) 0 10px 0;
}

.newBg1, .newBg2 {
	position: absolute;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
}

.newBg1 {
	height: 100%;
	-webkit-backdrop-filter: var(--MI-blur, blur(2px));
	backdrop-filter: var(--MI-blur, blur(2px));
	mask-image: linear-gradient(
		to top,
		rgb(0 0 0 / 0%) 0%,
		rgb(0 0 0 / 4.9%) 7.75%,
		rgb(0 0 0 / 10.4%) 11.25%,
		rgb(0 0 0 / 45%) 23.55%,
		rgb(0 0 0 / 55%) 26.45%,
		rgb(0 0 0 / 89.6%) 38.75%,
		rgb(0 0 0 / 95.1%) 42.25%,
		rgb(0 0 0 / 100%) 50%
	);
}

.newBg2 {
	height: 75%;
	-webkit-backdrop-filter: var(--MI-blur, blur(4px));
	backdrop-filter: var(--MI-blur, blur(4px));
	mask-image: linear-gradient(
		to top,
		rgb(0 0 0 / 0%) 0%,
		rgb(0 0 0 / 4.9%) 15.5%,
		rgb(0 0 0 / 10.4%) 22.5%,
		rgb(0 0 0 / 45%) 47.1%,
		rgb(0 0 0 / 55%) 52.9%,
		rgb(0 0 0 / 89.6%) 77.5%,
		rgb(0 0 0 / 95.1%) 91.9%,
		rgb(0 0 0 / 100%) 100%
	);
}

.newButton {
	position: relative;
	display: block;
	padding: 6px 12px;
	border-radius: 999px;
	width: max-content;
	margin: auto;
	background: var(--MI_THEME-accent);
	color: var(--MI_THEME-fgOnAccent);
	font-size: 90%;

	&:hover {
		background: hsl(from var(--MI_THEME-accent) h s calc(l + 5));
	}

	&:active {
		background: hsl(from var(--MI_THEME-accent) h s calc(l - 5));
	}
}

.date {
	display: flex;
	font-size: 85%;
	align-items: center;
	justify-content: center;
	gap: 1em;
	padding: 8px 8px;
	margin: 0 auto;
	border-bottom: solid 0.5px var(--MI_THEME-divider);
}

.ad {
	padding: 8px;
	background-size: auto auto;
	background-image: repeating-linear-gradient(45deg, transparent, transparent 8px, var(--MI_THEME-bg) 8px, var(--MI_THEME-bg) 14px);
	border-bottom: solid 0.5px var(--MI_THEME-divider);

	&:empty {
		display: none;
	}
}

.more {
	display: block;
	width: 100%;
	box-sizing: border-box;
	padding: 16px;
	background: var(--MI_THEME-panel);
}
</style>
