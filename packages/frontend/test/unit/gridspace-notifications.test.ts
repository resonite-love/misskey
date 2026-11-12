/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, createApp, nextTick } from 'vue';
import { useGridspaceNotifications } from '@/utility/use-gridspace-notifications.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { linkedNotifications } from '@/utility/gridspace-notification-state.js';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', hardMutedWords: [] } }));
vi.mock('@/accounts.js', () => ({ updateCurrentAccountPartial: vi.fn() }));
vi.mock('@/composables/use-note.js', () => ({ checkNoteWordMute: () => false }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { useGroupedNotifications: true } } }));
vi.mock('@/store.js', () => ({ store: { s: { realtimeMode: false } } }));
vi.mock('@/stream.js', () => ({ useStream: () => { throw new Error('WebSocket forbidden in polling mode'); } }));
vi.mock('@/utility/gridspace-notification-state.js', () => ({ linkedNotifications: { count: null, available: true }, refreshLinkedNotifications: vi.fn() }));

const api = vi.mocked(misskeyApi);
const at = (n: number) => new Date(1700000000000 + n * 1000).toISOString();
const notice = (n: number, id = String(n), type = 'test') => ({ id, createdAt: at(n), type, isRead: false, note: null as { id: string } | null, user: null, body: null, reaction: null });
const page = (source: string, items: ReturnType<typeof notice>[] = [], next: string | null = null, boundary = 0) => ({
	origin: source === 'peer' ? 'https://r.example' : 'https://g.example', recipientId: source, unreadCount: 5, next, newest: items[0]?.id ?? null, boundary: boundary ? at(boundary) : null,
	local: source === 'local' ? items.map(n => ({ ...n, notification: n })) : [], remote: source === 'peer' ? items : [],
});
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); await nextTick(); };
let respond: (endpoint: string, params: Record<string, unknown>) => Promise<unknown>;
let cleanup = () => {};
function mount() {
	let list!: ReturnType<typeof useGridspaceNotifications>;
	const app = createApp({ setup() { list = useGridspaceNotifications(computed(() => [])); return () => null; } });
	app.mount(document.createElement('div')); cleanup = () => app.unmount();
	return list;
}
beforeEach(() => { vi.useFakeTimers(); api.mockReset(); api.mockImplementation(((endpoint, params) => respond(endpoint, params ?? {})) as typeof misskeyApi); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('combined notifications', () => {
	it('retains equal short IDs across origins and holds the common page boundary', async () => {
		respond = async (_, p) => p.before ? page(String(p.source), [notice(1)]) : page(String(p.source), [notice(9, 'same'), notice(4)], '4', 4);
		const list = mount(); await settle();
		expect(list.rows.value).toHaveLength(2); expect(new Set(list.rows.value.map(n => n.key)).size).toBe(2);
		await list.older(); expect(list.rows.value).toHaveLength(6);
	});
	it('never marks background fetched notices read, and sends only seen source IDs', async () => {
		respond = async (endpoint, p) => endpoint.endsWith('/read') ? { unreadCount: 4 } : page(String(p.source), [notice(9), notice(8)]);
		const list = mount(); await settle();
		expect(api.mock.calls.some(([endpoint]) => endpoint.endsWith('/read'))).toBe(false);
		list.seen(list.rows.value.find(n => n.source === 'peer')!); await list.markDisplayed();
		const reads = api.mock.calls.filter(([endpoint]) => endpoint.endsWith('/read'));
		expect(reads).toHaveLength(1); expect(reads[0][1]).toEqual({ source: 'peer', ids: ['9'] });
	});
	it('groups same-source reactions and marks every constituent ID without merging accounts', async () => {
		respond = async (endpoint, p) => endpoint.endsWith('/read') ? { unreadCount: 0 } : p.source === 'local' ? page('local') : page('peer', [
			{ ...notice(9, 'r1', 'reaction'), note: { id: 'note' } } as ReturnType<typeof notice>,
			{ ...notice(8, 'r2', 'reaction'), note: { id: 'note' } } as ReturnType<typeof notice>,
		]);
		const list = mount(); await settle(); expect(list.rows.value).toHaveLength(1);
		list.seen(list.rows.value[0]); await list.markDisplayed();
		expect(api.mock.calls.find(([endpoint]) => endpoint.endsWith('/read'))?.[1]).toEqual({ source: 'peer', ids: ['r1', 'r2'] });
	});
	it('keeps older continuation when an initially empty source receives over one page', async () => {
		let arrived = false;
		respond = async (_, p) => !arrived || p.source === 'local' ? page(String(p.source)) : p.before ? page('peer', [notice(1)]) : p.since ? page('peer') : page('peer', [notice(99), notice(50)], '50', 50);
		const list = mount(); await settle(); expect(list.hasMore.value).toBe(false);
		arrived = true; await vi.advanceTimersByTimeAsync(10000); await settle();
		expect(list.hasMore.value).toBe(true); await list.older();
		expect(list.rows.value.map(n => n.id)).toEqual(['99', '50', '1']);
	});
	it('clears protected bodies on peer failure while local rows remain and count is unknown', async () => {
		let online = true;
		respond = async (_, p) => { if (p.source === 'peer' && !online) throw new Error('offline'); return page(String(p.source), [notice(9)]); };
		const list = mount(); await settle(); online = false;
		await vi.advanceTimersByTimeAsync(10000); await settle();
		expect(list.rows.value.every(n => n.source === 'local')).toBe(true); expect(list.error.value).toBe(true); expect(linkedNotifications.count).toBe(null);
	});
	it('invalidates delayed responses when the page is hidden', async () => {
		let release!: (value: unknown) => void;
		respond = async (_, p) => p.source === 'local' ? page('local', [notice(8)]) : new Promise(resolve => { release = resolve; });
		const list = mount(); await settle();
		vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange'));
		release(page('peer', [notice(9)])); await settle();
		expect(list.rows.value.some(n => n.source === 'peer')).toBe(false);
	});
});
