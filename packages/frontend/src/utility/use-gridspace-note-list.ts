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
import { checkTextWordMute } from '@/utility/check-word-mute.js';
import { checkNoteWordMute } from '@/composables/use-note.js';
import { url } from '@@/js/config.js';
import { $i } from '@/i.js';

export type GridspaceNoteSource =
	| { kind: 'profile'; userId: string; linked: boolean; withReplies: boolean; withRenotes: boolean; withFiles: boolean; withChannelNotes: boolean }
	| ({ kind: 'search' } & Omit<entities.GridspaceSearchRequest, 'kind' | 'cursor' | 'limit'>);
type PrivateNote = entities.GridspacePrivateNotesResponse['notes'][number];

/** Keep delegated bodies outside normal note stores, sharing only list ordering and controls. */
export function useGridspaceNoteList(source: ComputedRef<GridspaceNoteSource>) {
	const normal = shallowRef<entities.Note[]>([]);
	const preview = shallowRef<entities.Note[]>([]);
	const delegated = shallowRef<PrivateNote[]>([]);
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
		if (kind === 'search') return { ...params, mode: 'search' };
		const profile = source.value as Extract<GridspaceNoteSource, { kind: 'profile' }>;
		return { mode: 'profile', userId: profile.userId, withReplies: profile.withReplies, withRenotes: profile.withRenotes, withFiles: profile.withFiles, withChannelNotes: profile.withChannelNotes };
	});
	const rows = computed(() => {
		const n = [...normal.value, ...preview.value].filter(item => !$i || !checkNoteWordMute(noteUtils.isPureRenote(item) ? item.renote ?? item : item, $i, $i.hardMutedWords));
		const p = delegated.value.filter(item => !$i || !checkTextWordMute(`${item.cw ?? ''}\n${item.text ?? ''}`, $i.hardMutedWords));
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
		enabled.value = false;
		delegated.value = []; privateCursor = undefined; privateMore.value = false; privateBoundary.value = Infinity;
		privateBusy.value = false; authorizing.value = false; checking = null;
	}

	function failPrivate() { clearPrivate(); privateReady.value = true; privateError.value = true; }

	async function loadPrivate() {
		if (!usable() || privateBusy.value || !privateMore.value) return;
		const current = privateGeneration; privateBusy.value = true;
		try {
			const page = await misskeyApi('gridspace/private-notes', { ...privateParams.value, cursor: privateCursor, limit: 20 }, undefined, signal(privateController));
			if (current !== privateGeneration) return;
			const boundary = page.scannedThrough == null ? NaN : Date.parse(page.scannedThrough);
			if (page.cursor && !Number.isFinite(boundary)) throw new Error('Invalid scan boundary');
			delegated.value = [...new Map([...delegated.value, ...page.notes].map(item => [item.uri, item])).values()];
			privateCursor = page.cursor ?? undefined; privateMore.value = page.cursor != null;
			privateBoundary.value = privateMore.value ? boundary : -Infinity;
		} catch { if (current === privateGeneration) failPrivate(); } finally {
			if (current === privateGeneration) { privateBusy.value = false; pagingKey.value++; }
		}
	}

	async function initPrivate() {
		clearPrivate(); privateError.value = false; enabled.value = false; privateReady.value = false;
		if (!usable()) { privateReady.value = true; return; }
		const current = privateGeneration; authorizing.value = true;
		try {
			const status = await misskeyApi('gridspace/private-grant', {}, undefined, signal(privateController));
			if (current !== privateGeneration) return;
			if (!status.available && status.granted) { failPrivate(); return; }
			enabled.value = status.available && status.granted;
			if (enabled.value) { privateMore.value = true; await loadPrivate(); }
		} catch { if (current === privateGeneration) failPrivate(); } finally {
			if (current === privateGeneration) { privateReady.value = true; authorizing.value = false; }
		}
	}

	async function loadNormal() {
		if (normalBusy.value || !normalMore.value) return;
		const current = normalGeneration; normalBusy.value = true; normalError.value = null;
		try {
			const input = source.value;
			let items: entities.Note[]; let cursor: string | null; let partial = false;
			if (input.kind === 'search') {
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
			else if (items.length) normalBoundary.value = Date.parse(items.at(-1)!.createdAt);
		} catch (error) {
			if (current === normalGeneration) {
				preview.value = [];
				normalError.value = (error as { info?: { reason?: string } }).info?.reason ?? 'UNKNOWN';
			}
		} finally { if (current === normalGeneration) { normalBusy.value = false; pagingKey.value++; } }
	}

	async function load() {
		if (loading.value) return;
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
				const page = await misskeyApi('gridspace/private-notes', { ...privateParams.value, mode: 'validate', contextMode: privateParams.value.mode as 'profile' | 'search', ids: snapshot.slice(i, i + 100).map(item => item.id) }, undefined, signal(privateController));
				if (current !== privateGeneration) return;
				for (const item of page.notes) allowed.set(item.uri, item);
			}
			if (current !== privateGeneration) return;
			const previous = new Set(snapshot.map(item => item.uri));
			delegated.value = delegated.value.flatMap(item => !previous.has(item.uri) ? [item] : allowed.has(item.uri) ? [allowed.get(item.uri)!] : []);
		} catch { if (current === privateGeneration) failPrivate(); } finally { if (checking === current) checking = null; }
	}

	function visibility() { if (window.document.hidden) { clearPrivate(); privateReady.value = true; } else void initPrivate(); }

	function focus() { if (!enabled.value && !privateError.value) void initPrivate(); else void revalidate(); }

	function removeNormal(id: string) { normal.value = normal.value.filter(item => item.id !== id); preview.value = preview.value.filter(item => item.id !== id); }

	const timer = window.setInterval(revalidate, 15000);
	window.document.addEventListener('visibilitychange', visibility);
	window.addEventListener('focus', focus);
	watch(() => JSON.stringify(source.value), reload, { immediate: true });
	onDeactivated(() => { active = false; clearPrivate(); privateReady.value = true; });
	onActivated(() => { if (!active) { active = true; void initPrivate(); } });
	onBeforeUnmount(() => {
		active = false; clearPrivate(); normalGeneration++; normalController.abort();
		window.clearInterval(timer); window.document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus);
	});
	return { rows, loading, hasMore, normalError, privateError, pagingKey, load, reload, retry, failPrivate, removeNormal };
}
