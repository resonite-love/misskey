/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, shallowRef, watch } from 'vue';
import type { ComputedRef } from 'vue';
import type { entities } from 'misskey-js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { linkedNotifications, refreshLinkedNotifications, setLinkedNotificationCount } from '@/utility/gridspace-notification-state.js';
import { $i } from '@/i.js';
import { updateCurrentAccountPartial } from '@/accounts.js';
import { useStream } from '@/stream.js';
import { store } from '@/store.js';
import { prefer } from '@/preferences.js';
import { checkTextWordMute } from '@/utility/check-word-mute.js';
import { checkNoteWordMute } from '@/composables/use-note.js';

type Page = entities.GridspaceNotificationsResponse;
type Source = 'local' | 'peer';
export type NotificationRow = { key: string; origin: string; recipientId: string; source: Source; id: string; createdAt: string; isRead: boolean } &
	({ source: 'local'; local: Page['local'][number]['notification'] } | { source: 'peer'; remote: Page['remote'][number] });
export type NotificationGroup = NotificationRow & { members: NotificationRow[] };
const makeState = () => ({ before: undefined as string | undefined, newest: undefined as string | undefined, boundary: Infinity, more: true, busy: false, error: false });

export function useGridspaceNotifications(exclude: ComputedRef<string[]>) {
	const data = { local: shallowRef<NotificationRow[]>([]), peer: shallowRef<NotificationRow[]>([]) };
	const state = reactive({ local: makeState(), peer: makeState() });
	const readErrors = reactive({ local: false, peer: false });
	const reading: Record<Source, Promise<void> | null> = { local: null, peer: null };
	let generation = 0;
	let active = true;
	let controller = new AbortController();
	let timer: number | undefined;
	const pending = { local: new Set<string>(), peer: new Set<string>() };
	const epochs = { local: 0, peer: 0 };
	const readRevisions = { local: 0, peer: 0 };
	const allReadRevisions = { local: 0, peer: 0 };
	const confirmedRead = { local: new Set<string>(), peer: new Set<string>() };
	const usable = () => active && !window.document.hidden;
	const sources: Source[] = ['local', 'peer'];
	const individualRows = computed(() => {
		const boundary = Math.max(...sources.map(s => state[s].error ? -Infinity : state[s].boundary));
		return sources.flatMap(s => data[s].value).filter(row => {
			if (Date.parse(row.createdAt) <= boundary) return false;
			if (!$i) return true;
			if (row.source === 'peer') return !checkTextWordMute(`${row.remote.body ?? ''}\n${row.remote.note?.cw ?? ''}\n${row.remote.note?.text ?? ''}`, $i.hardMutedWords);
			return !('note' in row.local) || !checkNoteWordMute(row.local.note, $i, $i.hardMutedWords);
		}).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.key.localeCompare(b.key));
	});
	const rows = computed<NotificationGroup[]>(() => {
		const result: NotificationGroup[] = [];
		for (const row of individualRows.value) {
			const previous = result.at(-1);
			const detail = row.source === 'local' ? row.local : row.remote;
			const previousDetail = previous?.members[0].source === 'local' ? previous.members[0].local : previous?.members[0].remote;
			if (prefer.s.useGroupedNotifications && previous && previous.source === row.source && previousDetail &&
				['reaction', 'renote'].includes(detail.type) && detail.type === previousDetail.type &&
				'note' in detail && 'note' in previousDetail &&
				(detail.type === 'renote' ? detail.note?.renoteId != null && detail.note.renoteId === previousDetail.note?.renoteId : detail.note?.id === previousDetail.note?.id)) {
				previous.members.push(row); previous.isRead &&= row.isRead;
				if (previous.source === 'local') {
					const first = previous.members[0];
					if (first.source === 'local' && 'note' in first.local) {
						const members = previous.members.flatMap(n => n.source === 'local' && 'user' in n.local ? [n.local] : []);
						previous.local = detail.type === 'reaction' ? { id: first.id, createdAt: first.createdAt, type: 'reaction:grouped', note: first.local.note,
																																																						reactions: members.flatMap(n => 'reaction' in n ? [{ user: n.user, reaction: n.reaction }] : []) }
							: { id: first.id, createdAt: first.createdAt, type: 'renote:grouped', note: first.local.note, users: members.map(n => n.user) };
					}
				}
			} else result.push({ ...row, members: [row] });
		}
		return result;
	});
	const hasMore = computed(() => sources.some(s => state[s].more && !state[s].error));
	const busy = computed(() => sources.some(s => state[s].busy));
	const error = computed(() => sources.some(s => state[s].error));
	const readError = computed(() => sources.some(s => readErrors[s]));

	function count(source: Source, value: number) {
		if (source === 'peer') { setLinkedNotificationCount(value); } else updateCurrentAccountPartial({ unreadNotificationsCount: value, hasUnreadNotification: value > 0 });
	}

	function convert(page: Page, source: Source): NotificationRow[] {
		const common = { source, origin: page.origin, recipientId: page.recipientId };
		return source === 'local'
			? page.local.map(n => ({ ...common, ...n, isRead: n.isRead || confirmedRead[source].has(n.id), source, key: `${page.origin}:${page.recipientId}:${n.id}`, local: n.notification }))
			: page.remote.map(n => ({ ...common, id: n.id, createdAt: n.createdAt, isRead: n.isRead || confirmedRead[source].has(n.id), source, key: `${page.origin}:${page.recipientId}:${n.id}`, remote: n }));
	}

	function fail(source: Source) {
		epochs[source]++;
		state[source].busy = false;
		state[source].error = true;
		if (source === 'peer') { data.peer.value = []; linkedNotifications.count = null; linkedNotifications.available = false; }
	}

	async function request(source: Source, options: entities.GridspaceNotificationsRequest) {
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
		while (true) {
			const allRevision = allReadRevisions[source];
			const revision = readRevisions[source];
			const page = await misskeyApi('gridspace/notifications', { ...options, source, excludeTypes: exclude.value, limit: 40 }, undefined, signal);
			if (allRevision === allReadRevisions[source]) return { page, revision };
			// All-read includes IDs not loaded yet. Fetch their current flags instead
			// of accepting an older snapshot or guessing which new arrivals it covers.
			signal.throwIfAborted();
		}
	}

	async function load(source: Source, newer = false) {
		if (!usable() || state[source].busy || (!newer && !state[source].more)) return;
		// An initially empty stream has no cursor. Treat its first arrival as a
		// fresh page, keeping the older continuation instead of skipping it.
		if (newer && !state[source].newest) newer = false;
		if (!newer && !state[source].newest) state[source].more = true;
		const current = generation;
		const epoch = epochs[source];
		state[source].busy = true;
		try {
			let more = true;
			do {
				const { page, revision } = await request(source, newer ? { since: state[source].newest } : { before: state[source].before });
				if (current !== generation || epoch !== epochs[source] || !usable()) return;
				state[source].error = false;
				data[source].value = [...new Map([...data[source].value, ...convert(page, source)].map(n => [n.key, n])).values()];
				if (revision === readRevisions[source]) count(source, page.unreadCount);
				if (newer) { if (page.newest) state[source].newest = page.newest; more = page.next != null; } else {
					state[source].newest ??= page.newest ?? undefined;
					state[source].before = page.next ?? undefined; state[source].more = page.next != null;
					state[source].boundary = page.next ? Date.parse(page.boundary!) : -Infinity;
					more = false;
				}
			} while (more && usable()); // catch up every missed page after reconnect
		} catch { if (current === generation && epoch === epochs[source]) fail(source); } finally { if (current === generation && epoch === epochs[source]) state[source].busy = false; }
	}

	async function validate(source: Source) {
		const current = generation;
		const epoch = epochs[source];
		const existing = data[source].value;
		const replacement: NotificationRow[] = [];
		try {
			for (let i = 0; i < existing.length; i += 100) {
				const { page, revision } = await request(source, { ids: existing.slice(i, i + 100).map(n => n.id) });
				if (current !== generation || epoch !== epochs[source] || !usable()) return;
				replacement.push(...convert(page, source)); if (revision === readRevisions[source]) count(source, page.unreadCount);
			}
			if (current === generation && epoch === epochs[source]) {
				const checked = new Set(existing.map(n => n.key));
				data[source].value = [...data[source].value.filter(n => !checked.has(n.key)), ...replacement.map(n => confirmedRead[source].has(n.id) ? { ...n, isRead: true } : n)];
			}
		} catch { if (current === generation && epoch === epochs[source]) fail(source); }
	}

	async function tick() {
		if (!usable()) return;
		await Promise.all(sources.map(async source => {
			if (state[source].error) { await resetSource(source); return; }
			await validate(source);
			if (!state[source].error) await load(source, true);
		}));
	}

	async function read(source: Source, ids: string[], all = false): Promise<boolean> {
		const current = generation;
		const epoch = epochs[source];
		// Explicit all-read waits behind an automatic seen update instead of disappearing.
		while (all && reading[source]) await reading[source];
		if (current !== generation || epoch !== epochs[source] || !usable() || reading[source] || (!all && !ids.length)) return false;
		const readIds = new Set(all ? data[source].value.map(n => n.id) : ids);
		let completed!: () => void;
		reading[source] = new Promise<void>(resolve => { completed = resolve; });
		try {
			const result = await misskeyApi('gridspace/notifications/read', { source, ...(all ? { all: true } : { ids }) }, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
			if (current !== generation || epoch !== epochs[source] || !usable()) return false;
			readRevisions[source]++;
			if (all) allReadRevisions[source]++;
			for (const id of readIds) confirmedRead[source].add(id);
			data[source].value = data[source].value.map(n => readIds.has(n.id) ? { ...n, isRead: true } : n);
			readErrors[source] = false;
			for (const id of readIds) pending[source].delete(id);
			count(source, result.unreadCount);
			// A page may finish after this write started but before it completed.
			// Check those additional IDs at the source; some may be later arrivals.
			if (all && data[source].value.some(n => !readIds.has(n.id))) await validate(source);
			return true;
		} catch (error) {
			if (current === generation && epoch === epochs[source]) {
				readErrors[source] = true;
				const reason = (error as { info?: { reason?: string } }).info?.reason;
				if (reason === 'AUTHORIZATION_REVOKED' || reason === 'LINK_REVOKED') fail(source);
			}
			return false;
		} finally { reading[source] = null; completed(); }
	}

	function seen(row: NotificationGroup) { if (usable()) for (const member of row.members) if (!member.isRead) pending[member.source].add(member.id); }

	async function flushSeen() {
		if (!usable()) return;
		await Promise.all(sources.map(async source => {
			const ids = [...pending[source]].filter(id => individualRows.value.some(row => row.source === source && row.id === id)).slice(0, 100);
			await read(source, ids);
		}));
	}

	async function resetSource(source: Source) { epochs[source]++; state[source] = makeState(); data[source].value = []; await load(source); }

	function clear() { generation++; controller.abort(); controller = new AbortController(); data.peer.value = []; pending.local.clear(); pending.peer.clear(); confirmedRead.local.clear(); confirmedRead.peer.clear(); }

	async function reload() { clear(); await Promise.all(sources.map(resetSource)); }

	async function older() { await Promise.all(sources.map(s => load(s))); }

	async function markDisplayed() { await flushSeen(); }

	async function markAll() { await Promise.all(sources.map(source => read(source, [], true))); }

	function visibility() { if (!window.document.hidden && active) void reload(); else clear(); }

	let ticking = false;
	const stream = store.s.realtimeMode ? useStream().useChannel('main') : null;
	const changed = () => { if (!state.local.busy) void load('local', true); };
	onMounted(() => {
		void reload(); window.document.addEventListener('visibilitychange', visibility);
		stream?.on('notification', changed); stream?.on('notificationRead', changed); stream?.on('notificationFlushed', reload);
		let elapsed = 0;
		timer = window.setInterval(async () => {
			if (ticking || !usable()) return;
			ticking = true;
			try { await flushSeen(); if (++elapsed % 10 === 0) await tick(); } finally { ticking = false; }
		}, 1000);
	});
	onActivated(() => { if (!active) { active = true; void reload(); } });
	onDeactivated(() => { active = false; clear(); });
	onBeforeUnmount(() => { active = false; clear(); window.clearInterval(timer); stream?.dispose(); window.document.removeEventListener('visibilitychange', visibility); void refreshLinkedNotifications(); });
	watch(exclude, reload, { deep: true });
	return { rows, hasMore, busy, error, readError, older, reload, seen, markDisplayed, markAll };
}
