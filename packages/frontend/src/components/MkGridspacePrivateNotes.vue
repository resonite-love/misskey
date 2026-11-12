<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<section v-if="enabled || alwaysShow" class="_panel _gaps_s" :class="$style.root" data-gridspace-private :aria-label="params.channelId ? i18n.ts.channel : i18n.ts._gridspace.privateTitle">
	<div v-if="!plain || !enabled" :class="$style.heading" class="_gaps_s">
		<h2 v-if="!plain" :class="$style.title"><i class="ti ti-lock" aria-hidden="true"></i> {{ i18n.ts._gridspace.privateTitle }}</h2>
		<p v-if="!plain">{{ i18n.ts._gridspace.privateScope }}</p>
		<MkA v-if="!enabled" to="/settings/gridspace">{{ i18n.ts._gridspace.privateAuthorize }}</MkA>
	</div>
	<template v-if="enabled">
		<MkGridspacePrivateNote v-for="note in displayed" :key="note.id" :note="note" @unavailable="fail"/>
		<div :class="$style.heading" class="_gaps_s">
			<p v-if="error" role="alert">{{ i18n.ts._gridspace.privateUnavailable }}</p>
			<MkLoading v-if="loading"/>
			<p v-else-if="!error && notes.length === 0 && !hasMore">{{ i18n.ts.noNotes }}</p>
			<MkButton v-if="error" :disabled="loading" @click="reload">{{ i18n.ts.retry }}</MkButton>
			<MkButton v-else-if="hasMore" :disabled="loading" @click="load">{{ i18n.ts.loadMore }}</MkButton>
		</div>
	</template>
</section>
</template>

<script setup lang="ts">
import { computed, onActivated, onDeactivated, onBeforeUnmount, ref, watch } from 'vue';
import type { entities } from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import MkGridspacePrivateNote from '@/components/MkGridspacePrivateNote.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { $i } from '@/i.js';
import { checkTextWordMute } from '@/utility/check-word-mute.js';

const props = defineProps<{ params: entities.GridspacePrivateNotesRequest; alwaysShow?: boolean; plain?: boolean }>();
type Note = entities.GridspacePrivateNotesResponse['notes'][number];
const enabled = ref(false);
const notes = ref<Note[]>([]);
const displayed = computed(() => notes.value.filter(note => !$i || !checkTextWordMute(`${note.cw ?? ''}\n${note.text ?? ''}`, $i.hardMutedWords)));
const loading = ref(false);
const hasMore = ref(false);
const error = ref(false);
let cursor: string | undefined;
let generation = 0;
let checking = false;
let stopped = false;
let active = true;

function fail() { generation++; notes.value = []; cursor = undefined; hasMore.value = false; loading.value = false; error.value = true; }

async function load() {
	if (loading.value || !hasMore.value || window.document.hidden || !active) return;
	const current = generation;
	loading.value = true;
	try {
		const result = await misskeyApi('gridspace/private-notes', { ...props.params, cursor, limit: 10 }, undefined, AbortSignal.timeout(15000));
		if (current !== generation) return;
		const seen = new Set(notes.value.map(note => note.id));
		notes.value.push(...result.notes.filter(note => !seen.has(note.id)));
		cursor = result.cursor ?? undefined;
		hasMore.value = result.cursor != null;
	} catch { if (current === generation) fail(); } finally { if (current === generation) loading.value = false; }
}

async function reload() {
	const current = ++generation;
	notes.value = []; cursor = undefined; hasMore.value = false; error.value = false; loading.value = false;
	if (!$i || window.document.hidden || !active) return;
	try {
		if (props.params.channelId) { enabled.value = true; hasMore.value = true; await load(); return; }
		const status = await misskeyApi('gridspace/private-grant', { action: 'status' }, undefined, AbortSignal.timeout(15000));
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
async function revalidate() {
	if (checking || !enabled.value || error.value || window.document.hidden || !active) return;
	checking = true;
	const current = generation;
	const snapshot = [...notes.value];
	try {
		const allowed = new Map<string, Note>();
		if (snapshot.length === 0) {
			if (props.params.channelId) await misskeyApi('gridspace/channels', { channelId: props.params.channelId }, undefined, AbortSignal.timeout(15000));
			else {
				const status = await misskeyApi('gridspace/private-grant', { action: 'status' }, undefined, AbortSignal.timeout(15000));
				if (!status.granted || !status.available) throw new Error('Unavailable');
			}
		}
		for (let index = 0; index < snapshot.length; index += 100) {
			const result = await misskeyApi('gridspace/private-notes', { ...props.params, mode: 'validate', contextMode: props.params.mode === 'validate' ? undefined : props.params.mode,
				ids: snapshot.slice(index, index + 100).map(note => note.id), cursor: undefined }, undefined, AbortSignal.timeout(15000));
			if (current !== generation) return;
			for (const note of result.notes) allowed.set(note.id, note);
		}
		if (current !== generation) return;
		const previousIds = new Set(snapshot.map(note => note.id));
		notes.value = notes.value.flatMap(note => previousIds.has(note.id) ? allowed.has(note.id) ? [allowed.get(note.id)!] : [] : [note]);
		if (props.params.mode === 'channel' && !loading.value) {
			const head = await misskeyApi('gridspace/private-notes', { ...props.params, limit: 10 }, undefined, AbortSignal.timeout(15000));
			if (current !== generation || loading.value) return;
			const existing = new Set(notes.value.map(note => note.id));
			if (head.notes.some(note => existing.has(note.id))) {
				notes.value = [...head.notes.filter(note => !existing.has(note.id)), ...notes.value];
			} else {
				// A busy channel may have advanced beyond the loaded head. Restart
				// pagination at the new head instead of silently skipping that gap.
				notes.value = head.notes; cursor = head.cursor ?? undefined; hasMore.value = head.cursor != null;
			}
		}
	} catch { if (current === generation) fail(); } finally { checking = false; }
}

function visibility() {
	if (window.document.hidden) { generation++; notes.value = []; loading.value = false; } else void reload();
}

const timer = window.setInterval(() => { if (!stopped) void revalidate(); }, 15000);
window.document.addEventListener('visibilitychange', visibility);
window.addEventListener('focus', revalidate);
// Parents pass object literals; rerendering an unchanged search must not reset
// the private pages or repeat consent checks.
watch(() => JSON.stringify(Object.entries(props.params).sort(([a], [b]) => a.localeCompare(b))), reload, { immediate: true });
onDeactivated(() => { active = false; generation++; notes.value = []; loading.value = false; });
onActivated(() => { if (!active) { active = true; void reload(); } });
onBeforeUnmount(() => {
	stopped = true; generation++; notes.value = [];
	window.clearInterval(timer);
	window.document.removeEventListener('visibilitychange', visibility);
	window.removeEventListener('focus', revalidate);
});
</script>

<style lang="scss" module>
.root { overflow: clip; }
.heading { padding: 16px; }
.title { font-size: 1em; margin: 0; }
</style>
