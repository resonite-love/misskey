/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { GridspaceTimelineChannel } from './gridspace-timeline.js';

function fixture() {
	const sendMessageToWs = vi.fn();
	const subscriber = new EventEmitter();
	const timeline = { authorizeSubscription: vi.fn(async () => true), streamContext: vi.fn(async () => ({ kind: 'home' })) };
	const value = new GridspaceTimelineChannel({ id: 'channel', connection: { user: { id: 'viewer' }, subscriber, sendMessageToWs } } as never,
		timeline as never, { linkedUserId: async () => null } as never);
	const params = { session: 'session', revision: 'revision', updatesCursor: 'cursor', leaseId: 'lease' };
	return { value, timeline, subscriber, sendMessageToWs, params };
}

describe('timeline subscription acknowledgement', () => {
	test('acknowledges accepted subscriptions and probes without sending any note bodies', async () => {
		const f = fixture(); expect(await f.value.init(f.params)).toBe(true);
		await f.value.onMessage('ping', {});
		expect(f.sendMessageToWs.mock.calls.map(call => call[1])).toEqual(Array.from({ length: 2 }, () => ({
			id: 'channel', type: 'ready', body: { session: 'session', revision: 'revision', leaseId: 'lease' },
		})));
		f.value.dispose();
	});
	test('rejects unauthorized subscriptions without an acknowledgement', async () => {
		const f = fixture(); f.timeline.authorizeSubscription.mockResolvedValue(false);
		expect(await f.value.init(f.params)).toBe(false);
		await f.value.onMessage('ping', {});
		expect(f.sendMessageToWs).not.toHaveBeenCalled();
		expect(f.subscriber.listenerCount('notesStream')).toBe(0);
	});
	test('requests authorized recovery when the session no longer exists', async () => {
		const f = fixture(); await f.value.init(f.params);
		f.timeline.streamContext.mockResolvedValue(null as never);
		await f.value.onMessage('ping', {});
		expect(f.sendMessageToWs).toHaveBeenLastCalledWith('channel', { id: 'channel', type: 'note', body: {
			session: 'session', revision: 'revision', leaseId: 'lease', resetRequired: true,
		} });
		f.value.dispose();
	});
	test('coalesces probes and does not acknowledge after disposal', async () => {
		const f = fixture(); await f.value.init(f.params);
		let finish!: (value: { kind: string }) => void;
		f.timeline.streamContext.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const pending = f.value.onMessage('ping', {});
		await f.value.onMessage('ping', {});
		expect(f.timeline.streamContext).toHaveBeenCalledTimes(2);
		f.value.dispose(); finish({ kind: 'home' }); await pending;
		expect(f.sendMessageToWs).toHaveBeenCalledTimes(1);
		expect(f.subscriber.listenerCount('internal')).toBe(0);
	});
});
