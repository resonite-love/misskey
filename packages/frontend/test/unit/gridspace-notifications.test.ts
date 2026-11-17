/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, createApp, nextTick } from 'vue';
import { useGridspaceNotifications } from '@/utility/use-gridspace-notifications.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { $i } from '@/i.js';
import { linkedNotifications } from '@/utility/gridspace-notification-state.js';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn(), isMisskeyApiNetworkError: (error: unknown) => error instanceof TypeError && error.message === 'Failed to fetch' }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', hardMutedWords: [] } }));
vi.mock('@/accounts.js', () => ({ updateCurrentAccount: vi.fn() }));
vi.mock('@/composables/use-note.js', () => ({ checkNoteWordMute: () => false }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { useGroupedNotifications: true } } }));
vi.mock('@/store.js', () => ({ store: { s: { realtimeMode: false } } }));
vi.mock('@/stream.js', () => ({ useStream: () => { throw new Error('WebSocket forbidden in polling mode'); } }));
vi.mock('@/utility/gridspace-notification-state.js', async () => {
	const { reactive } = await import('vue');
	return { linkedNotifications: reactive({ count: null, available: true, peerEnabled: true, channelEnabled: false }), refreshLinkedNotifications: vi.fn(),
		setChannelNotificationCount: vi.fn(), failLinkedNotifications: (source: string) => { if (source === 'peer') linkedNotifications.count = null; linkedNotifications.available = false; },
		setLinkedNotificationCount: (value: number) => { linkedNotifications.count = value; linkedNotifications.available = true; } };
});

const api = vi.mocked(misskeyApi);
const at = (n: number) => new Date(1700000000000 + n * 1000).toISOString();
const notice = (source: 'local' | 'peer' | 'channel', id: string, n: number, type = 'test') => ({
 key: JSON.stringify([source, id]), origin: source === 'local' ? 'https://g.example' : 'https://r.example', recipientId: source,
 source, id, createdAt: at(n), isRead: false,
 local: source === 'local' ? { id, type, createdAt: at(n) } : null,
 remote: source === 'local' ? null : { id, createdAt: at(n), type, isRead: false, note: null as { id: string } | null, user: null, body: 'protected', reaction: null },
});
const page = (items: ReturnType<typeof notice>[] = [], nextCursor: string | null = null) => ({
 cursor: 'snapshot', nextCursor, scannedCount: items.length, complete: true, revalidateAfterMs: 10000, items,
 sources: ['local', 'peer', 'channel'].map(source => ({ source, status: source === 'channel' ? 'disabled' : 'ok', unreadCount: 5 })),
});
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); await nextTick(); };
let respond: (endpoint: string, params: Record<string, unknown>) => Promise<unknown>;
let cleanup = () => {};
function mount(isAtTop = () => true) {
 let list!: ReturnType<typeof useGridspaceNotifications>;
 const app = createApp({ setup() { list = useGridspaceNotifications(computed(() => []), isAtTop); return () => null; } });
 app.mount(document.createElement('div')); cleanup = () => app.unmount();
 return list;
}
beforeEach(() => { Object.assign(linkedNotifications, { channelEnabled: false, peerEnabled: true }); vi.useFakeTimers(); api.mockReset(); api.mockImplementation(((endpoint, params) => respond(endpoint, params ?? {})) as typeof misskeyApi); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('server-ordered notification timeline', () => {
 it('removes a retained hidden snapshot immediately on an authorization error after return', async () => {
  let hidden = false; vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  let fail = false;
  respond = async () => { if (fail) throw { info: { reason: 'AUTHORIZATION_REVOKED' } }; return page([notice('peer', 'one', 1)]); };
  const list = mount(); await settle();
  hidden = true; document.dispatchEvent(new Event('visibilitychange')); await settle();
  expect(JSON.stringify(list.rows.value)).toContain('protected');
  fail = true; hidden = false; document.dispatchEvent(new Event('visibilitychange')); await settle();
  expect(JSON.stringify(list.rows.value)).not.toContain('protected');
 });
 it('renews before expiry even when acknowledging a seen notification is slow', async () => {
  let requests = 0;
  let finish!: (result: unknown) => void;
  respond = async endpoint => {
   if (endpoint.endsWith('/read')) return new Promise(resolve => { finish = resolve; });
   requests++; return { ...page([notice('peer', 'one', 1)]), revalidateAfterMs: 9000 };
  };
  const list = mount(); await settle(); list.seen(list.rows.value[0]);
  await vi.advanceTimersByTimeAsync(9100); await settle();
  expect(requests).toBeGreaterThan(1);
  expect(list.rows.value[0]).not.toHaveProperty('suspended', true);
  expect(JSON.stringify(list.rows.value)).toContain('protected');
  finish({ unreadCount: 0 }); await settle();
 });
 it('retains a transport failure only until the previous lease expires', async () => {
  let fail = false;
  respond = async () => { if (fail) throw new TypeError('Failed to fetch'); return page([notice('peer', 'one', 1)], 'older'); };
  const list = mount(); await settle(); fail = true; await list.older();
  expect(JSON.stringify(list.rows.value)).toContain('protected');
  await vi.advanceTimersByTimeAsync(10001);
  expect(JSON.stringify(list.rows.value)).not.toContain('protected');
 });
 it('preserves the server order on a verified retryable source failure without renewing its lease', async () => {
  let fail = false;
  const first = page([notice('peer', 'first', 1), notice('local', 'second', 9), notice('peer', 'third', 8)]);
  respond = async () => fail ? { ...page([notice('local', 'second', 9)]), complete: false, sources: [
   { source: 'local', status: 'ok', unreadCount: 0 }, { source: 'peer', status: 'unavailable', retryable: true, unreadCount: null },
  ] } : first;
  const list = mount(); await settle(); fail = true;
  await vi.advanceTimersByTimeAsync(9000);
  expect(list.rows.value.map(row => row.id)).toEqual(['first', 'second', 'third']);
  await vi.advanceTimersByTimeAsync(1001);
  expect(JSON.stringify(list.rows.value)).not.toContain('protected');
 });
 it('removes protected rows on unclassified API or response failures', async () => {
  let fail = false;
  respond = async () => { if (fail) throw { code: 'GRIDSPACE_NOTIFICATION_TIMELINE_UNAVAILABLE', info: { reason: 'PEER_UNAVAILABLE' } }; return page([notice('peer', 'one', 1)], 'older'); };
  const list = mount(); await settle(); fail = true; await list.older();
  expect(list.rows.value).toEqual([]);
 });
 it('keeps server order, opaque cursor and identity even when timestamps disagree', async () => {
  respond = async (_, p) => p.cursor === 'older' ? page([notice('peer', 'third', 99)]) : page([notice('peer', 'same', 1), notice('local', 'same', 10)], 'older');
  const list = mount(); await settle();
  expect(list.rows.value.map(row => [row.source, row.id])).toEqual([['peer', 'same'], ['local', 'same']]);
  await list.older();
  expect(list.rows.value.map(row => row.id)).toEqual(['same', 'same', 'third']);
  expect(api.mock.calls.every(([endpoint]) => endpoint === 'gridspace/notifications/timeline')).toBe(true);
  expect(api.mock.calls[1][1]).toMatchObject({ cursor: 'older', mode: 'page' });
  expect(api.mock.calls[1][1]).not.toHaveProperty('source');
 });
 it('does not mark fetched rows read; seen writes use the source and recipient identity', async () => {
  respond = async endpoint => endpoint.endsWith('/read') ? { unreadCount: 0 } : page([notice('peer', 'one', 1)]);
  const list = mount(); await settle();
  expect(api.mock.calls.some(([endpoint]) => endpoint.endsWith('/read'))).toBe(false);
  list.seen(list.rows.value[0]); await list.markDisplayed();
  expect(api.mock.calls.find(([endpoint]) => endpoint.endsWith('/read'))?.[1]).toEqual({ source: 'peer', origin: 'https://r.example', recipientId: 'peer', ids: ['one'] });
  expect(list.rows.value[0].isRead).toBe(true);
 });
 it('groups reactions only within one account and reads all constituent IDs', async () => {
  const first = notice('peer', 'r1', 2, 'reaction'); first.remote!.note = { id: 'n' };
  const second = notice('peer', 'r2', 1, 'reaction'); second.remote!.note = { id: 'n' };
  respond = async endpoint => endpoint.endsWith('/read') ? { unreadCount: 0 } : page([first, second]);
  const list = mount(); await settle(); expect(list.rows.value).toHaveLength(1);
  list.seen(list.rows.value[0]); await list.markDisplayed();
  expect(api.mock.calls.find(([endpoint]) => endpoint.endsWith('/read'))?.[1]).toMatchObject({ ids: ['r1', 'r2'] });
 });
 it('retains confirmed reads when a slower page returns old flags and counts', async () => {
  let release!: (value: unknown) => void;
  respond = async (endpoint, p) => endpoint.endsWith('/read') ? { unreadCount: 0 } : p.mode === 'page' ? new Promise(resolve => { release = resolve; }) : page([notice('peer', 'one', 1)], 'older');
  const list = mount(); await settle(); const pending = list.older(); await settle();
  list.seen(list.rows.value[0]); await list.markDisplayed();
  release(page([notice('peer', 'other', 0)])); await pending;
  expect(list.rows.value[0].isRead).toBe(true); expect(linkedNotifications.count).toBe(0);
 });
 it('requeries a page which races an explicit all-read and leaves later arrivals unread', async () => {
  let release!: (value: unknown) => void; let queried = false;
  respond = async endpoint => {
   if (endpoint.endsWith('/read')) return { unreadCount: 0 };
   if (!queried) { queried = true; return new Promise(resolve => { release = resolve; }); }
   return page([notice('peer', 'new', 2), { ...notice('peer', 'old', 1), isRead: true }]);
  };
  const list = mount(); await settle(); await list.markAll(); release(page([notice('peer', 'old', 1)])); await settle();
  expect(list.rows.value.map(row => [row.id, row.isRead])).toEqual([['new', false], ['old', true]]);
 });
 it('removes failed protected sources from existing pages and keeps local rows', async () => {
  let failed = false;
  respond = async () => failed ? { ...page([notice('local', 'local', 1)]), complete: false, sources: [{ source: 'local', status: 'ok', unreadCount: 1 }, { source: 'peer', status: 'unauthorized', unreadCount: null }] } : page([notice('peer', 'one', 2), notice('local', 'local', 1)]);
  const list = mount(); await settle(); failed = true; await vi.advanceTimersByTimeAsync(10000); await settle();
  expect(list.rows.value.map(row => row.source)).toEqual(['local']); expect(list.error.value).toBe(true); expect(linkedNotifications.count).toBeNull();
 });
 it('hides expired bodies even while network requests are pending', async () => {
  respond = async (_, p) => p.cursor ? new Promise(() => {}) : page([notice('peer', 'one', 1)]);
  const list = mount(); await settle(); expect(JSON.stringify(list.rows.value)).toContain('protected');
  vi.advanceTimersByTime(10000); await settle();
  expect(JSON.stringify(list.rows.value)).not.toContain('protected'); expect(list.rows.value[0].suspended).toBe(true);
 });
 it('keeps hidden-tab bodies only within their lease and revalidates on return', async () => {
  let hidden = false; vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  respond = async () => page([notice('peer', 'one', 1)], 'older');
  const list = mount(); await settle(); const keys = list.rows.value.map(row => row.key);
  hidden = true; document.dispatchEvent(new Event('visibilitychange')); await settle();
  expect(list.rows.value.map(row => row.key)).toEqual(keys); expect(JSON.stringify(list.rows.value)).toContain('protected');
  await vi.advanceTimersByTimeAsync(10000);
  expect(JSON.stringify(list.rows.value)).not.toContain('protected');
  const callsBeforeResume = api.mock.calls.length;
  hidden = false; document.dispatchEvent(new Event('visibilitychange')); await settle();
  expect(JSON.stringify(list.rows.value)).toContain('protected');
  expect(api.mock.calls.slice(callsBeforeResume).map(([, p]) => (p as { mode?: string }).mode)).toEqual(['refresh']);
 });
 it('queues server-ordered arrivals while reading older rows and removes deleted queue entries', async () => {
  let arrived = false; let deleted = false;
  respond = async () => page([...arrived && !deleted ? [notice('peer', 'new', 2)] : [], notice('peer', 'old', 1)]);
  const list = mount(() => false); await settle(); expect(list.rows.value.map(row => row.id)).toEqual(['old']);
  arrived = true; await vi.advanceTimersByTimeAsync(10000); await settle();
  expect(list.queued.value).toBe(1); expect(list.rows.value.map(row => row.id)).toEqual(['old']);
  deleted = true; await vi.advanceTimersByTimeAsync(10000); await settle(); expect(list.queued.value).toBe(0);
 });
 it('keeps a failed read pending and queues explicit all-read behind an automatic read', async () => {
  let release!: (value: unknown) => void; let failed = true;
  respond = async (endpoint, p) => {
   if (!endpoint.endsWith('/read')) return page([notice('peer', 'one', 1)]);
   if (p.source === 'local' || p.all) return { unreadCount: 0 };
   if (failed) throw new Error('offline');
   return new Promise(resolve => { release = resolve; });
  };
  const list = mount(); await settle(); list.seen(list.rows.value[0]); await list.markDisplayed();
  expect(list.readError.value).toBe(true); expect(list.rows.value[0].isRead).toBe(false);
  failed = false; const pending = list.markDisplayed(); await settle(); const all = list.markAll(); await settle();
  expect(api.mock.calls.filter(([, p]) => (p as { source?: string; all?: boolean }).source === 'peer' && (p as { all?: boolean }).all)).toHaveLength(0);
  release({ unreadCount: 0 }); await pending; await all; expect(list.rows.value[0].isRead).toBe(true);
 });
 it('keeps local hard mute presentation without changing cursor logic', async () => {
  $i!.hardMutedWords = [['hiddenphrase']];
  try {
   const item = notice('peer', 'one', 1); item.remote!.body = 'hiddenphrase';
   respond = async () => page([item], 'older'); const list = mount(); await settle();
   expect(list.rows.value).toHaveLength(0); expect(list.hasMore.value).toBe(true);
  } finally { $i!.hardMutedWords = []; }
 });
});
