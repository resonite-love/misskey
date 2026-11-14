/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import { ref } from 'vue';
import type { entities } from 'misskey-js';
import { getGridspaceNoteMenu } from '@/utility/gridspace-note-menu.js';

const { api, nativeMenu, emit, confirm, copy, page } = vi.hoisted(() => ({ api: vi.fn(), nativeMenu: vi.fn(), emit: vi.fn(), confirm: vi.fn(), copy: vi.fn(), page: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/utility/get-note-menu.js', () => ({ getNoteMenu: nativeMenu }));
vi.mock('@/events.js', () => ({ globalEvents: { emit } }));
vi.mock('@/os.js', () => ({ apiWithDialog: (...args: unknown[]) => api(...args), confirm, pageWindow: page, inputText: vi.fn(), form: vi.fn(), alert: vi.fn() }));
vi.mock('@/utility/copy-to-clipboard.js', () => ({ copyToClipboard: copy }));
vi.mock('@/utility/get-user-menu.js', () => ({ getUserMenu: vi.fn() }));
vi.mock('@/utility/navigator.js', () => ({ isSupportShare: () => false }));
vi.mock('@/cache.js', () => ({ clipsCache: { delete: vi.fn() } }));
vi.mock('@/i.js', () => ({ $i: { id: 'new', policies: { canUseTranslator: false } } }));
vi.mock('@/instance.js', () => ({ instance: { translatorAvailable: false } }));
vi.mock('@/local-storage.js', () => ({ miLocalStorage: { getItem: () => 'ja' } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: new Proxy({}, { get: (_, key) => key }), tsx: { confirmToUnclipAlreadyClippedNote: () => 'remove?' } } }));
const note = { id: 'sourceNote', uri: 'https://r.example/notes/sourceNote', visibility: 'followers', author: { username: 'author', host: 'r.example' } } as entities.GridspacePrivateNotesResponse['notes'][number];
const state = { actorUri: 'https://r.example/users/old', canWrite: true, isOwn: false, isPinned: false, isFavorited: false, isMutedThread: false, deleted: false, clips: [{ id: 'sourceClip', name: 'Saved' }] };
const translation = () => ref<entities.NotesTranslateResponse | null>(null);
function action(menu: unknown[], text: string) { return (menu.find(item => item && typeof item === 'object' && (item as { text?: string }).text === text) as { action: () => Promise<unknown> }).action(); }
afterEach(() => { vi.resetAllMocks(); });

test('limited notes get normal menu actions, all routed with the source note and actor', async () => {
 api.mockResolvedValue(state);
 const result = await getGridspaceNoteMenu(note, '/private', translation(), ref(false));
 expect(result.menu).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'favorite' }), expect.objectContaining({ text: 'clip' }), expect.objectContaining({ text: 'muteThread' }), expect.objectContaining({ text: 'reportAbuse' })]));
 await action(result.menu, 'favorite');
 expect(api).toHaveBeenLastCalledWith('gridspace/note-menu', expect.objectContaining({ action: 'favorite', noteId: 'sourceNote', expectedActorUri: state.actorUri }));
 expect(nativeMenu).not.toHaveBeenCalled();
});

test.each(['followers', 'public'])('unclips %s source notes and removes only the selected clip row', async visibility => {
 api.mockImplementation(async path => path === 'gridspace/renote-target' ? { id: 'localCopy' } : state);
 nativeMenu.mockReturnValue({ menu: [{ text: 'details' }], cleanup: vi.fn() });
 const result = await getGridspaceNoteMenu({ ...note, visibility }, '/private', translation(), ref(false), { id: 'sourceClip', canManage: true });
 await action(result.menu, 'unclip');
 expect(api).toHaveBeenLastCalledWith('gridspace/note-menu', expect.objectContaining({ action: 'clip-remove', clipId: 'sourceClip', noteId: 'sourceNote' }));
 expect(emit).toHaveBeenCalledWith('gridspaceClipNoteRemoved', 'sourceClip', 'sourceNote');
});

test('popup closing does not cancel a pending user confirmation, leaving the row does', async () => {
 api.mockResolvedValue({ ...state, isOwn: true });
 let finish!: (value: { canceled: boolean }) => void;
 confirm.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
 let current = true;
 const result = await getGridspaceNoteMenu(note, '/private', translation(), ref(false), null, () => current);
 const pending = action(result.menu, 'delete'); result.cleanup(); finish({ canceled: false }); await pending;
 expect(api).toHaveBeenCalledWith('gridspace/note-menu', expect.objectContaining({ action: 'delete' }));
 api.mockClear();
 const again = action(result.menu, 'delete'); current = false; finish({ canceled: false }); await again;
 expect(api).not.toHaveBeenCalled();
});

test('an unavailable source leaves read-only entries without mutation controls', async () => {
 api.mockRejectedValue(Error('offline'));
 const result = await getGridspaceNoteMenu(note, '/private', translation(), ref(false), { id: 'sourceClip', canManage: true });
 expect(result.menu.some(item => item && typeof item === 'object' && 'text' in item && ['favorite', 'unclip', 'clip'].includes(String(item.text)))).toBe(false);
});


test('resolved normal notes keep the ordinary menu and never get the source ID', async () => {
 api.mockResolvedValue({ id: 'local' }); nativeMenu.mockReturnValue({ menu: [{ text: 'native' }], cleanup: vi.fn() });
 const result = await getGridspaceNoteMenu({ ...note, visibility: 'public' }, '/private', translation(), ref(false));
 expect(result.menu).toEqual([{ text: 'native' }]);
 expect(nativeMenu.mock.calls[0][0].note).toEqual({ id: 'local' });
});

test('read-only actions work during an outage but stop when the row is suspended', async () => {
 api.mockRejectedValue(Error('offline')); let current = true;
 const result = await getGridspaceNoteMenu({ ...note, text: 'secret' }, '/private', translation(), ref(false), null, () => current);
 await action(result.menu, 'copyContent'); expect(copy).toHaveBeenCalledWith('secret');
 copy.mockClear(); current = false; result.cleanup();
 await action(result.menu, 'copyContent'); await action(result.menu, 'details');
 expect(copy).not.toHaveBeenCalled(); expect(page).not.toHaveBeenCalled();
});
