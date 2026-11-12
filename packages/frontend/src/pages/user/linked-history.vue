<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.root" :aria-busy="loading">
	<div v-for="note in displayedNotes" :key="note.id" :class="$style.entry">
		<div :class="$style.origin">{{ i18n.tsx._gridspace.postedOn({ host: note.user.host ?? host }) }}</div>
		<MkNote :note="note" :withHardMute="true"/>
	</div>
	<div v-if="error" role="status" :class="$style.status">
		<p>{{ error === 'PEER_UNAVAILABLE' ? i18n.ts._gridspace.historyPeerUnavailable : error === 'INVALID_CURSOR' || error === 'LINK_UNAVAILABLE' ? i18n.ts._gridspace.historyChanged : i18n.ts.somethingHappened }}</p>
		<MkButton @click="error === 'PEER_UNAVAILABLE' ? load() : reload()">{{ i18n.ts.retry }}</MkButton>
	</div>
	<MkLoading v-else-if="loading"/>
	<p v-else-if="displayedNotes.length === 0 && !hasMore" :class="$style.status">{{ i18n.ts.noNotes }}</p>
	<div v-if="hasMore && !error && !loading" ref="sentinel" :class="$style.status">
		<MkButton :disabled="loading" @click="load">{{ i18n.ts.loadMore }}</MkButton>
	</div>
</div>
</template>

<script lang="ts" setup>
import { ref, computed, watch, onBeforeUnmount, useTemplateRef } from 'vue';
import * as Misskey from 'misskey-js';
import MkNote from '@/components/MkNote.vue';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import { host } from '@@/js/config.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { useGlobalEvent } from '@/events.js';
import { prefer } from '@/preferences.js';
import { $i } from '@/i.js';
import { checkNoteWordMute } from '@/composables/use-note.js';

const props = defineProps<{
	userId: string;
	withReplies: boolean;
	withRenotes: boolean;
	withFiles: boolean;
	withChannelNotes: boolean;
}>();
const emit = defineEmits<{ (event: 'unavailable'): void }>();

const notes = ref<Misskey.entities.Note[]>([]);
const displayedNotes = computed(() => notes.value.filter(note => !$i || !checkNoteWordMute(Misskey.note.isPureRenote(note) ? note.renote ?? note : note, $i, $i.hardMutedWords)));
const loading = ref(false);
const error = ref<string | null>(null);
const hasMore = ref(true);
const sentinel = useTemplateRef('sentinel');
let cursor: string | undefined;
let generation = 0;
let observer: IntersectionObserver | undefined;

async function load() {
	if (loading.value || !hasMore.value) return;
	const current = generation;
	loading.value = true;
	error.value = null;
	try {
		const page = await misskeyApi('gridspace/history', { ...props, limit: 10, cursor });
		if (current !== generation) return;
		const seen = new Set(notes.value.map(note => note.id));
		notes.value.push(...page.notes.filter(note => !seen.has(note.id)));
		cursor = page.cursor ?? undefined;
		hasMore.value = page.cursor != null;
	} catch (err) {
		if (current !== generation) return;
		error.value = (err as { info?: { reason?: string } }).info?.reason ?? 'UNKNOWN';
		if (error.value === 'LINK_UNAVAILABLE') emit('unavailable');
	} finally {
		if (current === generation) loading.value = false;
	}
}

async function reload() {
	generation++;
	notes.value = [];
	cursor = undefined;
	hasMore.value = true;
	loading.value = false;
	await load();
}

watch(() => [props.userId, props.withReplies, props.withRenotes, props.withFiles, props.withChannelNotes], reload, { immediate: true });
watch([sentinel, prefer.r.enableInfiniteScroll], ([element, enabled]) => {
	observer?.disconnect();
	if (!element || !enabled) return;
	observer = new IntersectionObserver(entries => {
		if (entries.some(entry => entry.isIntersecting) && !error.value) void load();
	}, { rootMargin: '200px' });
	observer.observe(element);
});
onBeforeUnmount(() => { generation++; observer?.disconnect(); });
useGlobalEvent('noteDeleted', id => { notes.value = notes.value.filter(note => note.id !== id); });
defineExpose({ reload });
</script>

<style lang="scss" module>
.root {
	background: var(--MI_THEME-panel);
	border-radius: var(--MI-radius);
	overflow: clip;
}
.entry {
	border-bottom: solid 0.5px var(--MI_THEME-divider);
}
.origin {
	padding: 12px 24px 0;
	font-size: 0.8em;
	color: var(--MI_THEME-fgTransparentWeak);
	overflow-wrap: anywhere;
}
.status {
	padding: 20px;
}
</style>
