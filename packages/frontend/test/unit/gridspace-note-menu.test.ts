/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { beforeEach, expect, test, vi } from 'vitest';
import { ref } from 'vue';
import type { entities } from 'misskey-js';
import { getGridspaceNoteMenu } from '@/utility/gridspace-note-menu.js';
const { api, nativeMenu, copy, page } = vi.hoisted(() => ({ api: vi.fn(), nativeMenu: vi.fn(), copy: vi.fn(), page: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/utility/get-note-menu.js', () => ({ getNoteMenu: nativeMenu }));
vi.mock('@/utility/copy-to-clipboard.js', () => ({ copyToClipboard: copy }));
vi.mock('@/os.js', () => ({ pageWindow: page }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { details: 'Details', copyContent: 'Copy content', copyLink: 'Copy link', showOnRemote: 'Remote' } } }));
const note = { id: 'source', uri: 'https://source/notes/source', visibility: 'public', text: 'body' } as entities.GridspacePrivateNotesResponse['notes'][number];
beforeEach(() => { vi.resetAllMocks(); });
test('uses the ordinary menu with the server-resolved local note ID', async () => {
	const local = { id: 'local' }; const result = { menu: ['native'], cleanup: vi.fn() };
	api.mockResolvedValue(local); nativeMenu.mockReturnValue(result);
	expect(await getGridspaceNoteMenu(note, '/detail', ref(null), ref(false))).toBe(result);
	expect(api).toHaveBeenCalledWith('gridspace/renote-target', { noteId: 'source' });
	expect(nativeMenu.mock.calls[0][0].note).toEqual(local);
});
test.each(['followers', 'specified'])('does not pass %s bodies or source IDs to normal APIs', async visibility => {
	const result = await getGridspaceNoteMenu({ ...note, visibility }, '/detail', ref(null), ref(false));
	expect(api).not.toHaveBeenCalled(); expect(nativeMenu).not.toHaveBeenCalled();
	expect(result.menu.map(item => typeof item === 'object' && item && 'text' in item ? item.text : '')).toEqual(['Details', 'Copy content', 'Copy link', 'Remote']);
});
test('keeps safe actions when the source becomes unavailable', async () => {
	api.mockRejectedValue(new Error('offline'));
	const result = await getGridspaceNoteMenu(note, '/detail', ref(null), ref(false));
	const item = result.menu[1];
	if (item && typeof item === 'object' && 'action' in item) item.action({} as PointerEvent);
	expect(copy).toHaveBeenCalledWith('body'); expect(nativeMenu).not.toHaveBeenCalled();
});

test('an open delegated menu stops exposing content after suspension or revocation cleanup', async () => {
	const result = await getGridspaceNoteMenu({ ...note, visibility: 'specified' }, '/detail', ref(null), ref(false));
	result.cleanup();
	for (const item of result.menu) {
		if (item && typeof item === 'object' && 'action' in item) item.action({} as PointerEvent);
	}
	expect(copy).not.toHaveBeenCalled(); expect(page).not.toHaveBeenCalled();
});
