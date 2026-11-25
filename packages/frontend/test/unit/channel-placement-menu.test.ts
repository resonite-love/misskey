/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { beforeEach, expect, test, vi } from 'vitest';
import { shallowRef } from 'vue';
import type { entities } from 'misskey-js';
import { url } from '@@/js/config.js';
import { getRenoteMenu } from '@/utility/get-note-menu.js';
import type { MenuButton, MenuItem } from '@/types/menu.js';

const { api, post, favorites } = vi.hoisted(() => ({ api: vi.fn(), post: vi.fn(), favorites: vi.fn(async () => []) }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/os.js', () => ({ post, toast: vi.fn(), alert: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer' } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { animation: false, rememberNoteVisibility: false, defaultNoteVisibility: 'public', defaultNoteLocalOnly: 'none' } } }));
vi.mock('@/store.js', () => ({ store: { s: {} } }));
vi.mock('@/instance.js', () => ({ instance: { features: { multiNotePeer: true } } }));
vi.mock('@/cache.js', () => ({ clipsCache: {}, favoritedChannelsCache: { fetch: favorites } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { renote: 'RN', quote: 'Quote', inChannelRenote: 'Inside RN', inChannelQuote: 'Inside quote', renoteToChannel: 'To channel', renoteToOtherChannel: 'Other channel', _multiNote: { peerSiteName: 'Peer' } }, tsx: { renotedToX: ({ name }: { name: string }) => name } } }));
vi.mock('@/utility/get-appear-note.js', () => ({ getAppearNote: (note: unknown) => note }));
vi.mock('@/utility/note-delivery.js', () => ({ getDefaultNoteDelivery: () => 'none', getNoteDeliveryFlags: () => ({ localOnly: false, noRelay: true }) }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/utility/get-user-menu.js', () => ({ getUserMenu: vi.fn() }));
vi.mock('@/utility/copy-to-clipboard.js', () => ({ copyToClipboard: vi.fn() }));
vi.mock('@/utility/navigator.js', () => ({ isSupportShare: () => false }));
vi.mock('@/utility/get-embed-code.js', () => ({ genEmbedCode: vi.fn() }));
vi.mock('@/utility/clip-menu.js', () => ({ loadClipMenu: vi.fn() }));
vi.mock('@/local-storage.js', () => ({ miLocalStorage: {} }));
vi.mock('@/plugin.js', () => ({ getPluginHandlers: () => [] }));
vi.mock('@/events.js', () => ({ globalEvents: { emit: vi.fn() } }));
vi.mock('@/components/MkRippleEffect.vue', () => ({ default: {} }));

const origin = new URL(url).origin;
const channel = { origin, channelId: 'current' };
const placement = { ...channel, name: 'Current channel', color: '#112233', canonicalUri: `${origin}/notes/root`, state: 'active' as const, isArchived: false, allowRenoteToExternal: true };
const note = { id: 'root', userId: 'author', user: { id: 'author' }, visibility: 'public', multiNoteKind: 'root', includeDefault: true, channelPlacements: [placement] } as entities.Note;
const button = (menu: MenuItem[], text: string) => menu.find(item => 'text' in item && item.text === text) as MenuButton;
const menuFor = (target = note, context: typeof channel | null = channel, isCurrent = () => true) => getRenoteMenu({ note: target, channel: context, isCurrent, renoteButton: shallowRef(null) }).menu;

beforeEach(() => { vi.clearAllMocks(); api.mockResolvedValue({ createdNote: { id: 'new' } }); });

test('a default-and-channel post exposes same-channel actions in the native menu', async () => {
	const menu = menuFor();
	expect(menu.filter(item => 'text' in item).map(item => item.text)).toEqual(['RN', 'Quote', 'Inside RN', 'Inside quote', 'To channel']);
	await button(menu, 'Inside quote').action({} as PointerEvent);
	expect(post).toHaveBeenCalledWith(expect.objectContaining({
		gridspaceQuote: expect.stringContaining('gridspaceChannelId=current'),
		fixedQuoteDestination: expect.objectContaining(channel), initialVisibility: 'public', initialLocalOnly: true,
	}));
});

test('ordinary renote and quote retain their native public-post semantics', async () => {
	const menu = menuFor();
	await button(menu, 'RN').action({} as PointerEvent);
	expect(api).toHaveBeenCalledWith('notes/create', { renoteId: note.id, visibility: 'public', localOnly: false, noRelay: true });
	await button(menu, 'Quote').action({} as PointerEvent);
	expect(post).toHaveBeenCalledWith({ renote: note });
});

test('same-channel renote uses only the selected placement', async () => {
	const menu = menuFor({ ...note, channelPlacements: [placement, { ...placement, origin: 'https://peer.test' }] });
	await button(menu, 'Inside RN').action({} as PointerEvent);
	expect(api).toHaveBeenCalledWith('notes/create', expect.objectContaining({ includeDefault: false, channelIds: ['current'], channelTargets: [], gridspaceQuote: expect.stringContaining('gridspaceChannelId=current') }), undefined, expect.any(AbortSignal));
	expect(api.mock.calls[0][1]).not.toHaveProperty('renoteId');
});

test.each(['outside', 'other-origin', 'removed', 'archived'] as const)('does not invent same-channel actions for %s context', reason => {
	const target = { ...note, channelPlacements: [{ ...placement, state: reason === 'removed' ? 'removed' as const : 'active' as const, isArchived: reason === 'archived' }] };
	const menu = menuFor(target, reason === 'outside' ? null : reason === 'other-origin' ? { ...channel, origin: 'https://peer.test' } : channel);
	expect(button(menu, 'Inside quote')).toBeUndefined();
	expect(button(menu, 'Quote')).toBeDefined();
});

test('an open menu stops acting after its channel context becomes stale', async () => {
	let current = true;
	const menu = menuFor(note, channel, () => current);
	current = false;
	await button(menu, 'Inside quote').action({} as PointerEvent);
	await button(menu, 'Inside RN').action({} as PointerEvent);
	await button(menu, 'Quote').action({} as PointerEvent);
	expect(api).not.toHaveBeenCalled();
	expect(post).not.toHaveBeenCalled();
});

test('the ordinary menu offers peer favorites and preserves the native source ID when posting', async () => {
	api.mockImplementation(async path => path === 'gridspace/multi-note/channels' ? { origin: 'https://peer.test', channels: [{ id: 'current', name: 'Peer channel' }], next: null } : { createdNote: { id: 'new' } });
	const menu = menuFor(note, null);
	const item = menu.find(item => 'type' in item && item.type === 'parent');
	if (!item || !('children' in item) || typeof item.children !== 'function') throw new Error('Missing destinations');
	const children = await item.children();
	await button(children, 'Peer channel · Peer').action({} as PointerEvent);
	expect(api).toHaveBeenLastCalledWith('notes/create', expect.objectContaining({ renoteId: 'root', includeDefault: false, visibility: 'public', localOnly: true,
		channelIds: [], channelTargets: [{ origin: 'https://peer.test', channelId: 'current' }], clientRequestId: expect.any(String) }), undefined, expect.any(AbortSignal));
});
