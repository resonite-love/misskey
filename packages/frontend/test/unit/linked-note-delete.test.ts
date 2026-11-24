/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { beforeEach, expect, test, vi } from 'vitest';
import type { entities } from 'misskey-js';
import { getLinkedNoteDeleteMenu } from '@/utility/linked-note-delete.js';

const { confirm, api, emit, account } = vi.hoisted(() => ({ confirm: vi.fn(), api: vi.fn(), emit: vi.fn(), account: { id: 'grid-user' } }));
vi.mock('@/i.js', () => ({ $i: account }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { delete: 'Delete', noteDeleteConfirm: 'Delete this note?' } } }));
vi.mock('@/os.js', () => ({ confirm, apiWithDialog: api }));
vi.mock('@/events.js', () => ({ globalEvents: { emit } }));
const note = { id: 'local-copy', user: { username: 'old', host: 'r.example' } } as entities.Note;
const state = { isFavorited: false, isMutedThread: false, gridspaceDeleteTarget: { noteId: 'source', actorUri: 'https://r.example/users/old' } } as entities.NotesStateResponse;
const event = {} as PointerEvent;
beforeEach(() => { vi.resetAllMocks(); account.id = 'grid-user'; });

test('does not offer deletion for a normal remote note', () => {
	expect(getLinkedNoteDeleteMenu(note, { isFavorited: false, isMutedThread: false })).toBeNull();
});

test('confirms the linked account and deletes the source ID, then removes both representations', async () => {
	confirm.mockResolvedValue({ canceled: false }); api.mockResolvedValue({ deleted: true });
	const item = getLinkedNoteDeleteMenu(note, state)!;
	expect(item.caption).toBe('@old@r.example');
	await item.action(event);
	expect(confirm).toHaveBeenCalledWith({ type: 'warning', title: '@old@r.example', text: 'Delete this note?' });
	expect(api).toHaveBeenCalledWith('gridspace/note-menu', { action: 'delete', noteId: 'source', channelId: undefined, expectedActorUri: 'https://r.example/users/old' });
	expect(emit.mock.calls).toEqual([['noteDeleted', 'local-copy'], ['gridspaceNoteDeleted', 'source']]);
});

test.each(['cancel', 'account-switch', 'rejected'] as const)('leaves the note in place after %s', async reason => {
	confirm.mockImplementation(async () => {
		if (reason === 'account-switch') account.id = 'other';
		return { canceled: reason === 'cancel' };
	});
	api.mockRejectedValue(Error('grant revoked'));
	const run = () => getLinkedNoteDeleteMenu(note, state)!.action(event);
	if (reason === 'rejected') await expect(run()).rejects.toThrow('grant revoked');
	else { await run(); expect(api).not.toHaveBeenCalled(); }
	expect(emit).not.toHaveBeenCalled();
});
