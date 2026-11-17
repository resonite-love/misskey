/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { GridspaceTimelineChannel } from '@/server/api/stream/channels/gridspace-timeline.js';
import type { GridspaceTimelineService } from '@/core/gridspace/timeline/GridspaceTimelineService.js';
import type { ChannelRequest } from '@/server/api/stream/channel.js';
import type { GridspaceIdentityService } from '@/core/gridspace/GridspaceIdentityService.js';

async function fixture(options: Record<string, unknown> = { kind: 'profile' }) {
	const subscriber = new EventEmitter();
	const user = { id: 'viewer' };
	const sendMessageToWs = vi.fn();
	const service = { authorizeSubscription: vi.fn().mockResolvedValue(true), streamContext: vi.fn().mockResolvedValue(options), streamNote: vi.fn().mockImplementation(async (_user, session, revision, event) => ({ session, revision, resetRequired: false, item: { key: event.noteId, validForMs: 1000 } })) };
	const request = { id: 'channel', connection: { user, subscriber, sendMessageToWs, following: {}, followingChannels: new Set(), userIdsWhoMeMuting: new Set(), userIdsWhoMeMutingRenotes: new Set(), userIdsWhoBlockingMe: new Set(), userMutedInstances: new Set(), mutingChannels: new Set() } } as unknown as ChannelRequest;
	const channel = new GridspaceTimelineChannel(request, service as unknown as GridspaceTimelineService, { linkedUserId: async () => null } as unknown as GridspaceIdentityService);
	expect(await channel.init({ session: 's', revision: '1', updatesCursor: 'u', leaseId: 'lease1' })).toBe(true);
	return { channel, subscriber, service, sendMessageToWs };
}

describe('native unified timeline stream delivery', () => {
	test('native home filtering rejects unrelated global notes before any database authorization', async () => {
		const f = await fixture({ kind: 'home' });
		f.subscriber.emit('notesStream', { id: 'other', userId: 'unfollowed', visibility: 'public', user: { id: 'unfollowed', host: null } });
		expect(f.service.streamNote).not.toHaveBeenCalled();
		f.subscriber.emit('notesStream', { id: 'own', userId: 'viewer', visibility: 'public', user: { id: 'viewer', host: null } });
		await vi.waitFor(() => expect(f.service.streamNote).toHaveBeenCalledTimes(1));
		f.channel.dispose();
	});
	test('only an ID is forwarded for authorization and the envelope includes a connection-relative lease clock', async () => {
		const f = await fixture();
		f.subscriber.emit('notesStream', { id: 'note1', text: 'untrusted raw body', user: { id: 'somebody' } });
		await vi.waitFor(() => expect(f.sendMessageToWs).toHaveBeenCalledTimes(1));
		expect(f.service.streamNote).toHaveBeenCalledWith({ id: 'viewer' }, 's', '1', { source: 'local', noteId: 'note1' });
		const payload = f.sendMessageToWs.mock.calls[0][1];
		expect(payload).toMatchObject({ type: 'note', body: { session: 's', revision: '1', leaseId: 'lease1', item: { key: 'note1', validForMs: 1000 } } });
		expect(payload.body.leaseElapsedMs).toBeGreaterThanOrEqual(0);
		f.channel.dispose();
	});

	test('same-ID pending messages coalesce and a later delivery remains available for client deduplication', async () => {
		const f = await fixture(); let release!: () => void;
		f.service.streamNote.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ session: 's', revision: '1', resetRequired: false, item: { key: 'note1', validForMs: 1000 } }); }));
		f.subscriber.emit('notesStream', { id: 'note1' }); f.subscriber.emit('notesStream', { id: 'note1' });
		expect(f.service.streamNote).toHaveBeenCalledTimes(1); release();
		await vi.waitFor(() => expect(f.sendMessageToWs).toHaveBeenCalledTimes(1));
		f.subscriber.emit('notesStream', { id: 'note1' });
		await vi.waitFor(() => expect(f.service.streamNote).toHaveBeenCalledTimes(2));
		f.channel.dispose();
	});

	test('bounded overflow requests resync and disposal drops late authorization results', async () => {
		const f = await fixture(); let release!: () => void;
		f.service.streamNote.mockImplementation(() => new Promise(resolve => { release = () => resolve({ session: 's', revision: '1', resetRequired: false, item: { key: 'note1', validForMs: 1000 } }); }));
		for (let i = 0; i < 102; i++) f.subscriber.emit('notesStream', { id: `note${i}` });
		expect(f.sendMessageToWs.mock.calls.some(([, value]) => value.type === 'invalidate')).toBe(true);
		f.channel.dispose(); release(); await Promise.resolve();
		expect(f.sendMessageToWs.mock.calls.some(([, value]) => value.type === 'note')).toBe(false);
	});
});
