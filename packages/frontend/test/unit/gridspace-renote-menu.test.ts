/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, expect, test, vi } from 'vitest';
import type { entities } from 'misskey-js';
import { getGridspaceRenoteMenu } from '@/utility/gridspace-renote-menu.js';
const { api, peer, favorites } = vi.hoisted(() => ({ api: vi.fn(), peer: vi.fn(), favorites: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/utility/gridspace-channel-renote.js', () => ({ renoteGridspaceChannel: peer }));
vi.mock('@/utility/gridspace-post.js', () => ({ gridspacePost: vi.fn() }));
vi.mock('@/cache.js', () => ({ favoritedChannelsCache: { fetch: favorites } }));
vi.mock('@/store.js', () => ({ store: { s: { visibility: 'public' } } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { rememberNoteVisibility: false, defaultNoteVisibility: 'public' } } }));
vi.mock('@/os.js', () => ({ post: vi.fn(), toast: vi.fn(), alert: vi.fn() }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { renote: 'RN', quote: 'Quote', inChannelRenote: 'Inside RN', inChannelQuote: 'Inside quote', renoteToOtherChannel: 'Other channel', _gridspace: {} } } }));
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
