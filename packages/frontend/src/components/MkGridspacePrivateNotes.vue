<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<component :is="prefer.s.enablePullToRefresh ? MkPullToRefresh : 'div'" v-if="enabled || alwaysShow" :refresher="reload">
<section ref="root" class="_panel _gaps_s" :class="$style.root" data-gridspace-private :aria-label="params.channelId ? i18n.ts.channel : i18n.ts._gridspace.privateTitle">
	<div v-if="!plain || !enabled" :class="$style.heading" class="_gaps_s">
		<h2 v-if="!plain" :class="$style.title"><i class="ti ti-lock" aria-hidden="true"></i> {{ i18n.ts._gridspace.privateTitle }}</h2>
		<p v-if="!plain">{{ i18n.ts._gridspace.privateScope }}</p>
		<MkA v-if="!enabled" to="/settings/gridspace">{{ i18n.ts._gridspace.privateAuthorize }}</MkA>
	</div>
	<template v-if="enabled">
		<MkButton v-if="queued.length" :class="$style.new" rounded primary @click="releaseQueue(true)">{{ i18n.ts.newNote }}</MkButton>
		<component :is="prefer.s.animation ? TransitionGroup : 'div'" tag="div" :enterActiveClass="$style.enterActive" :enterFromClass="$style.enterFrom" :moveClass="$style.move" @beforeLeave="clearLeavingPrivateNote">
			<MkGridspacePrivateNoteRow v-for="note in displayed" :key="note.id" :note="note" :data-scroll-anchor="note.uri" @unavailable="fail" @replied="refresh"/>
		</component>
		<div :class="$style.heading" class="_gaps_s">
			<p v-if="error" role="alert">{{ params.channelId ? i18n.ts._gridspace.channelNotesUnavailable : i18n.ts._gridspace.privateUnavailable }}</p>
			<MkLoading v-if="loading"/>
			<p v-else-if="!error && notes.length === 0 && !hasMore">{{ i18n.ts.noNotes }}</p>
			<MkButton v-if="error" :disabled="loading" @click="refresh">{{ i18n.ts.retry }}</MkButton>
			<MkButton v-else-if="hasMore" :disabled="loading" @click="load">{{ i18n.ts.loadMore }}</MkButton>
		</div>
	</template>
</section>
</component>
</template>

<script setup lang="ts">
import { computed, onActivated, onDeactivated, onBeforeUnmount, onMounted, ref, useTemplateRef, watch, TransitionGroup } from 'vue';
import { isHeadVisible, onScrollTop, scrollToTop } from '@@/js/scroll.js';
import type { entities } from 'misskey-js';
import type { GridspaceNoteEntry } from '@/utility/gridspace-note-suspension.js';
import MkButton from '@/components/MkButton.vue';
import MkPullToRefresh from '@/components/MkPullToRefresh.vue';
import MkGridspacePrivateNoteRow from '@/components/MkGridspacePrivateNoteRow.vue';
import { prefer } from '@/preferences.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { $i } from '@/i.js';
import { clearLeavingPrivateNote, isRevokedGridspaceRead, isVisiblePrivateNote, suspendPrivateNotes } from '@/utility/gridspace-note-suspension.js';

const props = defineProps<{ params: entities.GridspacePrivateNotesRequest; alwaysShow?: boolean; plain?: boolean }>();
const emit = defineEmits<{ (event: 'loaded'): void }>();
type Note = entities.GridspacePrivateNotesResponse['notes'][number];
const enabled = ref(false);
const notes = ref<GridspaceNoteEntry[]>([]);
const queued = ref<GridspaceNoteEntry[]>([]);
const root = useTemplateRef('root');
let suspended = false;
let lastSync: number | null = null;
let newer: { start: number; cursor?: string; observedAt?: number; notes: GridspaceNoteEntry[] } | null = null;
let controller = new AbortController();
const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
const displayed = computed(() => notes.value.filter(note => isVisiblePrivateNote(note)));
const loading = ref(false);
const hasMore = ref(false);
const error = ref(false);
let cursor: string | undefined;
let generation = 0;
let checking: number | null = null;
let stopped = false;
let active = true;
let retryAt = 0;
let retryDelay = 30000;
let recovering = false;
let refreshPending = false;

function fail() {
	invalidate(); notes.value = []; queued.value = []; newer = null; suspended = false; cursor = undefined; hasMore.value = false; loading.value = false; error.value = true;
	retryAt = Date.now() + retryDelay; retryDelay = Math.min(retryDelay * 2, 120000);
}

function readFailed(err: unknown) {
	if (isRevokedGridspaceRead(err)) { fail(); return; }
	suspend(); error.value = true;
	retryAt = Date.now() + retryDelay; retryDelay = Math.min(retryDelay * 2, 120000);
}

async function load() {
	if (suspended || loading.value || !hasMore.value || window.document.hidden || !active) return;
	const current = generation;
	loading.value = true;
	try {
		const result = await misskeyApi('gridspace/private-notes', { ...props.params, cursor, limit: 10 }, undefined, signal());
		if (current !== generation) return;
		lastSync ??= Date.parse(result.observedAt);
		const seen = new Set(notes.value.map(note => note.id));
		notes.value.push(...result.notes.filter(note => !seen.has(note.id)));
		cursor = result.cursor ?? undefined;
		hasMore.value = result.cursor != null;
		retryDelay = 30000;
		emit('loaded');
	} catch (err) { if (current === generation) readFailed(err); } finally { if (current === generation) loading.value = false; }
}

async function reload() {
	invalidate(); const current = generation;
	suspended = false; lastSync = null; newer = null; queued.value = [];
	notes.value = []; cursor = undefined; hasMore.value = false; error.value = false; loading.value = false;
	if (!$i || window.document.hidden || !active) return;
	try {
		if (props.params.channelId) { enabled.value = true; hasMore.value = true; await load(); return; }
		const status = await misskeyApi('gridspace/private-grant', { action: 'status' }, undefined, signal());
		if (current !== generation) return;
		if (!status.available) { if (status.granted || enabled.value || props.alwaysShow) { enabled.value = true; fail(); } return; }
		enabled.value = status.granted;
		if (!status.granted) return;
		hasMore.value = true;
		await load();
	} catch { if (current === generation && (enabled.value || props.alwaysShow)) { enabled.value = true; fail(); } }
}

// Reauthorize every loaded ID, including pages scrolled out of view. No private
// results are written into the normal note cache, localStorage or IndexedDB.
async function revalidate(retry = false) {
	if (checking != null || !enabled.value || (error.value && !retry) || window.document.hidden || !active) return;
	const current = generation; checking = current;
	const snapshot = [...notes.value, ...queued.value, ...(newer?.notes ?? [])];
	try {
		const allowed = new Map<string, Note>();
		if (snapshot.length === 0) {
			if (props.params.channelId) await misskeyApi('gridspace/channels', { channelId: props.params.channelId }, undefined, signal());
			else {
				const status = await misskeyApi('gridspace/private-grant', { action: 'status' }, undefined, signal());
				if (!status.granted || !status.available) throw new Error('Unavailable');
			}
		}
		for (let index = 0; index < snapshot.length; index += 100) {
			const result = await misskeyApi('gridspace/private-notes', { ...props.params, mode: 'validate', contextMode: props.params.mode === 'validate' ? undefined : props.params.mode,
																																																																ids: snapshot.slice(index, index + 100).map(note => note.id), cursor: undefined }, undefined, signal());
			if (current !== generation) return;
			for (const note of result.notes) allowed.set(note.id, note);
		}
		if (current !== generation) return;
		const previousIds = new Set(snapshot.map(note => note.id));
		const valid = (items: GridspaceNoteEntry[]) => items.flatMap(note => previousIds.has(note.id) ? allowed.has(note.id) ? [allowed.get(note.id)!] : [] : [note]);
		notes.value = valid(notes.value); queued.value = valid(queued.value);
		if (newer) newer.notes = valid(newer.notes);
		suspended = false;
		error.value = false; retryDelay = 30000;
		if (props.params.mode === 'channel' && !loading.value && lastSync != null) {
			newer ??= { start: Math.max(1, lastSync - 1001), notes: [] };
			for (let index = 0; index < 5; index++) {
				const head = await misskeyApi('gridspace/private-notes', { ...props.params, rangeStartAt: newer.start, cursor: newer.cursor, limit: 10 }, undefined, signal());
				if (current !== generation) return;
				newer.observedAt ??= Date.parse(head.observedAt);
				newer.notes.push(...head.notes); newer.cursor = head.cursor ?? undefined;
				if (!head.cursor) {
					const existing = new Set([...notes.value, ...queued.value].map(note => note.id));
					queued.value = [...new Map([...queued.value, ...newer.notes.filter(note => !existing.has(note.id))].map(note => [note.id, note])).values()];
					lastSync = newer.observedAt; newer = null;
					if (root.value && isHeadVisible(root.value)) releaseQueue();
					break;
				}
			}
			emit('loaded');
		}
	} catch (err) { if (current === generation) readFailed(err); } finally {
		if (checking === current) {
			checking = null;
			if (refreshPending) { refreshPending = false; void refresh(); }
		}
	}
}

function invalidate() { generation++; controller.abort(); controller = new AbortController(); checking = null; refreshPending = false; }

function suspend() {
	invalidate(); suspended = true; loading.value = false;
	notes.value = suspendPrivateNotes(notes.value); queued.value = suspendPrivateNotes(queued.value);
	if (newer) newer.notes = suspendPrivateNotes(newer.notes);
}

function releaseQueue(scroll = false) {
	if (suspended || window.document.hidden || !active) return;
	notes.value = [...new Map([...queued.value, ...notes.value].map(note => [note.id, note])).values()]
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
	queued.value = [];
	if (scroll && root.value) scrollToTop(root.value);
}

function visibility() { if (window.document.hidden) suspend(); else focus(); }

let stopScroll: (() => void) | null = null;
onMounted(() => { if (root.value) stopScroll = onScrollTop(root.value, visible => { if (visible) releaseQueue(); }); });

async function recover() {
	if (recovering || loading.value || stopped || !active || window.document.hidden) return;
	recovering = true;
	try { if (notes.value.length) await revalidate(true); else await reload(); } finally { recovering = false; }
}

function focus() {
	if (error.value || !enabled.value || lastSync == null) void recover(); else void revalidate();
}

async function refresh() {
	if (checking != null) { refreshPending = true; return; }
	if (error.value || !enabled.value || lastSync == null) await recover(); else await revalidate();
	releaseQueue(true);
}

const timer = window.setInterval(() => {
	if (stopped) return;
	if (error.value) { if (Date.now() >= retryAt) void recover(); } else void revalidate();
}, 15000);
window.document.addEventListener('visibilitychange', visibility);
window.addEventListener('focus', focus);
// Parents pass object literals; rerendering an unchanged search must not reset
// the private pages or repeat consent checks.
watch(() => JSON.stringify(Object.entries(props.params).sort(([a], [b]) => a.localeCompare(b))), reload, { immediate: true });
onDeactivated(() => { active = false; suspend(); });
onActivated(() => { if (!active) { active = true; focus(); } });
onBeforeUnmount(() => {
	stopped = true; stopScroll?.(); invalidate(); notes.value = []; queued.value = []; newer = null; suspended = false;
	window.clearInterval(timer);
	window.document.removeEventListener('visibilitychange', visibility);
	window.removeEventListener('focus', focus);
});
defineExpose({ refresh });
</script>

<style lang="scss" module>
.root { overflow: clip; }
.new { position: sticky; top: var(--MI-stickyTop, 0px); margin-inline: auto; z-index: 1; }
.enterActive { transition: transform 0.7s cubic-bezier(0.23, 1, 0.32, 1), opacity 0.7s cubic-bezier(0.23, 1, 0.32, 1); }
.enterFrom { opacity: 0; transform: translateY(max(-64px, -100%)); }
.move { transition: transform 0.7s cubic-bezier(0.23, 1, 0.32, 1); }
.heading { padding: 16px; }
.title { font-size: 1em; margin: 0; }
</style>
