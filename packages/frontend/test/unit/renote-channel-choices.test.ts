/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, expect, test, vi } from 'vitest';
import { url } from '@@/js/config.js';
import { renoteChannelChoices } from '@/utility/renote-channel-choices.js';
const { api, favorites, features } = vi.hoisted(() => ({ api: vi.fn(), favorites: vi.fn(), features: { multiNotePeer: true } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/cache.js', () => ({ favoritedChannelsCache: { fetch: favorites } }));
vi.mock('@/instance.js', () => ({ instance: { features } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { _multiNote: { peerSiteName: 'Peer' } } } }));
const origin = new URL(url).origin;
const peer = 'https://peer.example';

beforeEach(() => { vi.clearAllMocks(); features.multiNotePeer = true; favorites.mockResolvedValue([{ id: 'same', name: 'Local' }, { id: 'archived', isArchived: true }]); });

test('paginates peer favorites, deduplicates, and excludes only the matching origin plus ID', async () => {
	api.mockImplementation(async (path, input) => path === 'gridspace/link' ? { channelsEnabled: false } : ({ origin: peer, channels: input.before ? [{ id: 'next', name: 'Next' }, { id: 'same', name: 'Duplicate' }] : [{ id: 'same', name: 'Peer same ID' }, { id: 'archived', isArchived: true }], next: input.before ? null : 'page2' }));
	const choices = await renoteChannelChoices({ origin, channelId: 'same' });
	expect(choices.map(item => [item.name, item.channel.origin, item.channel.channelId])).toEqual([['Peer same ID · Peer', peer, 'same'], ['Next · Peer', peer, 'next']]);
	expect(api).toHaveBeenCalledWith('gridspace/multi-note/channels', { list: 'favorites', limit: 20, before: 'page2' }, undefined, expect.any(AbortSignal));
});

test('stops on a cursor cycle without duplicating choices', async () => {
	api.mockImplementation(async path => path === 'gridspace/link' ? { channelsEnabled: false } : { origin: peer, channels: [{ id: 'same', name: 'Peer' }], next: 'repeat' });
	expect(await renoteChannelChoices()).toHaveLength(2);
	expect(api).toHaveBeenCalledTimes(3);
});

test('keeps local destinations during a peer outage', async () => {
	api.mockRejectedValue(new Error('offline'));
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
	expect((await renoteChannelChoices()).map(item => item.channel.origin)).toEqual([origin]);
	warning.mockRestore();
});

test.each(['feature-off', 'private-note'])('does not request peer destinations for %s', async reason => {
	features.multiNotePeer = reason !== 'feature-off';
	expect(await renoteChannelChoices(null, reason !== 'private-note')).toHaveLength(1);
	expect(api).not.toHaveBeenCalled();
});

test('includes the linked old account favorites as well as current-account favorites', async () => {
	api.mockImplementation(async path => path === 'gridspace/link' ? { channelsEnabled: true } : {
		origin: peer, next: null, channels: path === 'gridspace/channels' ? [{ id: 'old-account', name: 'Old favorite' }, { id: 'shared', name: 'Shared' }] : [{ id: 'shared', name: 'Shared' }],
	});
	expect((await renoteChannelChoices()).map(item => item.channel.channelId)).toEqual(['same', 'shared', 'old-account']);
	expect(api).toHaveBeenCalledWith('gridspace/channels', { list: 'favorites', limit: 20, before: undefined }, undefined, expect.any(AbortSignal));
});
