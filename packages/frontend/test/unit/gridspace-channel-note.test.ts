/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { computed, defineComponent, KeepAlive, nextTick, ref } from 'vue';
import { url } from '@@/js/config.js';
import type { entities } from 'misskey-js';
import Note from '@/components/MkGridspacePrivateNote.vue';
import SimpleNote from '@/components/MkNoteSimple.vue';
import { DI } from '@/di.js';

const { api, menu, post, normalPost, settings } = vi.hoisted(() => ({ api: vi.fn(), menu: vi.fn(), post: vi.fn(), normalPost: vi.fn(), settings: { instanceTicker: 'never', dataSaver: { media: true } } }));
const { pluginHandlers } = vi.hoisted(() => ({ pluginHandlers: vi.fn(() => [] as { handler: (note: entities.Note) => entities.Note | null }[]) }));
vi.mock('@/plugin.js', () => ({ getPluginHandlers: pluginHandlers }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/utility/gridspace-post.js', () => ({ gridspacePost: post }));
vi.mock('@/utility/get-note-menu.js', () => ({ getRenoteMenu: vi.fn() }));
vi.mock('@/utility/gridspace-note-menu.js', () => ({ getGridspaceNoteMenu: async () => ({ menu: [], cleanup: vi.fn() }) }));
vi.mock('@/os.js', () => ({ popupMenu: menu, post: normalPost, toast: vi.fn(), alert: vi.fn(), confirm: async () => ({ canceled: false }) }));
vi.mock('@/store.js', () => ({ store: { s: { visibility: 'public' } } }));
vi.mock('@/cache.js', () => ({ favoritedChannelsCache: { fetch: vi.fn(async () => []) } }));
vi.mock('@/i.js', () => ({ $i: { id: 'current' } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: settings } }));
vi.mock('@/utility/url-preview.js', () => ({ isEnabledUrlPreview: false }));
vi.mock('@/components/MkGridspaceNoteActions.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkMediaList.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkCwButton.vue', () => ({ default: { props: ['modelValue'], emits: ['update:modelValue'], template: '<button @click="$emit(\'update:modelValue\', !modelValue)">Toggle CW</button>' } }));
vi.mock('@/components/MkAutoTranslatedNote.vue', () => ({ default: { props: ['note'], template: '<slot :text="note.text"/>' } }));
vi.mock('@/components/MkNoteHeader.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/global/MkAvatar.vue', () => ({ default: { props: ['preview'], template: '<div data-avatar :data-preview="preview"/>' } }));
vi.mock('@/components/MkInstanceTicker.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkUrlPreview.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { invisibleNote: 'Unavailable source', delete: 'Delete', showOnRemote: 'Open original', _multiNote: { mirrorUnavailable: 'Awaiting local copy' }, reply: 'Reply', renote: 'Renote', quote: 'Quote', renoteToOtherChannel: 'Other channel', cantRenote: 'Unavailable', reaction: 'React', more: 'More', inChannelRenote: 'Channel renote', inChannelQuote: 'Channel quote', renoted: 'Renoted', _gridspace: {}, _visibility: { public: 'Public' } }, tsx: { withNFiles: ({ n }: { n: number }) => `${n} files`, _gridspace: { selfRenoteAs: ({ account }: { account: string }) => `Self-renote as ${account}` } } } }));

beforeEach(() => {
	vi.clearAllMocks(); window.sessionStorage.clear();
	settings.dataSaver.media = true;
	pluginHandlers.mockReturnValue([]);
	vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
	api.mockResolvedValue({ canReply: true, createdNoteId: 'created', account: { uri: 'https://g.example/users/current' } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
type PrivateNote = entities.GridspacePrivateNotesResponse['notes'][number];
const original = { id: 'original', channelId: 'channel', uri: 'https://r.example/notes/original', origin: 'https://r.example', createdAt: '2026-11-14T00:00:00Z', author: { name: 'Author', username: 'author', host: 'r.example', uri: 'https://r.example/users/author', avatarUrl: '', emojis: {} }, text: 'Original content', cw: null, visibility: 'public', localOnly: true, files: [], poll: null, renoteId: null, replyId: null } as PrivateNote;
const globals = { stubs: { Mfm: { props: ['text'], template: '<span>{{ text }}</span>' }, MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' }, MkTime: true, MkUserName: true, I18n: { template: '<span><slot name="user"/></span>' } } };

test.each([false, true])('keeps public commentary visible with an unavailable quote placeholder (compact: %s)', quotePreview => {
	const view = render(Note, { props: { note: { ...original, text: 'Public commentary', renoteUnavailable: true }, quotePreview }, global: globals });
	expect(view.getByText('Public commentary')).toBeTruthy();
	expect(view.getByText('Unavailable source')).toBeTruthy();
});

test('an allowed channel quote opens the normal composer outside the source channel', async () => {
	const source = { ...original, canQuoteOutside: true, author: { ...original.author, uri: `${url}/users/current`, host: new URL(url).host } };
	const view = render(Note, { props: { note: source }, global: globals });
	await fireEvent.click(view.getByRole('button', { name: 'Renote' }));
	const items = menu.mock.calls[0][0];
	expect(items).toHaveLength(7);
	items[1].action();
	expect(normalPost).toHaveBeenCalledWith({ gridspaceQuote: `${url}/gridspace/private?noteId=original&channelId=channel`, initialLocalOnly: true });
	expect(post).not.toHaveBeenCalled();
});

test('the guest card renotes from the displayed placement even when both channels use the same ID', async () => {
	const origin = 'https://source.example';
	const local = { origin: new URL(url).origin, canonicalUri: original.uri, channelId: 'same', name: 'Same', color: '#ff0000', state: 'active' as const, isArchived: false, allowRenoteToExternal: true };
	const remote = { ...local, origin, color: '#0000ff', allowRenoteToExternal: false };
	const note = { ...original, channelId: null, multiNoteKind: 'root' as const, includeDefault: false, channelPlacements: [local, remote] };
	const view = render(Note, { props: { note }, global: { ...globals, provide: { [DI.placementChannel as symbol]: computed(() => remote) } } });
	expect([...view.container.querySelectorAll<HTMLElement>('[data-note-channel-colors] > span')].map(segment => segment.style.backgroundColor)).toEqual(['#ff0000', '#0000ff']);
	await fireEvent.click(view.getByRole('button', { name: 'Renote' }));
	const items = menu.mock.calls[0][0];
	expect(items.map((item: { text?: string }) => item.text)).toEqual(['Channel renote', 'Channel quote']);
	await items[1].action();
	expect(normalPost).toHaveBeenCalledWith(expect.objectContaining({ gridspaceQuote: original.uri + '?gridspaceChannelOrigin=https%3A%2F%2Fsource.example&gridspaceChannelId=same', fixedQuoteDestination: expect.objectContaining({ origin, channelId: 'same' }) }));
});

test('a channel that forbids outside quotes keeps only its in-channel actions', async () => {
	const view = render(Note, { props: { note: { ...original, canQuoteOutside: false } }, global: globals });
	await fireEvent.click(view.getByRole('button', { name: 'Renote' }));
	expect(menu.mock.calls[0][0]).toHaveLength(2);
});

test('linked channel notes run normal view plugins without changing action targets', async () => {
	pluginHandlers.mockReturnValue([{ handler: note => ({ ...note, id: 'rewritten-id', text: 'Plugin content' }) }]);
	const view = render(Note, { props: { note: original }, global: globals });
	expect(view.getByText('Plugin content')).toBeTruthy();
	expect(view.queryByText('Original content')).toBeNull();
	expect(pluginHandlers).toHaveBeenCalledWith('note_view_interruptor');
	await fireEvent.click(view.getByRole('button', { name: 'Reply' }));
	expect(post).toHaveBeenCalledWith(expect.objectContaining({ reply: original }), expect.any(Function));
	expect(original.text).toBe('Original content');
});

test('linked channel view plugins can hide a note', () => {
	pluginHandlers.mockReturnValue([{ handler: () => null }]);
	const view = render(Note, { props: { note: original }, global: globals });
	expect(view.container.querySelector('[data-gridspace-private-note]')).toBeNull();
});

test('plugins recognize the current local author in a linked channel', () => {
	pluginHandlers.mockReturnValue([{ handler: note => ({ ...note, text: note.userId === 'current' && note.user.host == null ? 'Local author' : 'Wrong author' }) }]);
	const view = render(Note, { props: { note: { ...original, author: { ...original.author, uri: `${url}/users/current`, host: new URL(url).host } } }, global: globals });
	expect(view.getByText('Local author')).toBeTruthy();
});

test('reauthorized linked channel notes apply view plugins to the new body', async () => {
	pluginHandlers.mockReturnValue([{ handler: note => ({ ...note, text: 'Plugin: ' + note.text }) }]);
	const view = render(Note, { props: { note: original }, global: globals });
	expect(view.getByText('Plugin: Original content')).toBeTruthy();
	await view.rerender({ note: { ...original, text: 'Updated body' } });
	expect(view.getByText('Plugin: Updated body')).toBeTruthy();
	expect(view.queryByText('Plugin: Original content')).toBeNull();
});

test('a failing view plugin does not prevent the remaining plugins or expose altered IDs', async () => {
	const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
	pluginHandlers.mockReturnValue([
		{ handler: () => { throw new Error('broken plugin'); } },
		{ handler: note => ({ ...note, text: 'Next plugin' }) },
	]);
	const view = render(Note, { props: { note: original }, global: globals });
	expect(view.getByText('Next plugin')).toBeTruthy();
	expect(errorLog).toHaveBeenCalled();
	errorLog.mockRestore();
});

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
	expect(view.container.querySelector<HTMLElement>('[data-note-channel-colors] > span')?.style.backgroundColor).toBe(channel.color);
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

test('a channel quote uses the shared compact card and only the outer note has actions', () => {
	const source = { ...original, text: ':bloborange:', emojis: { bloborange: 'https://g.example/emoji/bloborange.webp' } };
	const view = render(Note, { props: { note: { ...original, id: 'quote', text: 'Comment', renoteId: source.id, renote: source } }, global: globals });
	expect(view.container.querySelectorAll('[data-note-simple]')).toHaveLength(1);
	expect(view.container.querySelectorAll('[data-note-article]')).toHaveLength(1);
	expect(view.getAllByRole('button', { name: 'Reply' })).toHaveLength(1);
	expect(view.getAllByRole('button', { name: 'Renote' })).toHaveLength(1);
	expect(view.queryByText('引用元を読む')).toBeNull();
	expect(view.getByText(':bloborange:')).toBeTruthy();
});

test('ordinary quote cards retain their default body rendering', () => {
	const note = { ...original, user: { ...original.author, id: 'author' }, userId: 'author' } as unknown as entities.Note;
	const view = render(SimpleNote, { props: { note }, global: globals });
	expect(view.container.querySelector('[data-note-simple]')).not.toBeNull();
	expect(view.getByText('Original content')).toBeTruthy();
});

test('a quoted CW hides its body until expanded', async () => {
	const source = { ...original, text: 'Hidden quote body', cw: 'Quote warning' };
	const view = render(Note, { props: { note: { ...original, id: 'quote', text: 'Comment', renoteId: source.id, renote: source } }, global: globals });
	expect(view.queryByText('Hidden quote body')).toBeNull();
	await fireEvent.click(view.getByRole('button', { name: 'Toggle CW' }));
	expect(view.getByText('Hidden quote body')).toBeTruthy();
});

test('quoting a pure renote still uses a compact card without another action bar', () => {
	const renote = { ...original, id: 'renote', text: null, renoteId: original.id, renote: original };
	const view = render(Note, { props: { note: { ...original, id: 'quote', text: 'Comment', renoteId: renote.id, renote } }, global: globals });
	expect(view.container.querySelectorAll('[data-note-simple]')).toHaveLength(1);
	expect(view.container.querySelectorAll('[data-note-article]')).toHaveLength(1);
	expect(view.getAllByRole('button', { name: 'Reply' })).toHaveLength(1);
});

test('quoted attachments use the authorized peer file API and revoke blobs when closed', async () => {
	const createBlob = vi.fn(() => 'blob:quote-test');
	const revokeBlob = vi.fn();
	vi.stubGlobal('URL', class extends URL { static createObjectURL = createBlob; static revokeObjectURL = revokeBlob; });
	api.mockResolvedValue({ data: 'aGk=', type: 'image/png' });
	const source = { ...original, text: 'Quote with file', files: [{ id: 'source-file', name: 'test.png', type: 'image/png', size: 2, comment: null, isSensitive: true }] };
	const view = render(Note, { props: { note: { ...original, id: 'quote', text: 'Comment', renoteId: source.id, renote: source } }, global: globals });
	const details = view.container.querySelector('details')!;
	expect(details.open).toBe(false);
	expect(api).not.toHaveBeenCalled();
	details.open = true;
	await fireEvent(details, new Event('toggle'));
	await fireEvent.click(view.getByRole('button', { name: /test.png/ }));
	expect(api).toHaveBeenCalledWith('gridspace/private-file', { noteId: source.id, fileId: 'source-file', channelId: 'channel' }, undefined, expect.anything());
	expect(createBlob).toHaveBeenCalledOnce();
	details.open = false;
	await fireEvent(details, new Event('toggle'));
	expect(revokeBlob).toHaveBeenCalledWith('blob:quote-test');
});

test('closing quoted attachments rejects a response that arrives later', async () => {
	const createBlob = vi.fn(() => 'blob:late-quote');
	vi.stubGlobal('URL', class extends URL { static createObjectURL = createBlob; static revokeObjectURL = vi.fn(); });
	let finish!: (value: { data: string; type: string }) => void;
	api.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
	const source = { ...original, files: [{ id: 'source-file', name: 'late.png', type: 'image/png', size: 2, comment: null, isSensitive: true }] };
	const view = render(Note, { props: { note: { ...original, id: 'quote', text: 'Comment', renoteId: source.id, renote: source } }, global: globals });
	const details = view.container.querySelector('details')!;
	details.open = true;
	await fireEvent(details, new Event('toggle'));
	await fireEvent.click(view.getByRole('button', { name: /late.png/ }));
	expect(api).toHaveBeenCalledOnce();
	details.open = false;
	await fireEvent(details, new Event('toggle'));
	finish({ data: 'aGk=', type: 'image/png' });
	await Promise.resolve(); await Promise.resolve();
	expect(createBlob).not.toHaveBeenCalled();
});

test('reopening a quoted CW does not preload a closed attachment disclosure', async () => {
	settings.dataSaver.media = false;
	vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {} observe() { this.callback([{ isIntersecting: true }]); } disconnect() {} });
	vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:cw-quote'); static revokeObjectURL = vi.fn(); });
	api.mockResolvedValue({ data: 'aGk=', type: 'image/png' });
	const source = { ...original, cw: 'Warning', files: [{ id: 'source-file', name: 'test.png', type: 'image/png', size: 2, comment: null, isSensitive: false }] };
	const view = render(Note, { props: { note: { ...original, id: 'quote', text: 'Comment', renoteId: source.id, renote: source } }, global: globals });
	await fireEvent.click(view.getByRole('button', { name: 'Toggle CW' }));
	const details = view.container.querySelector('details')!;
	details.open = true;
	await fireEvent(details, new Event('toggle'));
	await vi.waitFor(() => expect(api).toHaveBeenCalledOnce());
	await fireEvent.click(view.getByRole('button', { name: 'Toggle CW' }));
	api.mockClear();
	await fireEvent.click(view.getByRole('button', { name: 'Toggle CW' }));
	expect(view.container.querySelector('details')?.open).toBe(false);
	expect(api).not.toHaveBeenCalled();
});

test('a cached quote resets both its disclosure state and DOM when reopened', async () => {
	const shown = ref(true);
	const source = { ...original, files: [{ id: 'source-file', name: 'test.png', type: 'image/png', size: 2, comment: null, isSensitive: true }] };
	const Wrapper = defineComponent({ components: { Note, KeepAlive }, setup: () => ({ shown, source }), template: '<KeepAlive><Note v-if="shown" :note="source" quotePreview /></KeepAlive>' });
	const view = render(Wrapper, { global: globals });
	const details = view.container.querySelector('details')!;
	details.open = true;
	await fireEvent(details, new Event('toggle'));
	shown.value = false; await nextTick();
	shown.value = true; await nextTick();
	expect(view.container.querySelector('details')?.open).toBe(false);
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

test('an unimported ordinary note links to the original and exposes no delegated actions', () => {
	const view = render(Note, { props: { note: original, readOnly: true }, global: globals });
	expect(view.getByText('Original content')).toBeTruthy();
	expect(view.getByRole('link', { name: 'Open original' }).getAttribute('href')).toBe(original.uri);
	expect(view.queryByRole('button', { name: 'Reply' })).toBeNull();
	expect(view.queryByRole('button', { name: 'React' })).toBeNull();
	expect(view.queryByRole('button', { name: 'More' })).toBeNull();
	expect(api).not.toHaveBeenCalled();
});

test('deleting an authorized guest reply retries the same request on the original server', async () => {
	const note = { ...original, channelId: null, multiNoteKind: 'conversation-reply' as const, includeDefault: false, canDelete: true };
	const view = render(Note, { props: { note }, global: globals });
	menu.mockResolvedValue(undefined);
	await fireEvent.click(view.getByRole('button', { name: 'More' }));
	const items = menu.mock.calls[0][0] as { text: string; action: () => Promise<void> }[];
	const remove = items.find(item => item.text === 'Delete')!;
	api.mockRejectedValueOnce(new Error('uncertain')).mockResolvedValueOnce({ deleted: true });
	await remove.action();
	await remove.action();
	const request = { canonicalUri: note.uri, requestId: expect.any(String) };
	expect(api).toHaveBeenNthCalledWith(1, 'gridspace/delete-reply', request, undefined, expect.anything());
	expect(api).toHaveBeenNthCalledWith(2, 'gridspace/delete-reply', api.mock.calls[0][1], undefined, expect.anything());
	expect(view.queryByText(note.text!)).toBeNull();
});
