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
import { subscribeTimeline } from '@/utility/timeline-stream.js';

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
	it('upgrades a read-only origin body to one actionable mirror under the same canonical key', async () => {
		const request = vi.fn().mockResolvedValueOnce(page([{ ...item('one'), readOnly: true }]))
			.mockResolvedValueOnce(page([item('one', false)]));
		const value = client(request);
		await value.reload();
		expect(value.rows.value).toMatchObject([{ kind: 'private', readOnly: true, key: item('one').key }]);
		await value.reload();
		expect(value.rows.value).toMatchObject([{ kind: 'normal', key: item('one').key }]);
	});
	it('prepends authorized stream notes at the top without another HTTP request or duplicate sound', async () => {
		const onNewItems = vi.fn();
		const request = vi.fn().mockResolvedValue(page([item('old', false)]));
		const value = new TimelineClient({ kind: 'home' }, { request, onNewItems, now: () => Date.now() });
		clients.push(value); await value.reload();
		const event = { session: 'session', revision: 'revision', item: item('posted', false), leaseElapsedMs: 0 };
		value.receive(event); value.receive(event);
		expect(value.rows.value.map(row => row.key)).toEqual([item('posted').key, item('old').key]);
		expect(request).toHaveBeenCalledOnce(); expect(onNewItems).toHaveBeenCalledOnce();
	});
	it('queues stream notes while reading history or while updates are paused', async () => {
		let top = false; let paused = false;
		const value = new TimelineClient({ kind: 'home' }, { request: vi.fn().mockResolvedValue(page()), isTop: () => top, isPaused: () => paused });
		clients.push(value); await value.reload();
		value.receive({ session: 'session', revision: 'revision', item: item('history', false) });
		top = true; paused = true;
		value.receive({ session: 'session', revision: 'revision', item: item('paused', false) });
		expect(value.rows.value).toHaveLength(0); expect(value.queuedCount.value).toBe(2);
		paused = false; await value.releaseQueue();
		expect(value.rows.value.map(row => row.key)).toEqual([item('paused').key, item('history').key]);
	});
	it('keeps a stream note that arrives while an older changes response is in flight', async () => {
		let finish!: (value: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false)]))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const value = client(request); await value.reload(); const waiting = value.refresh();
		value.receive({ session: 'session', revision: 'revision', item: item('posted', false) });
		finish(page([item('old', false)], { removed: [item('posted').key] })); await waiting;
		expect(value.rows.value.map(row => row.key)).toEqual([item('posted').key, item('old').key]);
	});
	it('does not add old-session stream events to a replacement window', async () => {
		let finish!: (value: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false)]))
			.mockResolvedValueOnce(page([], { resetRequired: true }))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const value = client(request); await value.reload(); const waiting = value.refresh(); await settle();
		value.receive({ session: 'session', revision: 'revision', item: item('posted', false) });
		finish(page([item('new-head', false), item('posted', false)], { session: 'new-session' })); await waiting;
		expect(value.rows.value.map(row => row.key)).toEqual([item('new-head').key, item('posted').key]);
		value.receive({ session: 'session', revision: 'revision', item: item('stale', false) });
		expect(value.rows.value).toHaveLength(2);
	});
	it('uses the subscription monotonic origin for delayed stream leases and drops hidden events', async () => {
		const request = vi.fn().mockResolvedValue(page([item('old', false)]));
		const value = new TimelineClient({ kind: 'home' }, { request, now: () => Date.now(), subscribe: () => () => {} });
		clients.push(value); await value.reload();
		vi.setSystemTime(Date.now() + 12000);
		value.receive({ session: 'session', revision: 'revision', item: item('delayed'), leaseElapsedMs: 1000 });
		expect(value.rows.value[0]).toMatchObject({ note: { suspended: true } });
		value.suspend();
		value.receive({ session: 'session', revision: 'revision', item: item('hidden', false) });
		expect(value.rows.value.some(row => row.key === item('hidden').key)).toBe(false);
	});
	it('uses HTTP recovery for a reset stream event after the active request completes', async () => {
		let finish!: (value: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false)]))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(page());
		const value = client(request); await value.reload(); const waiting = value.refresh();
		value.receive({ session: 'session', revision: 'revision', resetRequired: true });
		expect(request).toHaveBeenCalledTimes(2);
		finish(page([item('old', false)])); await waiting; await settle();
		expect(request).toHaveBeenCalledTimes(3);
	});
	it('retains a new-session recovery indicator if a late old-session event misses an anchored snapshot', async () => {
		let finish!: (value: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false)]))
			.mockResolvedValueOnce(page([], { resetRequired: true }))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
			.mockResolvedValueOnce(page([item('posted', false), item('old', false)], { session: 'head-session' }));
		const value = client(request, () => false); await value.reload(); const waiting = value.refresh(); await settle();
		value.receive({ session: 'session', revision: 'revision', item: item('posted', false) });
		finish(page([item('old', false)], { session: 'anchored-session' })); await waiting;
		expect(value.queuedCount.value).toBe(1);
		expect(value.rows.value.map(row => row.key)).toEqual([item('old').key]);
		await value.releaseQueue();
		expect(request.mock.calls.at(-1)![1]).not.toHaveProperty('anchor');
		expect(value.rows.value.map(row => row.key)).toEqual([item('posted').key, item('old').key]);
	});
	it('recovers server order when an older HTTP insertion races a newer stream event', async () => {
		let finish!: (value: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false)]))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
			.mockResolvedValueOnce(page([item('newest', false), item('between', false), item('old', false)]));
		const value = client(request); await value.reload(); const waiting = value.refresh();
		value.receive({ session: 'session', revision: 'revision', item: item('newest', false) });
		finish(page([], { newItems: [item('between', false)] })); await waiting;
		expect(value.rows.value.map(row => row.key)).toEqual([item('newest').key, item('between').key, item('old').key]);
	});
	it('does not lose an accepted stream note when scrolling causes a second replacement request', async () => {
		let anchor = item('old').key;
		let finish!: (value: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false), item('lower', false)]))
			.mockResolvedValueOnce(page([], { resetRequired: true }))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
			.mockResolvedValueOnce(page([item('lower', false)], { session: 'replacement' }));
		const value = new TimelineClient({ kind: 'home' }, { request, anchor: () => anchor, isTop: () => false });
		clients.push(value); await value.reload(); const waiting = value.refresh(); await settle();
		value.receive({ session: 'session', revision: 'revision', item: item('arrived', false) });
		anchor = item('lower').key;
		finish(page([item('old', false)], { session: 'replacement', nextCursor: 'restore-lower' })); await waiting;
		expect(value.queuedCount.value).toBe(1);
		expect(request.mock.calls[3][1]).toMatchObject({ cursor: 'restore-lower' });
	});
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
		expect(value.rows.value[0]).toMatchObject({ key: item('secret').key, note: { text: 'body:secret' } });
		request.mockResolvedValueOnce(page([item('secret')])); await Promise.all([value.resume(), value.resume()]);
		expect(request).toHaveBeenCalledTimes(3);
		expect(value.rows.value[0]).toMatchObject({ note: { text: 'body:secret' } });
	});
	it('includes queued rows in validation and does not release revoked bodies after resuming', async () => {
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false)]))
			.mockResolvedValueOnce(page([], { newItems: [item('new')] }));
		const value = client(request, () => false); await value.reload(); await value.refresh();
		expect(value.queuedCount.value).toBe(1);
		value.suspend(); request.mockResolvedValueOnce(page([], { removed: [item('new').key] })); await value.resume();
		expect(request.mock.calls[2][1]).toMatchObject({ refs: ['opaque:old', 'opaque:new'] });
		value.releaseQueue(); expect(value.queuedCount.value).toBe(0);
		expect(value.rows.value.map(row => row.key)).toEqual([item('old').key]);
	});
	it('keeps an expired hidden snapshot visible while the resume check is pending, then removes revoked rows', async () => {
		let finish!: (value: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('secret')]))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const value = client(request); await value.reload(); value.suspend();
		await vi.advanceTimersByTimeAsync(30000);
		const resumed = value.resume();
		expect(value.rows.value[0]).toMatchObject({ note: { text: 'body:secret' } });
		finish(page([], { removed: [item('secret').key] })); await resumed;
		expect(value.rows.value).toEqual([]);
	});
	it('bounds the resumed snapshot when the server never answers', async () => {
		const request = vi.fn().mockResolvedValueOnce(page([item('secret')])).mockImplementationOnce(() => new Promise(() => {}));
		const value = client(request); await value.reload(); value.suspend();
		await vi.advanceTimersByTimeAsync(30000); void value.resume();
		await vi.advanceTimersByTimeAsync(14999);
		expect(JSON.stringify(value.rows.value)).toContain('body:secret');
		await vi.advanceTimersByTimeAsync(1);
		expect(JSON.stringify(value.rows.value)).not.toContain('body:secret');
	});
	it('removes an expired resumed snapshot when authorization fails', async () => {
		const request = vi.fn().mockResolvedValueOnce(page([item('secret')]))
			.mockRejectedValueOnce({ info: { reason: 'AUTHORIZATION_REVOKED' } });
		const value = client(request); await value.reload(); value.suspend();
		await vi.advanceTimersByTimeAsync(30000); await value.resume();
		expect(JSON.stringify(value.rows.value)).not.toContain('body:secret');
		expect(value.failed.value).toBe(true);
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
	it('queues new head rows on reset while preserving the visible anchor', async () => {
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false)], { nextCursor: 'past' }))
			.mockResolvedValueOnce(page([], { resetRequired: true })).mockResolvedValueOnce(page([item('new'), item('old', false)], { nextCursor: 'replacement-past' }));
		const value = client(request, () => false); await value.reload(); await value.refresh();
		expect(request.mock.calls[2][1]).not.toHaveProperty('anchor');
		expect(value.rows.value.map(row => row.key)).toEqual([item('old').key]);
		expect(value.queuedCount.value).toBe(1); value.releaseQueue();
		expect(value.rows.value.map(row => row.key)).toEqual([item('new').key, item('old').key]);
	});
	it.each(['home', 'channel'])('keeps reauthorized %s bodies visible while a reset window is loading', async kind => {
		let finish!: (value: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('allowed'), item('revoked')]))
			.mockResolvedValueOnce(page([item('allowed')], { resetRequired: true, removed: [item('revoked').key] }))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const value = new TimelineClient({ kind }, { request, now: () => Date.now() });
		clients.push(value); await value.reload();
		await vi.advanceTimersByTimeAsync(7000);
		const waiting = value.refresh(); await settle();
		await vi.advanceTimersByTimeAsync(3500);
		expect(value.rows.value).toHaveLength(1);
		expect(value.rows.value[0]).toMatchObject({ note: { text: 'body:allowed' } });
		expect(JSON.stringify(value.rows.value)).not.toContain('body:revoked');
		finish(page([item('allowed')], { session: 'replacement' })); await waiting;
	});
	it('retains a valid body on a transient failure but removes it at its authorization deadline', async () => {
		const request = vi.fn().mockResolvedValueOnce(page([item('allowed', true, 60000)]))
			.mockRejectedValue(new Error('offline'));
		const value = client(request); await value.reload(); await value.refresh();
		expect(value.rows.value[0]).toMatchObject({ note: { text: 'body:allowed' } });
		await vi.advanceTimersByTimeAsync(60000);
		expect(JSON.stringify(value.rows.value)).not.toContain('body:allowed');
	});
	it.each(['home', 'channel'])('keeps the %s body through repeated thirty-second recovery checks', async kind => {
		const request = vi.fn().mockResolvedValue(page([item('allowed', true, 60000)], { revalidateAfterMs: 30000 }));
		const value = new TimelineClient({ kind }, { request, now: () => Date.now() });
		clients.push(value); await value.reload();
		for (let seconds = 0; seconds < 150; seconds++) {
			await vi.advanceTimersByTimeAsync(1000);
			expect(value.rows.value[0]).toMatchObject({ note: { text: 'body:allowed' } });
		}
		expect(request).toHaveBeenCalledTimes(6);
	});
	it('removes bodies immediately when the server explicitly revokes authorization', async () => {
		const request = vi.fn().mockResolvedValueOnce(page([item('allowed', true, 60000)]))
			.mockRejectedValueOnce({ info: { reason: 'AUTHORIZATION_REVOKED' } });
		const value = client(request); await value.reload(); await value.refresh();
		expect(JSON.stringify(value.rows.value)).not.toContain('body:allowed');
	});
	it('restores the full range when scrolling during a delayed reset', async () => {
		let anchor = item('old').key;
		let finish!: (value: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false), item('lower', false)]))
			.mockResolvedValueOnce(page([], { resetRequired: true }))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
			.mockResolvedValueOnce(page([item('lower', false), item('below', false)]));
		const value = new TimelineClient({ kind: 'home' }, { request: (endpoint, params, signal) => request(endpoint, params, signal), anchor: () => anchor, now: () => Date.now() });
		clients.push(value); await value.reload(); const waiting = value.refresh(); await settle();
		anchor = item('lower').key; finish(page([item('old', false)], { nextCursor: 'restore-lower' })); await waiting;
		expect(request.mock.calls[3][1]).toMatchObject({ cursor: 'restore-lower' });
		expect(value.rows.value.map(row => row.key)).toEqual([item('old').key, item('lower').key, item('below').key]);
	});
	it.each([
		{ kind: 'home' },
		{ kind: 'channel', channelOrigin: 'https://local.example', channelId: 'channel' },
		{ kind: 'channel', channelOrigin: 'https://peer.example', channelId: 'channel' },
	].flatMap(query => [true, false].flatMap(atTop => ['INVALID_CURSOR', 'CURSOR_EXPIRED'].map(reason => ({ query, atTop, reason })))))('recovers missed new posts after an expired $query.kind update (top=$atTop, $reason)', async ({ query, atTop, reason }) => {
		const [newHead, oldHead, tail] = ['missed-new', 'old-head', 'old-tail'].map((id, index) => ({
			...item(id, false), sortKey: { sortAt: String(10 - index), uri: id },
		}));
		const listing = [newHead, oldHead, tail];
		const request = vi.fn().mockResolvedValueOnce(page([oldHead, tail]))
			.mockRejectedValueOnce({ info: { reason } })
			.mockImplementationOnce((_endpoint, params) => {
				const start = params.anchor ? listing.findIndex(row => row.key === params.anchor) : 0;
				return Promise.resolve(page(listing.slice(start), { session: 'renewed-session' }));
			});
		const value = new TimelineClient(query, { request, isTop: () => atTop, anchor: () => oldHead.key, now: () => Date.now() });
		clients.push(value);
		await value.reload(); value.suspend(); await value.resume();
		expect(value.rows.value.map(row => row.key)).toEqual((atTop ? listing : [oldHead, tail]).map(row => row.key));
		expect(value.queuedCount.value).toBe(atTop ? 0 : 1);
		await value.releaseQueue();
		expect(value.rows.value.map(row => row.key)).toEqual(listing.map(row => row.key));
		expect(value.error.value).toBe(false);
	});
	it.each(['INVALID_CURSOR', 'CURSOR_EXPIRED'])('reopens an expired %s changes session from the latest head', async reason => {
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false)]))
			.mockRejectedValueOnce({ info: { reason } }).mockResolvedValueOnce(page([item('old', false)], { session: 'new-session' }));
		const value = client(request); await value.reload(); await value.refresh();
		expect(request.mock.calls[2][1]).not.toHaveProperty('anchor');
		expect(value.error.value).toBe(false);
	});
	it('restores more than 64 pages after a long history session expires', async () => {
		const history = Array.from({ length: 2400 }, (_, index) => ({ ...item(`deep-${index}`, false), sortKey: { sortAt: String(3000 - index), uri: String(index) } }));
		const request = vi.fn().mockResolvedValueOnce(page(history, { nextCursor: 'expired' }))
			.mockRejectedValueOnce({ info: { reason: 'INVALID_CURSOR' } });
		for (let offset = 0; offset < history.length; offset += 30) {
			request.mockResolvedValueOnce(page(history.slice(offset, offset + 30), { session: 'restored', nextCursor: offset + 30 < history.length ? `older-${offset + 30}` : 'next-page' }));
		}
		const value = client(request, () => false);
		await value.reload(); await value.load();
		expect(value.error.value).toBe(false);
		expect(value.rows.value.map(row => row.key)).toEqual(history.map(row => row.key));
		request.mockResolvedValueOnce(page([item('older-than-history', false)], { session: 'restored' }));
		await value.load();
		expect(request.mock.calls.at(-1)![1]).toMatchObject({ cursor: 'next-page' });
		expect(value.rows.value).toHaveLength(2401);
	});
	it.each([
		{ kind: 'home' }, { kind: 'social' }, { kind: 'channel', channelId: 'channel' }, { kind: 'antenna', antennaId: 'antenna' },
		{ kind: 'clip', clipId: 'clip' }, { kind: 'search', query: 'word' }, { kind: 'profile', userId: 'author' },
		{ kind: 'mentions' }, { kind: 'direct' }, { kind: 'favorites' },
	])('rebuilds the loaded $kind range before replacing it, including a revoked row', async query => {
		const history = Array.from({ length: 210 }, (_, index) => ({ ...item(`history-${index}`, false), sortKey: { sortAt: String(1000 - index), uri: `https://example.test/notes/history-${index}` } }));
		const allowed = history.filter((_, index) => index !== 50).map(note => ({ ...note, ref: `renewed:${note.ref}` }));
		const request = vi.fn().mockResolvedValueOnce(page(history, { nextCursor: 'old-history' }))
			.mockResolvedValueOnce(page(history.slice(0, 100)))
			.mockResolvedValueOnce(page(history.slice(100, 200)))
			.mockResolvedValueOnce(page(history.slice(200), { resetRequired: true }));
		for (let offset = 0; offset < allowed.length; offset += 30) {
			request.mockResolvedValueOnce(page(allowed.slice(offset, offset + 30), { session: 'replacement', nextCursor: offset + 30 < allowed.length ? `restore-${offset + 30}` : 'older-history' }));
		}
		const value = new TimelineClient(query, { request, isTop: () => false, anchor: () => history[180].key, now: () => Date.now() });
		clients.push(value); await value.reload(); await value.refresh();
		expect(value.rows.value.map(row => row.key)).toEqual(allowed.map(row => row.key));
		expect(request.mock.calls[4][1]).not.toHaveProperty('anchor');
		expect(request.mock.calls[4][1]).not.toHaveProperty('anchorRef');
		request.mockResolvedValueOnce(page([], { session: 'replacement' })); await value.load();
		expect(request.mock.calls.at(-1)![1]).toMatchObject({ cursor: 'older-history' });
	});
	it.each([
		{ query: { kind: 'channel', channelOrigin: 'https://peer.example', channelId: 'channel' }, atTop: true },
		{ query: { kind: 'channel', channelOrigin: 'https://peer.example', channelId: 'channel' }, atTop: false },
		{ query: { kind: 'home' }, atTop: true },
		{ query: { kind: 'social' }, atTop: false },
	])('restores the new placement head and authorized tail on $query.kind reset (at top=$atTop)', async ({ query, atTop }) => {
		const rows = ['newly-placed', 'old-head', 'removed', 'old-tail'].map((key, i) => ({
			...item(key, false), sortKey: { sortAt: String(10 - i), uri: key },
		}));
		const [newHead, oldHead, removed, tail] = rows;
		const listing = [newHead, oldHead, tail];
		const request = vi.fn().mockResolvedValueOnce(page([oldHead, removed, tail]))
			.mockResolvedValueOnce(page([], { newItems: [], removed: [removed.key], resetRequired: true }))
			.mockImplementationOnce((_endpoint, params) => {
				// The server excludes rows ahead of the supplied anchor.
				const start = params.anchor ? listing.findIndex(row => row.key === params.anchor) : 0;
				return Promise.resolve(page(listing.slice(start, start + 2), { session: 'replacement', nextCursor: start === 0 ? 'tail' : null }));
			})
			.mockResolvedValueOnce(page([tail], { session: 'replacement' }));
		const onNewItems = vi.fn();
		const value = new TimelineClient(query, { request, isTop: () => atTop, anchor: () => tail.key, onNewItems, now: () => Date.now() });
		clients.push(value); await value.reload(); await value.refresh();
		expect(value.rows.value.map(row => row.key)).toEqual((atTop ? listing : [oldHead, tail]).map(row => row.key));
		expect(value.queuedCount.value).toBe(atTop ? 0 : 1);
		expect(onNewItems).toHaveBeenCalledWith([expect.objectContaining({ key: newHead.key })]);
		await value.releaseQueue();
		expect(value.rows.value.map(row => row.key)).toEqual(listing.map(row => row.key));
		expect(request.mock.calls[3][1]).toMatchObject({ cursor: 'tail' });
	});
	it('restores the signed upper bound after a history cursor expires with multiple retained rows', async () => {
		const [first, last] = [item('old-first', false), item('old-last', false)];
		const request = vi.fn().mockResolvedValueOnce(page([first, last], { nextCursor: 'expired' }))
			.mockRejectedValueOnce({ info: { reason: 'CURSOR_EXPIRED' } })
			.mockResolvedValueOnce(page([first, last], { session: 'replacement' }));
		const value = client(request); await value.reload(); await value.load();
		expect(request.mock.calls[2][1]).toMatchObject({ anchor: first.key, anchorRef: first.ref, previousSession: 'session', previousRevision: 'revision' });
		expect(value.rows.value.map(row => row.key)).toEqual([first.key, last.key]);
	});
	it('restores an ascending clip through its old end even if the final retained row was deleted', async () => {
		const history = Array.from({ length: 90 }, (_, index) => ({ ...item(`clip-${index}`, false), sortKey: { sortAt: String(index + 1), uri: `https://example.test/notes/clip-${index}` } }));
		const fresh = [...history.slice(0, -1), { ...item('later', false), sortKey: { sortAt: '91', uri: 'https://example.test/notes/later' } }];
		const request = vi.fn().mockResolvedValueOnce(page(history)).mockResolvedValueOnce(page(history, { resetRequired: true }));
		for (let offset = 0; offset < fresh.length; offset += 30) request.mockResolvedValueOnce(page(fresh.slice(offset, offset + 30), { session: 'restored', nextCursor: offset + 30 < fresh.length ? `restore-${offset}` : 'more' }));
		const value = new TimelineClient({ kind: 'clip', clipId: 'clip', order: 'oldest' }, { request, now: () => Date.now() });
		clients.push(value); await value.reload(); await value.refresh();
		expect(value.rows.value.map(row => row.key)).toEqual(fresh.map(row => row.key));
		expect(value.hasMore.value).toBe(true);
	});
	it.each([true, false])('restores pin-ranked history regardless of timestamps (last pin survives=%s)', async survives => {
		const history = [1, 9, 4].map(time => ({ ...item('pin-' + time, false), sortKey: { sortAt: String(time), uri: 'https://example.test/notes/' + time } }));
		const fresh = survives ? history : history.slice(0, -1);
		const request = vi.fn().mockResolvedValueOnce(page(history)).mockResolvedValueOnce(page(history, { resetRequired: true }))
			.mockResolvedValueOnce(page([fresh[0]], { session: 'replacement', nextCursor: 'pin-page' }))
			.mockResolvedValueOnce(page(fresh.slice(1), { session: 'replacement', nextCursor: survives ? 'older-pins' : null }));
		const value = new TimelineClient({ kind: 'channel', channelId: 'channel', pinnedOnly: true }, { request, now: () => Date.now() });
		clients.push(value); await value.reload(); await value.refresh();
		expect(value.rows.value.map(row => row.key)).toEqual(fresh.map(row => row.key));
		expect(value.hasMore.value).toBe(survives);
	});
	it('keeps the previous range when a replacement history page fails', async () => {
		const history = Array.from({ length: 60 }, (_, index) => ({ ...item(`history-${index}`, false), sortKey: { sortAt: String(1000 - index), uri: `https://example.test/notes/history-${index}` } }));
		const request = vi.fn().mockResolvedValueOnce(page(history))
			.mockResolvedValueOnce(page(history, { resetRequired: true }))
			.mockResolvedValueOnce(page(history.slice(0, 30), { session: 'replacement', nextCursor: 'restore-30' }))
			.mockRejectedValueOnce(new Error('offline'));
		const value = client(request, () => false); await value.reload(); await value.refresh();
		expect(value.rows.value.map(row => row.key)).toEqual(history.map(row => row.key));
		expect(value.error.value).toBe(true);
	});
	it('retains newly eligible rows across every replacement page before the first surviving old row', async () => {
		const old = [item('old-head', false), item('old-middle', false), item('old-tail', false)].map((row, index) => ({ ...row, sortKey: { sortAt: String(1000 - index * 400), uri: row.key } }));
		const eligible = Array.from({ length: 60 }, (_, index) => ({ ...item(`eligible-${index}`, false), sortKey: { sortAt: String(999 - index), uri: `https://example.test/notes/eligible-${index}` } }));
		const ordered = [...eligible, ...old.slice(1)];
		const request = vi.fn().mockResolvedValueOnce(page(old)).mockResolvedValueOnce(page([], { resetRequired: true }));
		for (let offset = 0; offset < ordered.length; offset += 30) {
			const rows = ordered.slice(offset, offset + 30);
			request.mockResolvedValueOnce(page(rows, { session: 'replacement', nextCursor: offset + 30 < ordered.length ? `restore-${offset + 30}` : null, order: rows.map(row => row.key) }));
		}
		const value = client(request, () => false); await value.reload(); await value.refresh();
		expect(value.queuedCount.value).toBe(60);
		await value.releaseQueue();
		expect(value.rows.value.map(row => row.key)).toEqual(ordered.map(row => row.key));
	});
	it('does not extend the authorization of an earlier restoration page while fetching later pages', async () => {
		const history = Array.from({ length: 60 }, (_, index) => ({ ...item(`history-${index}`), sortKey: { sortAt: String(1000 - index), uri: `https://example.test/notes/history-${index}` } }));
		let finish!: (value: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page(history))
			.mockResolvedValueOnce(page(history, { resetRequired: true }))
			.mockResolvedValueOnce(page(history.slice(0, 30).map(item => ({ ...item, validForMs: 5000 })), { session: 'replacement', nextCursor: 'restore-30' }))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const value = client(request, () => false); await value.reload(); const restoring = value.refresh(); await settle();
		await vi.advanceTimersByTimeAsync(6000);
		finish(page(history.slice(30), { session: 'replacement' })); await restoring;
		expect(value.rows.value[0]).toMatchObject({ note: { suspended: true } });
		expect(JSON.stringify(value.rows.value[0])).not.toContain('body:history-0');
		expect(value.rows.value[30]).toMatchObject({ note: { text: 'body:history-30' } });
	});
	it('removes protected content immediately when a restoration reports revoked authorization', async () => {
		const history = [item('first'), item('second')];
		const request = vi.fn().mockResolvedValueOnce(page(history))
			.mockResolvedValueOnce(page(history, { resetRequired: true }))
			.mockResolvedValueOnce(page([], { complete: false, sources: [{ source: 'peer', status: 'unauthorized', retryable: false }] }));
		const value = client(request, () => false); await value.reload(); await value.refresh();
		expect(JSON.stringify(value.rows.value)).not.toContain('body:first');
		expect(value.failed.value).toBe(true);
	});
	it('retains a revocation reported while recovering an expired cursor', async () => {
		const history = [item('first'), item('second')];
		const request = vi.fn().mockResolvedValueOnce(page(history))
			.mockRejectedValueOnce({ info: { reason: 'INVALID_CURSOR' } })
			.mockResolvedValueOnce(page([], { complete: false, sources: [{ source: 'peer', status: 'unauthorized', retryable: false }] }));
		const value = client(request, () => false); await value.reload(); await value.refresh();
		expect(JSON.stringify(value.rows.value)).not.toContain('body:first');
		expect(value.failed.value).toBe(true);
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
	it('continues empty local-fallback pages without treating the degraded source as a failed request', async () => {
		const request = vi.fn().mockResolvedValueOnce(page([], { mode: 'local-fallback', nextCursor: 'empty-1' }))
			.mockResolvedValueOnce(page([], { mode: 'local-fallback', nextCursor: 'empty-2' }))
			.mockResolvedValueOnce(page([item('found', false)], { mode: 'local-fallback' }));
		const value = client(request); await value.reload();
		expect(value.error.value).toBe(true); expect(value.failed.value).toBe(false);
		expect(value.hasMore.value).toBe(true);
		await value.load(); expect(value.hasMore.value).toBe(true);
		await value.load(); expect(value.rows.value).toMatchObject([{ note: { id: 'found' } }]);
		expect(value.failed.value).toBe(false); expect(value.hasMore.value).toBe(false);
		expect(request.mock.calls[1][1]).toMatchObject({ cursor: 'empty-1', mode: 'local-fallback' });
		expect(request.mock.calls[2][1]).toMatchObject({ cursor: 'empty-2', mode: 'local-fallback' });
	});
	it('coalesces invalidation hints and stops its subscription while suspended', async () => {
		let invalidate!: () => void;
		const dispose = vi.fn();
		const subscribe = vi.fn((_params, callback) => { invalidate = callback; return dispose; });
		const request = vi.fn().mockResolvedValue(page([item('local', false)]));
		const value = new TimelineClient({ kind: 'home' }, { request, subscribe, now: () => Date.now() });
		clients.push(value); await value.reload();
		invalidate();
		invalidate(); invalidate();
		await vi.advanceTimersByTimeAsync(99);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(request).toHaveBeenCalledTimes(2);
		invalidate(); invalidate();
		await vi.advanceTimersByTimeAsync(100);
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
		await vi.advanceTimersByTimeAsync(9999); expect(request).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1); expect(request).toHaveBeenCalledTimes(4);
	});
	it('coalesces hints received during a slow request into one trailing authorization check', async () => {
		let invalidate!: () => void;
		let finish!: (value: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('local', false)]))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(page([item('local', false)]));
		const subscribe = vi.fn((_params, hint) => { invalidate = hint; return () => {}; });
		const value = new TimelineClient({ kind: 'home' }, { request, subscribe, now: () => Date.now() });
		clients.push(value); await value.reload();
		await vi.advanceTimersByTimeAsync(10000); expect(request).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1000); invalidate();
		invalidate(); invalidate();
		await vi.advanceTimersByTimeAsync(3000); finish(page([item('local', false)])); await settle();
		await vi.advanceTimersByTimeAsync(0); expect(request).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(9999); expect(request).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1); expect(request).toHaveBeenCalledTimes(4);
	});
	it('keeps the failure cooldown despite invalidations, reconnects and tab focus', async () => {
		let invalidate!: () => void; let reconnect!: () => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('local', false)])).mockRejectedValue({ code: 'RATE_LIMIT_EXCEEDED' });
		const subscribe = vi.fn((_params, hint, connected) => { invalidate = hint; reconnect = connected; return () => {}; });
		const value = new TimelineClient({ kind: 'home' }, { request, subscribe, now: () => Date.now() });
		clients.push(value); await value.reload();
		invalidate(); await vi.advanceTimersByTimeAsync(100);
		expect(request).toHaveBeenCalledTimes(2);
		invalidate(); reconnect(); await value.resume();
		await vi.advanceTimersByTimeAsync(7999);
		expect(request).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(request).toHaveBeenCalledTimes(3);
		invalidate(); await vi.advanceTimersByTimeAsync(15999);
		expect(request).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(request).toHaveBeenCalledTimes(4);
	});
	it('allows an explicit retry to bypass the failure cooldown', async () => {
		const request = vi.fn().mockResolvedValueOnce(page([item('local', false)]))
			.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(page([item('local', false)]));
		const value = client(request); await value.reload(); await value.refresh();
		await value.retry();
		expect(request).toHaveBeenCalledTimes(3);
		expect(value.failed.value).toBe(false);
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
		await vi.advanceTimersByTimeAsync(1); expect(request).toHaveBeenCalledTimes(2);
		expect(starts[1] - starts[0]).toBeLessThanOrEqual(3001);
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
		await vi.advanceTimersByTimeAsync(2000);
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
		await value.retry();
		expect(request.mock.calls[3][1]).not.toHaveProperty('anchor');
		expect(value.rows.value.map(row => row.key)).toEqual([item('fresh').key]);
		expect(value.queuedCount.value).toBe(0);
	});
});

describe('background home streaming', () => {
	it('keeps the subscription and reveals buffered notes before foreground HTTP finishes', async () => {
		let finish!: (response: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false)]))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const dispose = vi.fn(); const subscribe = vi.fn(() => dispose);
		const value = new TimelineClient({ kind: 'home' }, { request, subscribe, backgroundStreaming: true, now: () => Date.now() });
		clients.push(value); await value.reload();
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		value.background();
		value.receive({ session: 'session', revision: 'revision', item: item('buffered', false) });
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(dispose).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledOnce();
		expect(value.rows.value.map(row => row.key)).toEqual([item('old').key]);
		expect(value.queuedCount.value).toBe(1);
		hidden.mockReturnValue(false); const resumed = value.resume();
		expect(value.rows.value.map(row => row.key)).toEqual([item('buffered').key, item('old').key]);
		expect(subscribe).toHaveBeenCalledOnce();
		finish(page([item('old', false), item('buffered', false)])); await resumed;
	});
	it('does not give expired background bodies the previous-screen grace', async () => {
		let finish!: (response: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false)]))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const value = new TimelineClient({ kind: 'home' }, { request, backgroundStreaming: true, now: () => Date.now() });
		clients.push(value); await value.reload();
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); value.background();
		value.receive({ session: 'session', revision: 'revision', item: item('expired', true, 1000), leaseStartedAt: Date.now(), leaseElapsedMs: 0 });
		value.receive({ session: 'session', revision: 'revision', item: item('public', false) });
		await vi.advanceTimersByTimeAsync(2000);
		hidden.mockReturnValue(false); const resumed = value.resume();
		expect(JSON.stringify(value.rows.value)).not.toContain('body:expired');
		expect(value.rows.value.map(row => row.key)).toEqual([item('public').key, item('old').key]);
		expect(request.mock.calls[1][1].refs).toContain('opaque:expired');
		finish(page([item('public', false), item('old', false)], { removed: [item('expired').key] })); await resumed;
		expect(value.queuedCount.value).toBe(0);
	});
	it('shows new items before older authorization batches and keeps periodic validation', async () => {
		const history = Array.from({ length: 153 }, (_, index) => item(`history-${index}`, false));
		let finish!: (response: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page(history))
			.mockResolvedValueOnce(page(history.slice(0, 100), { newItems: [item('latest', false)], updatesCursor: 'next-updates' }))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(page());
		const value = new TimelineClient({ kind: 'home' }, { request, backgroundStreaming: true, now: () => Date.now() });
		clients.push(value); await value.reload(); const refreshing = value.refresh(); await settle();
		expect(request.mock.calls[1][1]).toMatchObject({ phase: 'changes', updatesCursor: 'updates' });
		expect(request.mock.calls[2][1]).toMatchObject({ phase: 'validate', updatesCursor: 'next-updates' });
		expect(value.rows.value[0].key).toBe(item('latest').key);
		finish(page(history.slice(100, 152), { removed: [history[152].key] })); await refreshing;
		expect(value.rows.value.some(row => row.key === history[152].key)).toBe(false);
		await vi.advanceTimersByTimeAsync(10000);
		expect(request.mock.calls[3][1]).toMatchObject({ phase: 'changes' });
	});
	it('does not extend a newly displayed buffered lease while recovery is pending', async () => {
		let finish!: (response: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page([item('old', false)]))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const value = new TimelineClient({ kind: 'home' }, { request, backgroundStreaming: true, now: () => Date.now() });
		clients.push(value); await value.reload();
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); value.background();
		value.receive({ session: 'session', revision: 'revision', item: item('buffered', true, 1000), leaseStartedAt: Date.now(), leaseElapsedMs: 0 });
		hidden.mockReturnValue(false); const resumed = value.resume();
		expect(JSON.stringify(value.rows.value)).toContain('body:buffered');
		await vi.advanceTimersByTimeAsync(1000);
		expect(JSON.stringify(value.rows.value)).not.toContain('body:buffered');
		finish(page([item('old', false)], { removed: [item('buffered').key] })); await resumed;
	});
	it('shows an authorized replacement head before restoring the full history', async () => {
		const history = Array.from({ length: 60 }, (_, index) => ({ ...item(`history-${index}`, false), sortKey: { sortAt: String(100 - index), uri: String(index) } }));
		const latest = { ...item('latest', false), sortKey: { sortAt: '101', uri: 'latest' } };
		let finish!: (response: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page(history)).mockResolvedValueOnce(page(history, { resetRequired: true }))
			.mockResolvedValueOnce(page([latest, ...history.slice(0, 29)], { session: 'new-session', nextCursor: 'older' }))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const value = new TimelineClient({ kind: 'home' }, { request, backgroundStreaming: true, now: () => Date.now() });
		clients.push(value); await value.reload(); const refreshing = value.refresh(); await settle();
		expect(value.rows.value[0].key).toBe(latest.key);
		expect(value.rows.value.at(-1)!.key).toBe(history.at(-1)!.key);
		expect(request.mock.calls[3][1]).toMatchObject({ cursor: 'older' });
		finish(page(history.slice(29), { session: 'new-session', nextCursor: 'past' })); await refreshing;
		expect(value.rows.value.map(row => row.key)).toEqual([latest, ...history].map(row => row.key));
	});
	it('expires a provisional authorized head while older history is still pending', async () => {
		const history = [item('old', false), item('tail', false)];
		let finish!: (response: TimelineResponse) => void;
		const request = vi.fn().mockResolvedValueOnce(page(history)).mockResolvedValueOnce(page(history, { resetRequired: true }))
			.mockResolvedValueOnce(page([item('preview', true, 1000)], { session: 'new-session', nextCursor: 'older' }))
			.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const value = new TimelineClient({ kind: 'home' }, { request, backgroundStreaming: true, now: () => Date.now() });
		clients.push(value); await value.reload(); const refreshing = value.refresh(); await settle();
		expect(JSON.stringify(value.rows.value)).toContain('body:preview');
		await vi.advanceTimersByTimeAsync(1000);
		expect(JSON.stringify(value.rows.value)).not.toContain('body:preview');
		finish(page(history, { session: 'new-session' })); await refreshing;
	});
});

describe('home capability dispatch', () => {
	it('keeps the home channel subscribed on visibility changes', async () => {
		const api = vi.mocked(misskeyApi);
		api.mockResolvedValueOnce({ timeline: { enabled: true, version: 1, kinds: ['home'] } } as never)
			.mockResolvedValueOnce(page([item('old', false)]) as never).mockResolvedValue(page() as never);
		const dispose = vi.fn(); const subscribe = vi.mocked(subscribeTimeline);
		subscribe.mockClear(); subscribe.mockReturnValueOnce(dispose);
		const normal = new Paginator('notes/timeline', {});
		let home!: ReturnType<typeof useGridspaceHome>;
		const app = createApp({ setup() { home = useGridspaceHome(normal, computed(() => ({ mode: 'home' })), () => true, computed(() => true)); return () => null; } });
		app.mount(document.createElement('div')); cleanup = () => app.unmount(); await settle();
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		document.dispatchEvent(new Event('visibilitychange')); await settle();
		expect(dispose).not.toHaveBeenCalled();
		subscribe.mock.calls[0][3]!({ session: 'session', revision: 'revision', item: item('new', false) });
		expect(home.rows.value.map(row => row.key)).toEqual([item('old').key]);
		hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'));
		expect(home.rows.value.map(row => row.key)).toEqual([item('new').key, item('old').key]);
		await settle(); expect(dispose).not.toHaveBeenCalled();
	});
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
