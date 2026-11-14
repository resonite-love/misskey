/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { computed } from 'vue';
import type { entities } from 'misskey-js';
import Note from '@/components/MkGridspacePrivateNote.vue';
import { DI } from '@/di.js';

const { api, menu, post } = vi.hoisted(() => ({ api: vi.fn(), menu: vi.fn(), post: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/utility/gridspace-post.js', () => ({ gridspacePost: post }));
vi.mock('@/utility/get-note-menu.js', () => ({ getRenoteMenu: vi.fn() }));
vi.mock('@/utility/gridspace-note-menu.js', () => ({ getGridspaceNoteMenu: async () => ({ menu: [], cleanup: vi.fn() }) }));
vi.mock('@/os.js', () => ({ popupMenu: menu, toast: vi.fn(), alert: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: { id: 'current' } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { instanceTicker: 'never', dataSaver: { media: true } } } }));
vi.mock('@/utility/url-preview.js', () => ({ isEnabledUrlPreview: false }));
vi.mock('@/components/MkGridspaceNoteActions.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkMediaList.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkCwButton.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkNoteHeader.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/global/MkAvatar.vue', () => ({ default: { props: ['preview'], template: '<div data-avatar :data-preview="preview"/>' } }));
vi.mock('@/components/MkInstanceTicker.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkUrlPreview.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { reply: 'Reply', renote: 'Renote', cantRenote: 'Unavailable', reaction: 'React', more: 'More', inChannelRenote: 'Channel renote', inChannelQuote: 'Channel quote', renoted: 'Renoted', _gridspace: {}, _visibility: { public: 'Public' } }, tsx: { _gridspace: { selfRenoteAs: ({ account }: { account: string }) => `Self-renote as ${account}` } } } }));

beforeEach(() => {
	vi.clearAllMocks(); window.sessionStorage.clear();
	vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
	api.mockResolvedValue({ canReply: true, createdNoteId: 'created', account: { uri: 'https://g.example/users/current' } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
type PrivateNote = entities.GridspacePrivateNotesResponse['notes'][number];
const original = { id: 'original', channelId: 'channel', uri: 'https://r.example/notes/original', origin: 'https://r.example', createdAt: '2026-11-14T00:00:00Z', author: { name: 'Author', username: 'author', host: 'r.example', uri: 'https://r.example/users/author', avatarUrl: '', emojis: {} }, text: 'Original content', cw: null, visibility: 'public', localOnly: true, files: [], poll: null, renoteId: null, replyId: null } as PrivateNote;
const globals = { stubs: { Mfm: { props: ['text'], template: '<span>{{ text }}</span>' }, MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' }, MkTime: true, MkUserName: true, I18n: { template: '<span><slot name="user"/></span>' } } };

test('only a server-authorized own follower note exposes the old-account self-renote', async () => {
	const note = { ...original, channelId: null, visibility: 'followers', canSelfRenote: true };
	api.mockResolvedValue({ canReply: true, createdNoteId: 'created', account: { uri: original.author.uri } });
	const view = render(Note, { props: { note }, global: globals });
	await fireEvent.click(view.getByRole('button', { name: 'Renote' }));
	const items = menu.mock.calls[0][0];
	expect(items).toHaveLength(1); expect(items[0].text).toBe('Self-renote as @author@r.example');
	await items[0].action();
	expect(api).toHaveBeenLastCalledWith('gridspace/private-reply', expect.objectContaining({ action: 'send', renoteId: 'original', expectedActorUri: original.author.uri }), undefined, expect.anything());
	await view.rerender({ note: { ...note, canSelfRenote: false } });
	expect((view.getByRole('button', { name: 'Renote' }) as HTMLButtonElement).disabled).toBe(true);
});

test('a home channel note uses the shared channel name, link and color, without a channel-page context', async () => {
	const channel = { id: 'channel', name: '#NSFWな話', color: '#ff8a8a' };
	const view = render(Note, { props: { note: { ...original, channel } }, global: globals });
	expect(view.container.querySelector('[data-note-article]')).not.toBeNull();
	expect(view.container.querySelector('[data-avatar]')?.getAttribute('data-preview')).toBe('false');
	expect(view.getByRole('link', { name: '#NSFWな話' }).getAttribute('href')).toBe('/gridspace/channels/channel');
	expect(view.container.querySelector('[aria-hidden="true"]')?.getAttribute('style')).toContain(`background: ${channel.color}`);
	await view.rerender({ note: { ...original, channelId: null, channel: null } });
	expect(view.queryByRole('link', { name: '#NSFWな話' })).toBeNull();
	expect(view.container.querySelector('[aria-hidden="true"]')).toBeNull();
});

test('inside the same channel, the shared color remains and the redundant channel link is hidden', () => {
	const channel = { id: 'channel', name: '#NSFWな話', color: '#ff8a8a' };
	const view = render(Note, { props: { note: { ...original, channel } }, global: { ...globals, provide: { [DI.linkedChannel]: computed(() => channel) } } });
	expect(view.queryByRole('link', { name: '#NSFWな話' })).toBeNull();
	expect(view.container.querySelector('[aria-hidden="true"]')).not.toBeNull();
});

test('a pure channel renote shows its source inline and actions target that source', async () => {
	const wrapper = { ...original, id: 'wrapper', text: null, renoteId: original.id, renote: original };
	const view = render(Note, { props: { note: wrapper }, global: globals });
	expect(view.getByText('Original content')).toBeTruthy();
	await fireEvent.click(view.getByRole('button', { name: 'Renote' }));
	const items = menu.mock.calls[0][0];
	expect(items.map((item: { text: string }) => item.text)).toEqual(['Channel renote', 'Channel quote']);
	await items[0].action();
	expect(api).toHaveBeenLastCalledWith('gridspace/channel-post', expect.objectContaining({ action: 'send', channelId: 'channel', renoteId: 'original' }), undefined, expect.anything());
	items[1].action();
	expect(post).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'channel', renote: original }), expect.any(Function));
	await view.rerender({ note: { ...wrapper, renote: undefined, renoteId: null } });
	expect(view.queryByText('Original content')).toBeNull();
});

test('quotes show both comment and original and stale menus cannot post after navigation', async () => {
	const view = render(Note, { props: { note: { ...original, id: 'quote', text: 'My comment', renoteId: original.id, renote: original } }, global: globals });
	expect(view.getByText('My comment')).toBeTruthy(); expect(view.getByText('Original content')).toBeTruthy();
	await fireEvent.click(view.getAllByRole('button', { name: 'Renote' })[0]);
	const items = menu.mock.calls[0][0];
	await view.rerender({ note: { ...original, id: 'different' } });
	await items[0].action(); items[1].action();
	expect(api).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
});

test('a pure renote opened in detail keeps the shared detail layout and source actions', async () => {
 const wrapper = { ...original, id: 'wrapper', text: null, renoteId: original.id, renote: original };
 const view = render(Note, { props: { note: wrapper, detailed: true }, global: globals });
 expect(view.container.querySelector('[data-note-detailed-article]')).not.toBeNull();
 expect(view.container.querySelector('[data-note-article]')).toBeNull();
 expect(view.getByText('Original content')).toBeTruthy();
 await fireEvent.click(view.getByRole('button', { name: 'Reply' }));
 expect(post).toHaveBeenCalledWith(expect.objectContaining({ reply: original }), expect.any(Function));
});
