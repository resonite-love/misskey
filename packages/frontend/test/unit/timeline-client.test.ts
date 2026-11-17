/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, createApp, nextTick } from 'vue';
import type { entities } from 'misskey-js';
import type { TimelineItem, TimelineResponse } from '@/utility/timeline-client.js';
import { TimelineClient } from '@/utility/timeline-client.js';
import { useGridspaceHome } from '@/utility/use-gridspace-home.js';
import { Paginator } from '@/utility/paginator.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { timelineNoteContent } from '@/utility/timeline-note-content.js';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', hardMutedWords: [] } }));
vi.mock('@/utility/timeline-stream.js', () => ({ subscribeTimeline: vi.fn(() => () => {}) }));

const at = (value: number) => new Date(1700000000000 + value * 1000).toISOString();
const item = (id: string, delegated = true, validForMs: number | null = delegated ? 10000 : null): TimelineItem => ({
	key: `https://example.test/notes/${id}`, ref: `opaque:${id}`, sortKey: { sortAt: '1700000000000000', uri: `https://example.test/notes/${id}` },
	representation: delegated ? 'delegated' : 'normal', validForMs,
	payload: { id, uri: `https://example.test/notes/${id}`, createdAt: at(1), text: `body:${id}`, files: [] } as unknown as entities.Note,
});
const page = (items: TimelineItem[] = [], extra: Partial<TimelineResponse> = {}): TimelineResponse => ({
	version: 1, session: 'session', revision: 'revision', items, nextCursor: null, updatesCursor: 'updates', complete: true,
	mode: 'unified', sources: [], revalidateAfterMs: 10000, ...extra,
});
const clients: TimelineClient[] = [];
let cleanup = () => {};
const settle = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); await nextTick(); };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1700000000000); vi.mocked(misskeyApi).mockReset(); });
afterEach(() => { clients.splice(0).forEach(client => client.dispose()); cleanup(); cleanup = () => {}; vi.restoreAllMocks(); vi.useRealTimers(); });

function client(request: (...args: [string, Record<string, unknown>, AbortSignal]) => Promise<TimelineResponse>, isTop = () => true) {
	const value = new TimelineClient({ kind: 'home' }, { request: (endpoint, params, signal) => request(endpoint, params, signal), isTop, now: () => Date.now() });
	clients.push(value); return value;
}

describe('server timeline client', () => {
	it('refreshes content without remounting for reaction or vote counters', () => {
		const note = { text: 'body', reactions: { like: 1 }, poll: { choices: [{ text: 'A', votes: 1, isVoted: false }] }, renote: { text: 'quoted', reactionCount: 1 } };
		expect(timelineNoteContent(note)).toBe(timelineNoteContent({ ...note, reactions: { like: 2 }, poll: { choices: [{ text: 'A', votes: 3, isVoted: true }] }, renote: { text: 'quoted', reactionCount: 2 } }));
		expect(timelineNoteContent(note)).not.toBe(timelineNoteContent({ ...note, renote: { text: 'redacted', reactionCount: 1 } }));
	});
	it('uses server order and opaque cursor without source sorting or duplicate rows', async () => {
		const request = vi.fn().mockResolvedValueOnce(page([item('z', false), item('a')], { nextCursor: 'opaque-page' })).mockResolvedValueOnce(page([item('a'), item('m')]));
		const value = client(request); await value.reload(); await value.load();
		expect(value.rows.value.map(row => row.key)).toEqual(['z', 'a', 'm'].map(id => item(id).key));
		expect(request.mock.calls[1][1]).toMatchObject({ cursor: 'opaque-page' });
	});
	it('never rewinds the changes cursor when loading older history', async () => {
		const request = vi.fn().mockResolvedValueOnce(page([item('new', false)], { nextCursor: 'history', updatesCursor: 'first' }))
			.mockResolvedValueOnce(page([item('new', false)], { updatesCursor: 'newest' }))
			.mockResolvedValueOnce(page([item('old', false)], { updatesCursor: 'first' })).mockResolvedValueOnce(page());
		const value = client(request); await value.reload(); await value.refresh(); await value.load(); await value.refresh();
		expect(request.mock.calls[3][1]).toMatchObject({ updatesCursor: 'newest' });
	});
	it('uses collection time for row separators while keeping the note creation date', async () => {
		const favorite = item('saved', false); favorite.payload = { ...favorite.payload, collectionAt: at(5) } as typeof favorite.payload;
		const value = client(vi.fn().mockResolvedValue(page([favorite]))); await value.reload();
		expect(value.rows.value[0].createdAt).toBe(at(5));
		expect(value.rows.value[0]).toMatchObject({ note: { createdAt: at(1) } });
	});
	it('expires visible delegated and policy-dependent normal bodies while validation is still waiting', async () => {
		let finish!: (value: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('private'), item('normal', false, 10000), item('public', false)]))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const value = client(request); await value.reload();
		await vi.advanceTimersByTimeAsync(8000);
		expect(value.busy.value).toBe(true);
		await vi.advanceTimersByTimeAsync(2000);
		expect(value.rows.value.map(row => row.kind)).toEqual(['private', 'placeholder', 'normal']);
		expect(JSON.stringify(value.rows.value)).not.toContain('body:private');
		expect(JSON.stringify(value.rows.value)).not.toContain('body:normal');
		finish(page()); await settle();
	});
	it('counts authorization validity from request start and rejects an already expired response', async () => {
		const request = vi.fn().mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 11000); return page([item('slow')]); });
		const value = client(request); await value.reload();
		expect(value.rows.value[0]).toMatchObject({ kind: 'private', note: { suspended: true } });
		expect(JSON.stringify(value.rows.value)).not.toContain('body:slow');
	});
	it('discards a delayed response after hiding, retains row keys and restores through one request', async () => {
		let finish!: (value: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('secret')])).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const value = client(request); await value.reload(); const waiting = value.refresh(); await settle();
		value.suspend(); finish(page([item('secret')])); await waiting;
		expect(value.rows.value[0]).toMatchObject({ key: item('secret').key, note: { suspended: true } });
		request.mockResolvedValueOnce(page([item('secret')])); await Promise.all([value.resume(), value.resume()]);
		expect(request).toHaveBeenCalledTimes(3);
		expect(value.rows.value[0]).toMatchObject({ note: { text: 'body:secret' } });
	});
	it('includes queued rows in validation, strips them while hidden and does not release revoked bodies', async () => {
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false)]))
			.mockResolvedValueOnce(page([], { newItems: [item('new')] }));
		const value = client(request, () => false); await value.reload(); await value.refresh();
		expect(value.queuedCount.value).toBe(1);
		value.suspend(); request.mockResolvedValueOnce(page([], { removed: [item('new').key] })); await value.resume();
		expect(request.mock.calls[2][1]).toMatchObject({ refs: ['opaque:old', 'opaque:new'] });
		value.releaseQueue(); expect(value.queuedCount.value).toBe(0);
		expect(value.rows.value.map(row => row.key)).toEqual([item('old').key]);
	});
	it('separates validation batches from a single update cursor consumption', async () => {
		const all = Array.from({ length: 130 }, (_, index) => item(`${index}`, false));
		const request = vi.fn().mockResolvedValueOnce(page(all)).mockResolvedValue(page());
		const value = client(request); await value.reload(); await value.refresh();
		expect(request.mock.calls[1][1]).toMatchObject({ phase: 'validate', updatesCursor: 'updates' });
		expect(request.mock.calls[1][1].refs).toHaveLength(100);
		expect(request.mock.calls[2][1]).toMatchObject({ phase: 'changes', updatesCursor: 'updates' });
		expect(request.mock.calls[2][1].refs).toHaveLength(30);
	});
	it('handles a reset with a server window replacement and a stable anchor', async () => {
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false)], { nextCursor: 'past' }))
			.mockResolvedValueOnce(page([], { resetRequired: true })).mockResolvedValueOnce(page([item('new'), item('old', false)], { nextCursor: 'replacement-past' }));
		const value = client(request, () => false); await value.reload(); await value.refresh();
		expect(request.mock.calls[2][1]).toMatchObject({ anchor: item('old').key });
		expect(value.rows.value.map(row => row.key)).toEqual([item('old').key]);
		expect(value.queuedCount.value).toBe(1); value.releaseQueue();
		expect(value.rows.value.map(row => row.key)).toEqual([item('new').key, item('old').key]);
	});
	it('reanchors a delayed reset before replacing the newly visible window', async () => {
		let anchor = item('old').key;
		let finish!: (value: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false), item('lower', false)]))
			.mockResolvedValueOnce(page([], { resetRequired: true }))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
			.mockResolvedValueOnce(page([item('lower', false), item('below', false)]));
		const value = new TimelineClient({ kind: 'home' }, { request: (endpoint, params, signal) => request(endpoint, params, signal), anchor: () => anchor, now: () => Date.now() });
		clients.push(value); await value.reload(); const waiting = value.refresh(); await settle();
		anchor = item('lower').key; finish(page([item('old', false)])); await waiting;
		expect(request.mock.calls[3][1]).toMatchObject({ anchor: item('lower').key });
		expect(value.rows.value.map(row => row.key)).toEqual([item('lower').key, item('below').key]);
	});
	it.each(['INVALID_CURSOR', 'CURSOR_EXPIRED'])('reopens an expired %s changes session around the current anchor', async reason => {
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false)]))
			.mockRejectedValueOnce({ info: { reason } }).mockResolvedValueOnce(page([item('old', false)], { session: 'new-session' }));
		const value = client(request); await value.reload(); await value.refresh();
		expect(request.mock.calls[2][1]).toMatchObject({ anchor: item('old').key });
		expect(value.error.value).toBe(false);
	});
	it('reopens an expired history page instead of retrying its invalid cursor', async () => {
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false)], { nextCursor: 'expired' }))
			.mockRejectedValueOnce({ info: { reason: 'INVALID_CURSOR' } }).mockResolvedValueOnce(page([item('old', false)], { session: 'new-session', nextCursor: 'replacement' }));
		const value = client(request); await value.reload(); await value.load();
		expect(request.mock.calls[2][1]).toMatchObject({ anchor: item('old').key });
		expect(request.mock.calls[2][1]).not.toHaveProperty('cursor');
		expect(value.hasMore.value).toBe(true);
	});
	it('uses a separate local-fallback cursor during failure and restores the unified window', async () => {
		const request = vi.fn().mockResolvedValueOnce(page([item('local', false)], { complete: false, nextCursor: 'unified-stalled' }))
			.mockResolvedValueOnce(page([item('local', false), item('older', false)], { mode: 'local-fallback', nextCursor: 'local-cursor', session: 'fallback' }))
			.mockResolvedValueOnce(page([item('local', false), item('peer')], { session: 'restored' }));
		const value = client(request); await value.reload(); await value.load();
		expect(request.mock.calls[1][1]).toMatchObject({ mode: 'local-fallback', anchor: item('local').key });
		expect(request.mock.calls[1][1]).not.toHaveProperty('cursor');
		expect(value.error.value).toBe(true);
		await value.refresh();
		expect(request.mock.calls[2][1]).toMatchObject({ mode: 'unified' });
		expect(value.error.value).toBe(false);
	});
	it('coalesces invalidation hints and stops its subscription while suspended', async () => {
		let invalidate!: () => void;
		const dispose = vi.fn();
		const subscribe = vi.fn((_params, callback) => { invalidate = callback; return dispose; });
		const request = vi.fn().mockResolvedValue(page([item('local', false)]));
		const value = new TimelineClient({ kind: 'home' }, { request, subscribe, now: () => Date.now() });
		clients.push(value); await value.reload();
		invalidate();
		await vi.advanceTimersByTimeAsync(1000); invalidate();
		await vi.advanceTimersByTimeAsync(1000); invalidate();
		await vi.advanceTimersByTimeAsync(5999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(request).toHaveBeenCalledTimes(2);
		for (let second = 0; second < 7; second++) { invalidate(); await vi.advanceTimersByTimeAsync(1000); }
		expect(request).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1000);
		expect(request).toHaveBeenCalledTimes(3);
		value.suspend(); expect(dispose).toHaveBeenCalledOnce();
		await value.resume(); expect(subscribe).toHaveBeenCalledTimes(2);
	});
	it('keeps manual refresh and reconnect immediate while moving the passive poll after them', async () => {
		let invalidate!: () => void; let reconnect!: () => void;
		const subscribe = vi.fn((_params, hint, connected) => { invalidate = hint; reconnect = connected; return () => {}; });
		const request = vi.fn().mockResolvedValue(page([item('local', false)]));
		const value = new TimelineClient({ kind: 'home' }, { request, subscribe, now: () => Date.now() });
		clients.push(value); await value.reload();
		await vi.advanceTimersByTimeAsync(1000); invalidate();
		await value.refresh(); expect(request).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1000); reconnect(); await settle();
		expect(request).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(7999); expect(request).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1); expect(request).toHaveBeenCalledTimes(4);
	});
	it('does not follow a slow in-flight poll with an extra hint request', async () => {
		let invalidate!: () => void;
		let finish!: (value: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('local', false)]))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(page([item('local', false)]));
		const subscribe = vi.fn((_params, hint) => { invalidate = hint; return () => {}; });
		const value = new TimelineClient({ kind: 'home' }, { request, subscribe, now: () => Date.now() });
		clients.push(value); await value.reload();
		await vi.advanceTimersByTimeAsync(8000); expect(request).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1000); invalidate();
		await vi.advanceTimersByTimeAsync(3000); finish(page([item('local', false)])); await settle();
		await vi.advanceTimersByTimeAsync(3999); expect(request).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1); expect(request).toHaveBeenCalledTimes(3);
	});
	it('renews a leased body early enough for a three-second response before its deadline', async () => {
		const starts: number[] = [];
		const request = vi.fn(() => {
			starts.push(Date.now());
			return new Promise<TimelineResponse>(resolve => window.setTimeout(() => resolve(page([item('private')])), 3000));
		});
		const value = client(request);
		const initial = value.reload(); await vi.advanceTimersByTimeAsync(3000); await initial;
		expect(value.rows.value[0]).toMatchObject({ note: { text: 'body:private' } });
		await vi.advanceTimersByTimeAsync(2999); expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1); expect(request).toHaveBeenCalledTimes(2);
		expect(starts[1] - starts[0]).toBe(6000);
		await vi.advanceTimersByTimeAsync(3000);
		expect(value.rows.value[0]).toMatchObject({ note: { text: 'body:private' } });
		await vi.advanceTimersByTimeAsync(1000);
		expect(value.rows.value[0]).toMatchObject({ note: { text: 'body:private' } });
	});
	it('uses the earliest queued lease to advance the shared timer without extra hint calls', async () => {
		let invalidate!: () => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('visible')]))
			.mockResolvedValueOnce(page([item('visible')], { newItems: [item('queued', true, 6000)] }))
			.mockResolvedValue(page([item('visible'), item('queued')]));
		const value = new TimelineClient({ kind: 'home' }, {
			request, isTop: () => false, now: () => Date.now(), subscribe: (_params, hint) => { invalidate = hint; return () => {}; },
		});
		clients.push(value); await value.reload(); await value.refresh();
		invalidate(); await vi.advanceTimersByTimeAsync(2000); invalidate();
		await vi.advanceTimersByTimeAsync(1999); expect(request).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1); expect(request).toHaveBeenCalledTimes(3);
	});
	it('rebinds queued rows to a replacement session in server order before allowing release', async () => {
		const queued = item('queued'); const fresh = { ...item('queued'), ref: 'new:queued' };
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false)]))
			.mockResolvedValueOnce(page([], { newItems: [queued] }))
			.mockResolvedValueOnce(page([], { resetRequired: true }))
			.mockResolvedValueOnce(page([item('newer'), item('old', false)], {
				session: 'replacement', retainedItems: [fresh], order: [item('newer').key, queued.key, item('old').key],
			}));
		const value = client(request, () => false); await value.reload(); await value.refresh(); await value.refresh();
		expect(request.mock.calls[3][1]).toMatchObject({ previousSession: 'session', previousRevision: 'revision', retainedRefs: ['opaque:queued'] });
		expect(value.queuedCount.value).toBe(2);
		value.releaseQueue();
		expect(value.rows.value.map(row => row.key)).toEqual([item('newer').key, queued.key, item('old').key]);
		request.mockResolvedValueOnce(page([], { session: 'replacement' })); await value.refresh();
		expect(request.mock.calls.at(-1)![1]).toMatchObject({ session: 'replacement' });
		expect(request.mock.calls.at(-1)![1].refs).toContain('new:queued');
	});
	it('reopens from the head after multiple updates overflow the queue and pages through every new row', async () => {
		const old = item('old', false);
		const batches = Array.from({ length: 3 }, (_, batch) => Array.from({ length: 50 }, (_, index) => item(`new-${batch * 50 + 49 - index}`, false)));
		const ordered = [...batches[2], ...batches[1], ...batches[0], old];
		let finish!: (value: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([old], { updatesCursor: 'u0', nextCursor: 'original-history' }))
			.mockResolvedValueOnce(page([], { newItems: batches[0], updatesCursor: 'u1' }))
			.mockResolvedValueOnce(page([], { newItems: batches[1], updatesCursor: 'u2' }))
			.mockResolvedValueOnce(page([]))
			.mockResolvedValueOnce(page([], { newItems: batches[2], updatesCursor: 'u3' }))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		for (let offset = 30; offset < ordered.length; offset += 30) {
			request.mockResolvedValueOnce(page(ordered.slice(offset, offset + 30), { session: 'reopened', nextCursor: offset + 30 < ordered.length ? `reopened-${offset + 30}` : null }));
		}
		const value = client(request, () => false); await value.reload();
		await value.refresh(); await value.refresh(); await value.refresh();
		expect(value.queuedCount.value).toBe(100);
		const releasing = value.releaseQueue(); await settle();
		expect(request.mock.calls[5][0]).toBe('gridspace/timeline');
		expect(request.mock.calls[5][1]).not.toHaveProperty('anchor');
		expect(request.mock.calls[5][1]).not.toHaveProperty('cursor');
		expect(request.mock.calls[5][1]).not.toHaveProperty('retainedRefs');
		expect(value.rows.value.map(row => row.key)).toEqual([old.key]);
		finish(page(ordered.slice(0, 30), { session: 'reopened', nextCursor: 'reopened-30' })); await releasing;
		expect(value.queuedCount.value).toBe(0);
		while (value.hasMore.value) await value.load();
		expect(value.rows.value.map(row => row.key)).toEqual(ordered.map(row => row.key));
		expect(request.mock.calls[6][1]).toMatchObject({ cursor: 'reopened-30' });
	});
	it('keeps overflow recovery pending after failure instead of releasing an incomplete queue', async () => {
		const old = item('old', false);
		const request = vi.fn().mockResolvedValueOnce(page([old]))
			.mockResolvedValueOnce(page([], { newItems: Array.from({ length: 101 }, (_, index) => item(`new-${index}`, false)) }))
			.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page([item('fresh', false)], { session: 'reopened' }));
		const value = client(request, () => false); await value.reload(); await value.refresh(); await value.releaseQueue();
		expect(value.rows.value.map(row => row.key)).toEqual([old.key]);
		expect(value.queuedCount.value).toBe(100); expect(value.error.value).toBe(true);
		await value.refresh();
		expect(request.mock.calls[3][1]).not.toHaveProperty('anchor');
		expect(value.rows.value.map(row => row.key)).toEqual([item('fresh').key]);
		expect(value.queuedCount.value).toBe(0);
	});
});

describe('home capability dispatch', () => {
	it('uses only the integrated endpoint when the server advertises the kind', async () => {
		const api = vi.mocked(misskeyApi);
		api.mockResolvedValueOnce({ timeline: { enabled: true, version: 1, kinds: ['home', 'social'] } } as never).mockResolvedValueOnce(page([item('native', false)]) as never);
		const normal = new Paginator('notes/timeline', {});
		const init = vi.spyOn(normal, 'init');
		let home!: ReturnType<typeof useGridspaceHome>;
		const app = createApp({ setup() { home = useGridspaceHome(normal, computed(() => ({ mode: 'home' })), () => true, computed(() => true)); return () => null; } });
		app.mount(window.document.createElement('div')); cleanup = () => app.unmount(); await settle();
		expect(home.integrated.value).toBe(true); expect(init).not.toHaveBeenCalled();
		expect(api.mock.calls.map(call => call[0])).toEqual(['gridspace/link', 'gridspace/timeline']);
	});
	it('keeps the old reader when capability is absent', async () => {
		const api = vi.mocked(misskeyApi);
		api.mockImplementation(async (endpoint) => endpoint === 'gridspace/link' ? {} : endpoint === 'gridspace/private-grant' ? { available: false, granted: false } : [] as never);
		const normal = new Paginator('notes/timeline', {});
		let home!: ReturnType<typeof useGridspaceHome>;
		const app = createApp({ setup() { home = useGridspaceHome(normal, computed(() => ({ mode: 'home' })), () => true, computed(() => true)); return () => null; } });
		app.mount(window.document.createElement('div')); cleanup = () => app.unmount(); await settle();
		expect(home.integrated.value).toBe(false);
		expect(api.mock.calls.map(call => call[0])).toContain('notes/timeline');
		expect(api.mock.calls.map(call => call[0])).toContain('gridspace/private-grant');
	});
});
