/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { subscribeTimeline } from '@/utility/timeline-stream.js';
import { TimelineClient } from '@/utility/timeline-client.js';
import type { TimelineResponse, TimelineStreamEvent } from '@/utility/timeline-client.js';

const { stream, connections, listeners } = vi.hoisted(() => {
	const connections: { params: Record<string, string>; events: Map<string, (event: TimelineStreamEvent) => void>; dispose: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }[] = [];
	const listeners = new Map<string, () => void>();
	return { connections, listeners, stream: {
		useChannel: vi.fn((_name: string, params: Record<string, string>) => {
			const entry = { params, events: new Map<string, (event: TimelineStreamEvent) => void>(), dispose: vi.fn(), send: vi.fn() };
			connections.push(entry);
			return { on: (name: string, callback: (event: TimelineStreamEvent) => void) => entry.events.set(name, callback), dispose: entry.dispose, send: entry.send };
		}),
		on: (name: string, callback: () => void) => listeners.set(name, callback),
		off: (name: string) => listeners.delete(name),
	} };
});
vi.mock('@/stream.js', () => ({ useStream: () => stream }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: { hardMutedWords: [] } }));
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); connections.length = 0; listeners.clear(); });

const acknowledge = (index = connections.length - 1) => {
	const connection = connections[index];
	connection.events.get('ready')!({ session: 'session', revision: 'revision', leaseId: connection.params.leaseId });
};

it('checks an accepted subscription every ten seconds without reconnecting healthy channels', async () => {
	const stop = subscribeTimeline({ session: 'session', revision: 'revision', updatesCursor: 'updates' }, vi.fn());
	acknowledge();
	await vi.advanceTimersByTimeAsync(10000);
	expect(connections[0].send).toHaveBeenCalledWith('ping', {});
	acknowledge();
	await vi.advanceTimersByTimeAsync(10000);
	expect(connections).toHaveLength(1);
	expect(connections[0].send).toHaveBeenCalledTimes(2);
	stop();
});

it('recovers a silently rejected subscription without changing browser tabs', async () => {
	const recover = vi.fn();
	const stop = subscribeTimeline({ session: 'session', revision: 'revision', updatesCursor: 'updates' }, vi.fn(), recover);
	await vi.advanceTimersByTimeAsync(3000);
	expect(recover).toHaveBeenCalledOnce();
	await vi.advanceTimersByTimeAsync(2000);
	expect(connections).toHaveLength(2);
	expect(connections[0].dispose).toHaveBeenCalledOnce();
	acknowledge();
	await vi.advanceTimersByTimeAsync(3000);
	expect(recover).toHaveBeenCalledOnce();
	stop();
});

it('detects a silent lost channel and ignores old acknowledgements', async () => {
	const recover = vi.fn();
	const stop = subscribeTimeline({ session: 'session', revision: 'revision', updatesCursor: 'updates' }, vi.fn(), recover);
	acknowledge();
	await vi.advanceTimersByTimeAsync(15000);
	expect(connections).toHaveLength(2);
	acknowledge(0);
	await vi.advanceTimersByTimeAsync(3000);
	expect(recover).toHaveBeenCalledTimes(2);
	stop();
});

it('backs off missing acknowledgements and stops all retries on disposal or transport disconnect', async () => {
	const stop = subscribeTimeline({ session: 'session', revision: 'revision', updatesCursor: 'updates' }, vi.fn());
	await vi.advanceTimersByTimeAsync(5000);
	expect(connections).toHaveLength(2);
	await vi.advanceTimersByTimeAsync(6999);
	expect(connections).toHaveLength(2);
	await vi.advanceTimersByTimeAsync(1);
	expect(connections).toHaveLength(3);
	listeners.get('_disconnected_')!();
	await vi.advanceTimersByTimeAsync(30000);
	expect(connections).toHaveLength(3);
	listeners.get('_connected_')!();
	expect(connections).toHaveLength(4);
	stop();
	await vi.advanceTimersByTimeAsync(30000);
	expect(connections).toHaveLength(4);
});

it('renews the monotonic lease clock on same-session reconnect and rejects old buffered events', async () => {
	let now = 1000;
	vi.spyOn(performance, 'now').mockImplementation(() => now);
	const response = { version: 1, session: 'session', revision: 'revision', items: [], nextCursor: null, updatesCursor: 'updates', complete: true, mode: 'unified', sources: [], revalidateAfterMs: 10000 } as TimelineResponse;
	const value = new TimelineClient({ kind: 'home' }, { request: vi.fn().mockResolvedValue(response), now: () => now });
	await value.reload();
	const stop = subscribeTimeline({ session: 'session', revision: 'revision', updatesCursor: 'updates' }, vi.fn(), vi.fn(), value.receive);
	const first = connections[0];
	now = 30000; listeners.get('_connected_')!();
	const next = connections[1];
	expect(first.dispose).toHaveBeenCalledOnce(); expect(next.params.leaseId).not.toBe(first.params.leaseId);
	const event = { session: 'session', revision: 'revision', leaseId: next.params.leaseId, leaseElapsedMs: 100, item: {
		key: 'note', ref: 'ref', sortKey: { sortAt: '1', uri: 'note' }, representation: 'delegated', validForMs: 10000,
		payload: { id: 'note', uri: 'note', createdAt: new Date(0).toISOString(), text: 'fresh', files: [] },
	} } as unknown as TimelineStreamEvent;
	now = 30100; next.events.get('note')!(event);
	expect(value.rows.value[0]).toMatchObject({ note: { text: 'fresh' } });
	first.events.get('note')!({ ...event, leaseId: first.params.leaseId, item: { ...event.item!, key: 'old-buffer' } });
	expect(value.rows.value).toHaveLength(1);
	next.events.get('note')!({ ...event, leaseId: first.params.leaseId, item: { ...event.item!, key: 'wrong-lease' } });
	expect(value.rows.value).toHaveLength(1);
	stop(); value.dispose();
});
