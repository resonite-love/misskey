/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, it, vi } from 'vitest';
import { subscribeTimeline } from '@/utility/timeline-stream.js';
import { TimelineClient } from '@/utility/timeline-client.js';
import type { TimelineResponse, TimelineStreamEvent } from '@/utility/timeline-client.js';

const { stream, connections, listeners } = vi.hoisted(() => {
	const connections: { params: Record<string, string>; events: Map<string, (event: TimelineStreamEvent) => void>; dispose: ReturnType<typeof vi.fn> }[] = [];
	const listeners = new Map<string, () => void>();
	return { connections, listeners, stream: {
		useChannel: vi.fn((_name: string, params: Record<string, string>) => {
			const entry = { params, events: new Map<string, (event: TimelineStreamEvent) => void>(), dispose: vi.fn() };
			connections.push(entry);
			return { on: (name: string, callback: (event: TimelineStreamEvent) => void) => entry.events.set(name, callback), dispose: entry.dispose };
		}),
		on: (name: string, callback: () => void) => listeners.set(name, callback),
		off: (name: string) => listeners.delete(name),
	} };
});
vi.mock('@/stream.js', () => ({ useStream: () => stream }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: { hardMutedWords: [] } }));
afterEach(() => { vi.restoreAllMocks(); connections.length = 0; listeners.clear(); });

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
