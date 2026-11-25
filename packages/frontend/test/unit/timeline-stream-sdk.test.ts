/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, it, vi } from 'vitest';
import Stream from '../../../misskey-js/src/streaming.js';
import { subscribeTimeline } from '@/utility/timeline-stream.js';

const sockets: FakeSocket[] = [];
class FakeSocket extends EventTarget {
	static readonly CLOSING = 2;
	readyState = 0;
	sent: { type: string; body: { id: string; channel?: string } }[] = [];
	constructor() { super(); sockets.push(this); }
	open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
	send(message: string) { this.sent.push(JSON.parse(message)); }
	close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
let stream: Stream;
vi.mock('@/stream.js', () => ({ useStream: () => stream }));

afterEach(() => { sockets.length = 0; vi.clearAllTimers(); vi.useRealTimers(); });

it('registers the replacement timeline only once while reconnecting other SDK channels', async () => {
	vi.useFakeTimers();
	stream = new Stream('https://example.test', null, { WebSocket: FakeSocket as never });
	const stop = subscribeTimeline({ session: 'session', revision: 'revision', updatesCursor: 'updates' }, vi.fn());
	stream.useChannel('localTimeline', {});
	await vi.advanceTimersByTimeAsync(0);
	sockets[0].open();
	sockets[0].close();
	await vi.advanceTimersByTimeAsync(20);
	const socket = sockets[1];
	socket.open();
	const connects = socket.sent.filter(message => message.type === 'connect');
	expect(connects.filter(message => message.body.channel === 'gridspaceTimeline')).toHaveLength(1);
	expect(connects.filter(message => message.body.channel === 'localTimeline')).toHaveLength(1);
	expect(new Set(connects.map(message => message.body.id)).size).toBe(2);
	stop(); stream.close();
});
