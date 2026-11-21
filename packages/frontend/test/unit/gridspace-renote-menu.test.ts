/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, expect, test, vi } from 'vitest';
import type { entities } from 'misskey-js';
import { url } from '@@/js/config.js';
import { placementRenoteMenu } from '@/utility/placement-renote-menu.js';
import * as os from '@/os.js';
import { getGridspaceRenoteMenu } from '@/utility/gridspace-renote-menu.js';
const { api, peer, favorites } = vi.hoisted(() => ({ api: vi.fn(), peer: vi.fn(), favorites: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/utility/gridspace-channel-renote.js', () => ({ renoteGridspaceChannel: peer }));
vi.mock('@/utility/gridspace-post.js', () => ({ gridspacePost: vi.fn() }));
vi.mock('@/cache.js', () => ({ favoritedChannelsCache: { fetch: favorites } }));
vi.mock('@/instance.js', () => ({ instance: { features: { multiNote: true, multiNotePeer: true } } }));
vi.mock('@/store.js', () => ({ store: { s: { visibility: 'public' } } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { rememberNoteVisibility: false, defaultNoteVisibility: 'public' } } }));
vi.mock('@/os.js', () => ({ post: vi.fn(), toast: vi.fn(), alert: vi.fn() }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { renote: 'RN', quote: 'Quote', inChannelRenote: 'Inside RN', inChannelQuote: 'Inside quote', renoteToOtherChannel: 'Other channel', _gridspace: {}, _multiNote: { localSiteName: 'Local site', peerSiteName: 'Peer site' } } } }));
const source = { id: 'note', channelId: 'source', canQuoteOutside: true, visibility: 'public' } as entities.GridspacePrivateNotesResponse['notes'][number];
type Item = { text?: string; action: () => Promise<void>; children: () => Promise<Item[]> };
beforeEach(() => { vi.clearAllMocks(); api.mockImplementation(async endpoint => endpoint === 'gridspace/channels' ? { channels: [{ id: 'source', name: 'R source' }, { id: 'r2', name: 'R destination' }], next: null } : { createdNote: { id: 'created' } }); favorites.mockResolvedValue([{ id: 'source', name: 'G same ID' }]); peer.mockResolvedValue({}); });

test('normal and in-channel choices coexist in the shared menu', async () => {
	const items = getGridspaceRenoteMenu(source, 'g-only-user', () => true, vi.fn()) as Item[];
	expect(items.filter(item => item.text).map(item => item.text)).toEqual(['RN', 'Quote', 'Inside RN', 'Inside quote', 'Other channel']);
	await items[0].action();
	expect(api).toHaveBeenCalledWith('notes/create', expect.objectContaining({ gridspaceQuote: expect.stringContaining('noteId=note&channelId=source'), localOnly: true }));
	expect(api.mock.calls[0][1]).not.toHaveProperty('renoteId');
});

test('routes G and R favorites to their own APIs and excludes only the actual source', async () => {
	const items = getGridspaceRenoteMenu(source, 'g-only-user', () => true, vi.fn()) as Item[];
	const children = await items.at(-1)!.children();
	expect(children.map(item => item.text)).toEqual(['G same ID', 'R destination']);
	await children[0].action();
	expect(api).toHaveBeenCalledWith('notes/create', expect.objectContaining({ channelId: 'source', localOnly: true }));
	await children[1].action();
	expect(peer).toHaveBeenCalledWith('g-only-user', 'r2', 'note', expect.anything(), 'source');
});

test('dedicated renote menu scopes all five actions to the selected source and paginates favorites', async () => {
	const canonicalUri = 'https://peer.test/notes/root';
	const local = { origin: new URL(url).origin, channelId: 'same', name: 'Same', color: '#aaa', canonicalUri, state: 'active' as const, isArchived: false, allowRenoteToExternal: false };
	const peerSource = { ...local, origin: 'https://peer.test', isSensitive: true, allowRenoteToExternal: true };
	const note = { visibility: 'public', channelPlacements: [local, peerSource] };
	const menu = (context: typeof local | null) => placementRenoteMenu(note, 'author', context, () => true, vi.fn()) as Item[];
	expect(menu(local).map(item => item.text)).toEqual(['Inside RN', 'Inside quote']);
	expect(menu(null).map(item => item.text)).toEqual(['Same · Local site', 'Same · Peer site']);
	expect(placementRenoteMenu({ ...note, channelPlacements: [{ ...peerSource, isArchived: true }] }, 'author', null, () => true, vi.fn())).toEqual([]);
	const items = menu(peerSource);
	expect(items.filter(item => item.text).map(item => item.text)).toEqual(['RN', 'Quote', 'Inside RN', 'Inside quote', 'Other channel']);
	const reference = canonicalUri + '?gridspaceChannelOrigin=https%3A%2F%2Fpeer.test&gridspaceChannelId=same';
	api.mockImplementation(async (path, input) => {
		if (path === 'channels/my-favorites') return [{ id: 'same', name: 'Same', color: '#aaa' }];
		if (path === 'gridspace/multi-note/channels') {
			expect(input.limit).toBeLessThanOrEqual(20);
			return { origin: peerSource.origin, channels: [{ id: input.before ? 'other' : 'same', name: 'Same', color: '#aaa' }], next: input.before ? null : 'next' };
		}
		return { createdNote: { id: 'new' } };
	});
	await items[0].action();
	expect(api.mock.calls[0][1]).toEqual({ gridspaceQuote: reference, visibility: 'home', localOnly: true });
	await items[1].action();
	expect(os.post).toHaveBeenCalledWith({ gridspaceQuote: reference, initialLocalOnly: true });
	await items[3].action();
	expect(api.mock.calls[1][1]).toMatchObject({ gridspaceQuote: reference, visibility: 'public', includeDefault: false, channelIds: [], channelTargets: [{ origin: peerSource.origin, channelId: 'same' }], clientRequestId: expect.any(String) });
	await items[4].action();
	expect(os.post).toHaveBeenCalledWith(expect.objectContaining({ gridspaceQuote: reference, fixedQuoteDestination: expect.objectContaining({ origin: peerSource.origin, channelId: 'same' }) }));
	const destinations = await items[6].children();
	expect(destinations.map(item => item.text)).toEqual(['Same · Local site', 'Same · Peer site']);
	await destinations[0].action();
	expect(api.mock.calls.at(-1)![1]).toMatchObject({ gridspaceQuote: reference, includeDefault: false, channelIds: ['same'], channelTargets: [] });
	await destinations[1].action();
	expect(api.mock.calls.at(-1)![1]).toMatchObject({ gridspaceQuote: reference, includeDefault: false, channelIds: [], channelTargets: [{ origin: peerSource.origin, channelId: 'other' }] });
});
