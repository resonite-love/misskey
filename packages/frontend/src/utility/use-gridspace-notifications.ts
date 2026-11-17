/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, shallowRef, watch } from 'vue';
import type { ComputedRef } from 'vue';
import type { entities } from 'misskey-js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { linkedNotifications, refreshLinkedNotifications, setLinkedNotificationCount, setChannelNotificationCount, failLinkedNotifications } from '@/utility/gridspace-notification-state.js';
import { $i } from '@/i.js';
import { updateCurrentAccount } from '@/accounts.js';
import { useStream } from '@/stream.js';
import { store } from '@/store.js';
import { prefer } from '@/preferences.js';
import { checkTextWordMute } from '@/utility/check-word-mute.js';
import { checkNoteWordMute } from '@/composables/use-note.js';

type Page = entities.GridspaceNotificationsResponse;
type Source = 'local' | 'peer' | 'channel';
export type NotificationRow = { key: string; origin: string; recipientId: string; source: Source; id: string; createdAt: string; isRead: boolean; suspended?: boolean } &
	({ source: 'local'; local: Page['local'][number]['notification'] } | { source: 'peer' | 'channel'; remote: Page['remote'][number] });
export type NotificationGroup = NotificationRow & { members: NotificationRow[] };
type TimelinePage = { cursor: string; nextCursor: string | null; scannedCount: number; complete: boolean; revalidateAfterMs: number;
																						items: { key: string; source: Source; origin: string; recipientId: string; id: string; createdAt: string; isRead: boolean; local: Page['local'][number]['notification'] | null; remote: Page['remote'][number] | null }[];
																						sources: { source: Source; status: 'ok' | 'disabled' | 'unavailable' | 'unauthorized'; unreadCount: number | null }[] };

export function useGridspaceNotifications(exclude: ComputedRef<string[]>, isAtTop: () => boolean = () => true) {
	const suspendedRows = shallowRef<NotificationGroup[] | null>(null);
	const queuedKeys = shallowRef(new Set<string>());
	const queued = computed(() => ordered.value.filter(row => queuedKeys.value.has(row.key)).length);
	const releaseQueue = () => { if (!suspendedRows.value) queuedKeys.value = new Set(); };
	const ordered = shallowRef<NotificationRow[]>([]);
	const busy = shallowRef(false);
	const error = shallowRef(false);
	const nextCursor = shallowRef<string | null>(null);
	let cursor: string | undefined;
	let scannedCount = 0;
	let expiresAt = Infinity;
	let expiryTimer: number | undefined;
	const readErrors = reactive({ local: false, peer: false, channel: false });
	const reading: Record<Source, Promise<void> | null> = { local: null, peer: null, channel: null };
	let generation = 0;
	let active = true;
	let controller = new AbortController();
	let timer: number | undefined;
	const pending = { local: new Set<string>(), peer: new Set<string>(), channel: new Set<string>() };
	const epochs = { local: 0, peer: 0, channel: 0 };
	const readRevisions = { local: 0, peer: 0, channel: 0 };
	const allReadRevisions = { local: 0, peer: 0, channel: 0 };
	const confirmedRead = { local: new Set<string>(), peer: new Set<string>(), channel: new Set<string>() };
	const usable = () => active && !window.document.hidden;
	const sources: Source[] = ['local', 'peer', 'channel'];
	const individualRows = computed(() => ordered.value.filter(row => {
		if (queuedKeys.value.has(row.key)) return false;
		if (!$i) return true;
		if (row.source !== 'local') return !checkTextWordMute(`${row.remote.body ?? ''}\n${row.remote.note?.cw ?? ''}\n${row.remote.note?.text ?? ''}\n${row.remote.renote?.cw ?? ''}\n${row.remote.renote?.text ?? ''}`, $i.hardMutedWords);
		return !('note' in row.local) || !checkNoteWordMute(row.local.note, $i, $i.hardMutedWords);
	}));
	const rows = computed<NotificationGroup[]>(() => {
		if (suspendedRows.value) return suspendedRows.value;
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
	const hasMore = computed(() => nextCursor.value != null);
	const readError = computed(() => sources.some(s => readErrors[s]));

	function count(source: Source, value: number) {
		if (source === 'channel') { setChannelNotificationCount(value); } else if (source === 'peer') { setLinkedNotificationCount(value); } else updateCurrentAccount({ unreadNotificationsCount: value, hasUnreadNotification: value > 0 });
	}

	function fail(source: Source) {
		epochs[source]++;
		error.value = true;
		if (source !== 'local') {
			ordered.value = ordered.value.filter(row => row.source !== source);
			failLinkedNotifications(source);
		}
	}

	async function load(mode: 'page' | 'refresh' | 'validate' = 'page') {
		if (!usable() || busy.value || (mode === 'page' && cursor && !nextCursor.value)) return;
		const current = generation;
		busy.value = true;
		const startedAt = Date.now();
		const appending = mode === 'page' && cursor != null;
		try {
			let page: TimelinePage;
			let revisions: typeof readRevisions;
			// All-read includes unloaded IDs. A response captured before that write must
			// be checked again, without guessing which future arrivals it covers.
			while (true) {
				const allRevisions = { ...allReadRevisions };
				revisions = { ...readRevisions };
				page = await misskeyApi<TimelinePage, 'gridspace/notifications/timeline'>('gridspace/notifications/timeline', {
					mode, cursor: mode === 'page' ? nextCursor.value ?? undefined : cursor,
					count: Math.max(20, scannedCount), limit: 20, excludeTypes: exclude.value,
				}, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
				if (current !== generation || !usable()) return;
				if (sources.every(source => allRevisions[source] === allReadRevisions[source])) break;
			}
			const incoming = page.items.flatMap<NotificationRow>(item => {
				const common = { key: item.key, origin: item.origin, recipientId: item.recipientId, id: item.id, createdAt: item.createdAt, isRead: item.isRead || confirmedRead[item.source].has(item.key) };
				return item.source === 'local' && item.local ? [{ ...common, source: 'local' as const, local: item.local }]
					: item.source !== 'local' && item.remote ? [{ ...common, source: item.source, remote: item.remote }] : [];
			}) as NotificationRow[];
			if (mode === 'refresh' && cursor && !isAtTop()) {
				const known = new Set(ordered.value.map(row => row.key));
				queuedKeys.value = new Set([...queuedKeys.value, ...incoming.filter(row => !known.has(row.key)).map(row => row.key)]);
			}
			if (mode === 'page' && cursor) {
				const known = new Set(ordered.value.map(row => row.key));
				ordered.value = [...ordered.value, ...incoming.filter(row => !known.has(row.key))];
			} else ordered.value = incoming;
			cursor = page.cursor; nextCursor.value = page.nextCursor; scannedCount = page.scannedCount;
			error.value = !page.complete;
			for (const source of page.sources) {
				if (source.status === 'unavailable' || source.status === 'unauthorized') fail(source.source);
				else if (source.unreadCount != null && revisions[source.source] === readRevisions[source.source]) count(source.source, source.unreadCount);
				if (source.status === 'disabled') ordered.value = ordered.value.filter(row => row.source !== source.source);
			}
			const known = new Set(ordered.value.map(row => row.key));
			queuedKeys.value = new Set([...queuedKeys.value].filter(key => known.has(key)));
			suspendedRows.value = null;
			// An older page has not revalidated the rows already on screen.
			expiresAt = appending ? Math.min(expiresAt, startedAt + page.revalidateAfterMs) : startedAt + page.revalidateAfterMs;
			window.clearTimeout(expiryTimer);
			expiryTimer = window.setTimeout(stripProtected, Math.max(0, expiresAt - Date.now()));
			if (Date.now() >= expiresAt) stripProtected();
		} catch {
			if (current === generation) { for (const source of sources) fail(source); }
		} finally { if (current === generation) busy.value = false; }
	}

	async function tick() { if (usable()) await load('refresh'); }

	async function read(source: Source, ids: string[], all = false): Promise<boolean> {
		if ((source === 'channel' && !linkedNotifications.channelEnabled) || (source === 'peer' && linkedNotifications.peerEnabled === false)) return true;
		const current = generation;
		const epoch = epochs[source];
		// Explicit all-read waits behind an automatic seen update instead of disappearing.
		while (all && reading[source]) await reading[source];
		if (current !== generation || epoch !== epochs[source] || !usable() || reading[source] || (!all && !ids.length)) return false;
		const readIds = new Set(all ? ordered.value.filter(n => n.source === source).map(n => n.id) : ids);
		const readKeys = new Set(ordered.value.filter(n => n.source === source && readIds.has(n.id)).map(n => n.key));
		const identity = ordered.value.find(n => n.source === source);
		let completed!: () => void;
		reading[source] = new Promise<void>(resolve => { completed = resolve; });
		try {
			const result = await misskeyApi('gridspace/notifications/read', { source, ...(identity ? { origin: identity.origin, recipientId: identity.recipientId } : {}), ...(all ? { all: true } : { ids }) }, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
			if (current !== generation || epoch !== epochs[source] || !usable()) return false;
			readRevisions[source]++;
			if (all) allReadRevisions[source]++;
			for (const key of readKeys) confirmedRead[source].add(key);
			ordered.value = ordered.value.map(n => readKeys.has(n.key) ? { ...n, isRead: true } : n);
			readErrors[source] = false;
			for (const key of readKeys) pending[source].delete(key);
			count(source, result.unreadCount);
			// A page may finish after this write started but before it completed.
			// Check those additional IDs at the source; some may be later arrivals.
			if (all && ordered.value.some(n => n.source === source && !readIds.has(n.id))) await load('validate');
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

	function seen(row: NotificationGroup) { if (usable() && !row.suspended) for (const member of row.members) if (!member.isRead) pending[member.source].add(member.key); }

	async function flushSeen() {
		if (!usable()) return;
		await Promise.all(sources.map(async source => {
			const ids = individualRows.value.filter(row => row.source === source && pending[source].has(row.key)).slice(0, 100).map(row => row.id);
			await read(source, ids);
		}));
	}

	function clear() {
		suspendedRows.value = null; queuedKeys.value = new Set(); generation++; controller.abort(); controller = new AbortController();
		window.clearTimeout(expiryTimer);
		for (const source of sources) { pending[source].clear(); confirmedRead[source].clear(); readErrors[source] = false; }
		ordered.value = []; cursor = undefined; nextCursor.value = null; scannedCount = 0; busy.value = false; expiresAt = Infinity;
	}

	async function reload() { clear(); await load('refresh'); }

	async function older() { if (!suspendedRows.value) await load(); }

	async function markDisplayed() { await flushSeen(); }

	async function markAll() { await Promise.all(sources.map(source => read(source, [], true))); }

	function stripped(row: NotificationRow): NotificationRow {
		if (row.source === 'local') return row;
		return { key: row.key, origin: row.origin, recipientId: row.recipientId, source: row.source, id: row.id, createdAt: row.createdAt, isRead: row.isRead, suspended: true,
											remote: { id: row.id, createdAt: row.createdAt, isRead: row.isRead, type: 'test', note: null, user: null, body: null, reaction: null } };
	}

	function stripProtected() {
		ordered.value = ordered.value.map(stripped);
		if (suspendedRows.value) suspendedRows.value = suspendedRows.value.map(row => ({ ...stripped(row), members: row.members.map(stripped) }));
	}

	function suspend() {
		generation++; controller.abort(); controller = new AbortController(); busy.value = false;
		suspendedRows.value ??= rows.value.map(row => ({ ...stripped(row), members: row.members.map(stripped) }));
		stripProtected();
		for (const source of sources) pending[source].clear();
	}

	async function resume() {
		if (!usable()) return;
		// Refresh performs the same current authorization checks as validate,
		// and includes new arrivals in one response.
		await load('refresh');
		if (!usable()) return;
		if (isAtTop()) releaseQueue();
	}

	function visibility() { if (!window.document.hidden && active) void resume(); else suspend(); }

	let ticking = false;
	const stream = store.s.realtimeMode ? useStream().useChannel('main') : null;
	const changed = () => { void load('refresh'); };
	onMounted(() => {
		void reload(); window.document.addEventListener('visibilitychange', visibility);
		stream?.on('notification', changed); stream?.on('notificationRead', changed); stream?.on('notificationFlushed', reload);
		let elapsed = 0;
		timer = window.setInterval(async () => {
			if (Date.now() >= expiresAt) stripProtected();
			if (ticking || !usable()) return;
			ticking = true;
			try { await flushSeen(); if (++elapsed % 10 === 0) await tick(); } finally { ticking = false; }
		}, 1000);
	});
	onActivated(() => { if (!active) { active = true; void resume(); } });
	onDeactivated(() => { active = false; suspend(); });
	onBeforeUnmount(() => { active = false; clear(); window.clearInterval(timer); stream?.dispose(); window.document.removeEventListener('visibilitychange', visibility); void refreshLinkedNotifications(); });
	watch(() => [linkedNotifications.peerEnabled, linkedNotifications.channelEnabled] as const, () => { void reload(); });
	watch(exclude, reload, { deep: true });
	return { rows, hasMore, busy, error, readError, older, reload, seen, markDisplayed, markAll, queued, releaseQueue };
}
