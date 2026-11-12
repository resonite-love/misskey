/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue';
import type { ComputedRef } from 'vue';
import type { entities } from 'misskey-js';
import { note as noteUtils } from 'misskey-js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { mergeHomeRows } from '@/utility/gridspace-home-merge.js';
import { isVisiblePrivateNote, suspendPrivateNotes } from '@/utility/gridspace-note-suspension.js';
import type { GridspaceNoteEntry } from '@/utility/gridspace-note-suspension.js';
import { checkNoteWordMute } from '@/composables/use-note.js';
import { url } from '@@/js/config.js';
import { $i } from '@/i.js';

export type GridspaceNoteSource =
	| { kind: 'favorites' }
	| { kind: 'clip'; clipId: string }
	| { kind: 'mentions'; direct: boolean }
	| { kind: 'profile'; userId: string; linked: boolean; withReplies: boolean; withRenotes: boolean; withFiles: boolean; withChannelNotes: boolean }
	| ({ kind: 'search' } & Omit<entities.GridspaceSearchRequest, 'kind' | 'cursor' | 'limit'>);
type PrivateNote = entities.GridspacePrivateNotesResponse['notes'][number];

/** Keep delegated bodies outside normal note stores, sharing only list ordering and controls. */
export function useGridspaceNoteList(source: ComputedRef<GridspaceNoteSource>) {
	const normal = shallowRef<(entities.Note & { collectionAt?: string })[]>([]);
	const preview = shallowRef<(entities.Note & { collectionAt?: string })[]>([]);
	const delegated = shallowRef<GridspaceNoteEntry[]>([]);
	let suspended = false;
	let privatePageLoaded = false;
	const normalMore = ref(true);
	const privateMore = ref(false);
	const normalBoundary = ref(Infinity);
	const privateBoundary = ref(Infinity);
	const normalBusy = ref(false);
	const privateBusy = ref(false);
	const authorizing = ref(false);
	const privateReady = ref(false);
	const enabled = ref(false);
	const normalError = ref<string | null>(null);
	const privateError = ref(false);
	const needsAuthorization = ref(false);
	const pagingKey = ref(0);
	let normalCursor: string | undefined;
	let privateCursor: string | undefined;
	let normalGeneration = 0;
	let privateGeneration = 0;
	let normalController = new AbortController();
	let privateController = new AbortController();
	let checking: number | null = null;
	let active = true;
	const privateParams = computed<entities.GridspacePrivateNotesRequest>(() => {
		const { kind, ...params } = source.value;
		if (source.value.kind === 'favorites') return { mode: 'favorites' };
		if (source.value.kind === 'clip') return { mode: 'clip', clipId: source.value.clipId };
		if (kind === 'search') return { ...params, mode: 'search' };
		if (source.value.kind === 'mentions') return { mode: source.value.direct ? 'direct' : 'mentions' };
		const profile = source.value as Extract<GridspaceNoteSource, { kind: 'profile' }>;
		return { mode: 'profile', userId: profile.userId, withReplies: profile.withReplies, withRenotes: profile.withRenotes, withFiles: profile.withFiles, withChannelNotes: profile.withChannelNotes };
	});
	const rows = computed(() => {
		const n = [...normal.value, ...preview.value].filter(item => !$i || !checkNoteWordMute(noteUtils.isPureRenote(item) ? item.renote ?? item : item, $i, $i.hardMutedWords));
		const p = delegated.value.filter(item => isVisiblePrivateNote(item));
		return mergeHomeRows(n, p, url,
			normalError.value ? -Infinity : normalBoundary.value,
			!privateReady.value ? Infinity : !enabled.value || privateError.value ? -Infinity : privateBoundary.value);
	});
	const loading = computed(() => normalBusy.value || privateBusy.value || authorizing.value);
	const hasMore = computed(() => (normalMore.value && !normalError.value) || (enabled.value && privateMore.value && !privateError.value));
	const usable = () => active && !window.document.hidden && !!$i;
	const signal = (controller: AbortController) => AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);

	function clearPrivate() {
		privateGeneration++; privateController.abort(); privateController = new AbortController();
		enabled.value = false; suspended = false; privatePageLoaded = false;
		delegated.value = []; privateCursor = undefined; privateMore.value = false; privateBoundary.value = Infinity;
		privateBusy.value = false; authorizing.value = false; checking = null;
	}

	function failPrivate() { clearPrivate(); privateReady.value = true; privateError.value = true; }

	async function loadPrivate() {
		if (!usable() || suspended || privateBusy.value || !privateMore.value) return;
		const current = privateGeneration; privateBusy.value = true;
		try {
			const page = await misskeyApi('gridspace/private-notes', { ...privateParams.value, cursor: privateCursor, limit: 20 }, undefined, signal(privateController));
			if (current !== privateGeneration) return;
			const boundary = page.scannedThrough == null ? NaN : Date.parse(page.scannedThrough);
			if (page.cursor && !Number.isFinite(boundary)) throw new Error('Invalid scan boundary');
			delegated.value = [...new Map([...delegated.value, ...page.notes].map(item => [item.uri, item])).values()];
			privateCursor = page.cursor ?? undefined; privateMore.value = page.cursor != null;
			privateBoundary.value = privateMore.value ? boundary : -Infinity;
			privatePageLoaded = true;
		} catch { if (current === privateGeneration) failPrivate(); } finally {
			if (current === privateGeneration) { privateBusy.value = false; pagingKey.value++; }
		}
	}

	async function initPrivate(background = false) {
		if (background && authorizing.value) return;
		clearPrivate(); privateError.value = false; needsAuthorization.value = false; enabled.value = false; privateReady.value = background;
		if (!usable()) { privateReady.value = true; return; }
		const current = privateGeneration; authorizing.value = true;
		try {
			if (source.value.kind === 'favorites' || source.value.kind === 'clip') {
				const collections = await misskeyApi('gridspace/collections', { kind: 'status' }, undefined, signal(privateController));
				if (current !== privateGeneration) return;
				if (!collections.enabled) return;
				if (!(source.value.kind === 'favorites' ? collections.favorites : collections.clips)) { needsAuthorization.value = true; return; }
			}
			const status = await misskeyApi('gridspace/private-grant', {}, undefined, signal(privateController));
			if (current !== privateGeneration) return;
			if (!status.available && status.granted) { failPrivate(); return; }
			if (status.available && status.granted) {
				if (!background) enabled.value = true;
				privateMore.value = true; await loadPrivate();
				if (current === privateGeneration) enabled.value = true;
			}
		} catch { if (current === privateGeneration) failPrivate(); } finally {
			if (current === privateGeneration) { privateReady.value = true; authorizing.value = false; }
		}
	}

	async function loadNormal() {
		if (normalBusy.value || !normalMore.value) return;
		const current = normalGeneration; normalBusy.value = true; normalError.value = null;
		try {
			const input = source.value;
			let items: (entities.Note & { collectionAt?: string })[]; let cursor: string | null; let partial = false;
			if (input.kind === 'clip') {
				items = []; cursor = null;
			} else if (input.kind === 'favorites') {
				const page = await misskeyApi('i/favorites', { untilId: normalCursor, limit: 20 }, undefined, signal(normalController));
				items = page.map(item => ({ ...item.note, collectionAt: item.createdAt }));
				cursor = page.length === 20 ? page.at(-1)!.id : null;
			} else if (input.kind === 'mentions') {
				items = await misskeyApi('notes/mentions', { visibility: input.direct ? 'specified' : undefined, untilId: normalCursor, limit: 20 }, undefined, signal(normalController));
				cursor = items.length === 20 ? items.at(-1)!.id : null;
			} else if (input.kind === 'search') {
				const { kind: _kind, ...params } = input;
				const page = await misskeyApi('gridspace/search', { ...params, kind: 'notes', cursor: normalCursor, limit: 20 }, undefined, signal(normalController));
				items = page.notes; cursor = page.cursor; partial = !page.peerAvailable;
			} else {
				const { kind: _kind, linked, ...params } = input;
				if (linked) {
					const page = await misskeyApi('gridspace/history', { ...params, cursor: normalCursor, limit: 20 }, undefined, signal(normalController));
					items = page.notes; cursor = page.cursor;
				} else {
					items = await misskeyApi('users/notes', { ...params, untilId: normalCursor, limit: 20 }, undefined, signal(normalController));
					cursor = items.length === 20 ? items.at(-1)!.id : null;
				}
			}
			if (current !== normalGeneration) return;
			const known = new Set(normal.value.map(item => item.id));
			preview.value = items.filter(item => !known.has(item.id));
			if (partial) { normalError.value = 'PEER_UNAVAILABLE'; return; }
			normal.value = [...normal.value, ...preview.value]; preview.value = [];
			normalCursor = cursor ?? undefined; normalMore.value = cursor != null;
			// Empty filtered pages keep the last safe boundary until the next page advances it.
			if (!normalMore.value) normalBoundary.value = -Infinity;
			else if (items.length) normalBoundary.value = Date.parse(items.at(-1)!.collectionAt ?? items.at(-1)!.createdAt);
		} catch (error) {
			if (current === normalGeneration) {
				preview.value = [];
				normalError.value = (error as { info?: { reason?: string } }).info?.reason ?? 'UNKNOWN';
			}
		} finally { if (current === normalGeneration) { normalBusy.value = false; pagingKey.value++; } }
	}

	async function load() {
		if (loading.value || suspended || !active || window.document.hidden) return;
		const n = normalError.value ? -Infinity : normalBoundary.value;
		const p = !enabled.value || privateError.value ? -Infinity : privateBoundary.value;
		await Promise.all([
			...(normalMore.value && !normalError.value && n >= p ? [loadNormal()] : []),
			...(privateMore.value && !privateError.value && p >= n ? [loadPrivate()] : []),
		]);
	}

	async function reload() {
		normalGeneration++; normalController.abort(); normalController = new AbortController();
		normal.value = []; preview.value = []; normalCursor = undefined; normalBoundary.value = Infinity; normalMore.value = true; normalBusy.value = false; normalError.value = null;
		await Promise.all([loadNormal(), initPrivate()]);
	}

	async function retry() {
		if (normalError.value === 'INVALID_CURSOR' || normalError.value === 'LINK_UNAVAILABLE') { await reload(); return; }
		await Promise.all([...(normalError.value ? [loadNormal()] : []), ...(privateError.value ? [initPrivate()] : [])]);
	}

	async function revalidate() {
		if (!usable() || checking != null || !enabled.value || privateError.value || authorizing.value) return;
		const current = privateGeneration; checking = current;
		const snapshot = delegated.value;
		try {
			const allowed = new Map<string, PrivateNote>();
			if (!snapshot.length) {
				const status = await misskeyApi('gridspace/private-grant', {}, undefined, signal(privateController));
				if (!status.granted || !status.available) throw new Error('Unavailable');
			}
			for (let i = 0; i < snapshot.length; i += 100) {
				const page = await misskeyApi('gridspace/private-notes', { ...privateParams.value, mode: 'validate', contextMode: privateParams.value.mode as entities.GridspacePrivateNotesRequest['contextMode'], ids: snapshot.slice(i, i + 100).map(item => item.id) }, undefined, signal(privateController));
				if (current !== privateGeneration) return;
				for (const item of page.notes) allowed.set(item.uri, item);
			}
			if (current !== privateGeneration) return;
			const previous = new Set(snapshot.map(item => item.uri));
			delegated.value = delegated.value.flatMap(item => !previous.has(item.uri) ? [item] : allowed.has(item.uri) ? [allowed.get(item.uri)!] : []);
			suspended = false;
		} catch { if (current === privateGeneration) failPrivate(); } finally { if (checking === current) checking = null; }
	}

	function suspend() {
		if (!$i || privateError.value) return;
		privateGeneration++; privateController.abort(); privateController = new AbortController();
		delegated.value = suspendPrivateNotes(delegated.value); suspended = true;
		privateBusy.value = false; authorizing.value = false; checking = null;
		privateReady.value = true;
		if (!privatePageLoaded) enabled.value = false;
	}

	function focus() {
		if (!usable()) return;
		if ((!enabled.value || !privatePageLoaded) && !privateError.value) void initPrivate(true); else void revalidate();
	}

	function visibility() { if (window.document.hidden) suspend(); else focus(); }

	function removeNormal(id: string) { normal.value = normal.value.filter(item => item.id !== id); preview.value = preview.value.filter(item => item.id !== id); }

	const timer = window.setInterval(revalidate, 15000);
	window.document.addEventListener('visibilitychange', visibility);
	window.addEventListener('focus', focus);
	watch(() => JSON.stringify(source.value), reload, { immediate: true });
	onDeactivated(() => { active = false; suspend(); });
	onActivated(() => { if (!active) { active = true; focus(); } });
	onBeforeUnmount(() => {
		active = false; clearPrivate(); normalGeneration++; normalController.abort();
		window.clearInterval(timer); window.document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus);
	});
	return { rows, loading, hasMore, normalError, privateError, needsAuthorization, pagingKey, load, reload, retry, failPrivate, removeNormal };
}
