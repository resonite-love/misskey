/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue';
import type { ComputedRef } from 'vue';
import type { entities } from 'misskey-js';
import type { IPaginator } from '@/utility/paginator.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { mergeHomeRows } from '@/utility/gridspace-home-merge.js';
import { checkTextWordMute } from '@/utility/check-word-mute.js';
import { url } from '@@/js/config.js';
import { $i } from '@/i.js';

type PrivateNote = entities.GridspacePrivateNotesResponse['notes'][number];

export function useGridspaceHome(normal: IPaginator<entities.Note>, params: ComputedRef<entities.GridspacePrivateNotesRequest | null>, isTop: () => boolean, withSensitive: ComputedRef<boolean>) {
	const notes = shallowRef<PrivateNote[]>([]);
	const queued = shallowRef<PrivateNote[]>([]);
	const enabled = ref(false);
	const error = ref(false);
	const busy = ref(false);
	const more = ref(false);
	const boundary = ref(Infinity);
	const pagingKey = ref(0);
	let cursor: string | undefined;
	let generation = 0;
	let active = true;
	let polling = false;
	let controller = new AbortController();
	let lastSync: number | null = null;
	let newer: { start: number; observedAt?: number; cursor?: string; notes: PrivateNote[] } | null = null;
	const normalBoundary = computed(() => normal.fetching.value ? Infinity : normal.canFetchOlder.value ? Date.parse(normal.items.value.at(-1)?.createdAt ?? '') || Infinity : -Infinity);
	const rows = computed(() => {
		if (!params.value || !enabled.value || error.value) return normal.items.value.map(note => ({ kind: 'normal' as const, key: note.uri || `${url}/notes/${note.id}`, createdAt: note.createdAt, note }));
		const filtered = notes.value.filter(note => (withSensitive.value || !note.files.some(file => file.isSensitive)) && (!$i || !checkTextWordMute(`${note.cw ?? ''}\n${note.text ?? ''}`, $i.hardMutedWords)));
		return mergeHomeRows(normal.items.value, filtered, url, normalBoundary.value, boundary.value);
	});
	const hasMore = computed(() => normal.canFetchOlder.value || (enabled.value && more.value && !error.value));
	const loading = computed(() => normal.fetchingOlder.value || busy.value);
	const queuedCount = computed(() => queued.value.length + normal.queuedAheadItemsCount.value);
	const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
	const usable = () => active && !window.document.hidden && params.value != null;

	function clear() {
		generation++; controller.abort(); controller = new AbortController();
		notes.value = []; queued.value = []; newer = null; cursor = undefined; more.value = false; boundary.value = Infinity; busy.value = false;
	}

	function fail() { clear(); error.value = true; }

	function releaseQueue() {
		notes.value = [...new Map([...notes.value, ...queued.value].map(note => [note.uri, note])).values()];
		queued.value = [];
	}

	async function loadOld() {
		if (!usable() || busy.value || !more.value || error.value) return;
		const current = generation; busy.value = true;
		try {
			const result = await misskeyApi('gridspace/private-notes', { ...params.value!, cursor, limit: 20 }, undefined, signal());
			if (current !== generation) return;
			const time = result.scannedThrough == null ? NaN : Date.parse(result.scannedThrough);
			if (result.cursor && !Number.isFinite(time)) throw new Error('Invalid scan boundary');
			lastSync ??= Date.parse(result.observedAt);
			notes.value = [...new Map([...notes.value, ...result.notes].map(note => [note.uri, note])).values()];
			cursor = result.cursor ?? undefined; more.value = result.cursor != null;
			boundary.value = more.value ? time : -Infinity;
		} catch { if (current === generation) fail(); } finally { if (current === generation) busy.value = false; }
	}

	async function reload() {
		clear(); error.value = false; enabled.value = false; lastSync = null;
		if (!usable() || !$i) return;
		const current = generation;
		try {
			const status = await misskeyApi('gridspace/private-grant', {}, undefined, signal());
			if (current !== generation) return;
			if (!status.available) { if (status.granted) fail(); return; }
			enabled.value = status.granted;
			if (enabled.value) { more.value = true; await loadOld(); }
		} catch { if (current === generation) fail(); }
	}

	async function fetchOlder() {
		if (loading.value) return;
		if (!enabled.value || error.value || !params.value) { await normal.fetchOlder(); return; }
		const n = normalBoundary.value; const p = boundary.value;
		const beforeCursor = cursor;
		const beforeNormalId = normal.items.value.at(-1)?.id;
		await Promise.all([
			...(normal.canFetchOlder.value && n >= p ? [normal.fetchOlder()] : []),
			...(more.value && p >= n ? [loadOld()] : []),
		]);
		// A filtered page can advance the boundary without adding a visible row.
		// Remount the sentinel after progress so infinite scroll can ask again.
		if (normalBoundary.value !== n || boundary.value !== p || cursor !== beforeCursor || normal.items.value.at(-1)?.id !== beforeNormalId) pagingKey.value++;
	}

	async function poll() {
		if (polling || !usable() || !enabled.value || error.value || lastSync == null) return;
		polling = true;
		const current = generation;
		try {
			// Validate every retained body, including rows waiting for the other stream
			// and new notes queued while the user is reading older history.
			const snapshot = [...new Map([...notes.value, ...queued.value, ...(newer?.notes ?? [])].map(note => [note.id, note])).values()];
			const allowed = new Map<string, PrivateNote>();
			for (let i = 0; i < snapshot.length; i += 100) {
				const result = await misskeyApi('gridspace/private-notes', { ...params.value!, mode: 'validate', contextMode: 'home', ids: snapshot.slice(i, i + 100).map(note => note.id) }, undefined, signal());
				if (current !== generation) return;
				for (const note of result.notes) allowed.set(note.uri, note);
			}
			const previous = new Set(snapshot.map(note => note.uri));
			const valid = (items: PrivateNote[]) => items.flatMap(note => !previous.has(note.uri) ? [note] : allowed.has(note.uri) ? [allowed.get(note.uri)!] : []);
			notes.value = valid(notes.value); queued.value = valid(queued.value);
			if (newer) newer.notes = valid(newer.notes);
			// Include the preceding second for peers whose IDs have second precision.
			newer ??= { start: Math.max(1, lastSync - 1001), notes: [] };
			// Bounded per tick, but retain the cursor until this entire window is read.
			for (let page = 0; page < 5; page++) {
				const result = await misskeyApi('gridspace/private-notes', { ...params.value!, rangeStartAt: newer.start, cursor: newer.cursor, limit: 20 }, undefined, signal());
				if (current !== generation) return;
				newer.observedAt ??= Date.parse(result.observedAt);
				newer.notes.push(...result.notes); newer.cursor = result.cursor ?? undefined;
				if (!result.cursor) {
					const retained = new Set([...notes.value, ...queued.value].map(note => note.uri));
					queued.value = [...queued.value, ...newer.notes.filter(note => !retained.has(note.uri))];
					lastSync = newer.observedAt; newer = null;
					if (isTop()) releaseQueue();
					break;
				}
			}
		} catch { if (current === generation) fail(); } finally { polling = false; }
	}

	function visibility() { if (window.document.hidden) clear(); else void reload(); }

	function focus() { if (!enabled.value && !error.value) void reload(); else void poll(); }

	const timer = window.setInterval(poll, 10000);
	window.document.addEventListener('visibilitychange', visibility);
	window.addEventListener('focus', focus);
	watch(() => JSON.stringify(params.value), reload, { immediate: true });
	onDeactivated(() => { active = false; clear(); });
	onActivated(() => { if (!active) { active = true; void reload(); } });
	onBeforeUnmount(() => { active = false; clear(); window.clearInterval(timer); window.document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus); });
	return { rows, hasMore, loading, busy, queuedCount, pagingKey, error, reload, fetchOlder, releaseQueue, fail };
}
