/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { Config } from '@/config.js';
import type { GlobalEventService } from '@/core/GlobalEventService.js';
import { requestGridspacePeer } from '../peer-client.js';
import { TimelinePeerService } from './TimelinePeerService.js';

vi.mock('../peer-client.js', () => ({ requestGridspacePeer: vi.fn(async () => ({ ok: true })) }));
const env = 'GRIDSPACE_TIMELINE_PEER_TEST';
process.env[env] = Buffer.alloc(32, 4).toString('base64');
const config = { url: 'https://local.test', gridspace: { enabled: true, communityId: 'test', keyId: 'test', peerUrl: 'https://peer.test', secretEnv: env } } as Config;

describe('peer timeline notifications', () => {
	test('sends only origin IDs, including private and channel posts without copying their bodies', async () => {
		vi.mocked(requestGridspacePeer).mockClear();
		const service = new TimelinePeerService(config, {} as GlobalEventService);
		service.notify({ id: 'private1', userHost: null, channelId: null, visibility: 'followers' });
		service.notify({ id: 'channel1', userHost: 'peer.test', channelId: 'channel', visibility: 'public' });
		service.notify({ id: 'public1', userHost: null, channelId: null, visibility: 'public' });
		service.notify({ id: 'imported1', userHost: 'peer.test', channelId: null, visibility: 'public' });
		await vi.waitFor(() => expect(requestGridspacePeer).toHaveBeenCalledTimes(3));
		expect(vi.mocked(requestGridspacePeer).mock.calls.map(call => call[2])).toEqual([
			{ noteId: 'private1', shared: false }, { noteId: 'channel1', shared: false }, { noteId: 'public1', shared: true },
		]);
	});

	test('receiving a signed hint publishes an ID rather than a private body', () => {
		const publishInternalEvent = vi.fn();
		const service = new TimelinePeerService(config, { publishInternalEvent } as unknown as GlobalEventService);
		expect(service.receive('note1')).toEqual({ ok: true });
		expect(publishInternalEvent).toHaveBeenCalledWith('gridspaceTimelineNote', { noteId: 'note1', source: 'peer' });
	});
	test('coalesces outgoing policy hints and never echoes a received invalidation', async () => {
		vi.mocked(requestGridspacePeer).mockClear();
		let release!: () => void;
		vi.mocked(requestGridspacePeer).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ ok: true }); }));
		const publishInternalEvent = vi.fn();
		const service = new TimelinePeerService(config, { publishInternalEvent } as unknown as GlobalEventService);
		service.notifyChanges(); service.notifyChanges(); service.notifyChanges();
		expect(requestGridspacePeer).toHaveBeenCalledOnce();
		expect(vi.mocked(requestGridspacePeer).mock.calls[0].slice(1, 3)).toEqual(['/gridspace/v1/timeline/invalidate', {}]);
		release();
		await vi.waitFor(() => expect(requestGridspacePeer).toHaveBeenCalledTimes(2));
		service.receiveChanges();
		expect(publishInternalEvent).toHaveBeenLastCalledWith('gridspaceTimelineChanged', { sequence: '0' });
		expect(requestGridspacePeer).toHaveBeenCalledTimes(2);
	});
});
