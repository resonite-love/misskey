/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource } from 'typeorm';
import type { ModuleRef } from '@nestjs/core';
import type { Config } from '@/config.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiGridspaceLink } from '@/models/Gridspace.js';
import { MiClip } from '@/models/Clip.js';
import { MiNote } from '@/models/Note.js';
import type { GlobalEventService } from '@/core/GlobalEventService.js';
import type { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceManagedResourceService } from './GridspaceManagedResourceService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import type { GridspaceSharedDriveService } from './GridspaceSharedDriveService.js';

function fixture() {
	const db = mockDeep<DataSource>(); const modules = mockDeep<ModuleRef>(); const links = mockDeep<GridspaceLinkService>();
	const pair = { id: 'pair', localUserId: 'viewer', peerUserId: 'peer', peerOrigin: 'https://r.example', generation: 1 };
	const state = { owned: true, active: true, hidden: false, note: { id: 'native', uri: 'https://r.example/notes/original' }, error: undefined as ApiError | undefined };
	const execute = vi.fn(async (path: string) => {
		if (path === 'notes/show') return { id: 'native', isHidden: state.hidden };
		if (state.error) throw state.error;
	});
	db.getRepository.mockImplementation(entity => {
		if (entity === MiUser) return { existsBy: async () => true, findOneByOrFail: async () => ({ id: 'viewer' }) } as never;
		if (entity === MiGridspaceLink) return { findOneBy: async () => state.active ? pair : null } as never;
		if (entity === MiClip) return { existsBy: async () => state.owned } as never;
		if (entity === MiNote) return { findOneBy: async () => state.note } as never;
		throw new Error('Unexpected repository');
	});
	modules.get.mockImplementation((path: unknown) => ({ exec: () => execute(String(path).replace('ep:', '')) }) as never);
	links.json.mockResolvedValue({ enabled: true, origin: pair.peerOrigin, item: null, items: [], aliases: [] });
	const service = new GridspaceManagedResourceService(db, { url: 'https://g.example', gridspace: { enabled: true, peerUrl: pair.peerOrigin } } as Config,
		modules, links, mockDeep<GridspaceSharedDriveService>(), mockDeep<GlobalEventService>(), mockDeep<CustomEmojiService>());
	const peer = (action: 'add-note' | 'remove-note' = 'add-note') => service.peer({ kind: 'clip', action, id: 'clip', data: { noteUrl: 'https://g.example/notes/native' }, linkId: pair.id, generation: 1, peerUserId: 'viewer', localUserId: 'peer' });
	return { service, state, execute, links, peer };
}

describe('shared clip membership', () => {
	test('adds and removes using the clip owner and receiver-local note ID', async () => {
		const f = fixture(); await f.peer(); await f.peer('remove-note');
		expect(f.execute.mock.calls.map(args => args[0])).toEqual(['notes/show', 'clips/add-note', 'clips/remove-note']);
	});
	test('rejects non-owned clips and revoked links before reading or writing', async () => {
		for (const change of ['owned', 'active'] as const) {
			const f = fixture(); f.state[change] = false;
			await expect(f.peer()).rejects.toMatchObject({ code: 'GRIDSPACE_RESOURCE_UNAVAILABLE' });
			expect(f.execute).not.toHaveBeenCalled();
		}
	});
	test('rejects notes hidden from the destination owner', async () => {
		const f = fixture(); f.state.hidden = true;
		await expect(f.peer()).rejects.toMatchObject({ code: 'GRIDSPACE_RESOURCE_UNAVAILABLE' });
		expect(f.execute).toHaveBeenCalledTimes(1);
	});
	test('preserves duplicate and limit outcomes for the normal confirmation UI', async () => {
		const f = fixture();
		f.state.error = new ApiError({ code: 'ALREADY_CLIPPED', message: 'already', id: 'duplicate' });
		expect(await f.peer()).toMatchObject({ clipNoteError: 'already-added' });
		f.state.error = new ApiError({ code: 'TOO_MANY_CLIP_NOTES', message: 'limit', id: 'limit' });
		expect(await f.peer()).toMatchObject({ clipNoteError: 'too-many' });
	});
	test('derives canonical note URL server-side and strips caller-supplied URL/token', async () => {
		const f = fixture();
		await f.service.request({ id: 'viewer' } as MiLocalUser, { kind: 'clip', action: 'add-note', id: 'clip', data: { noteId: 'native', noteUrl: 'https://evil.example/notes/x', i: 'secret' } });
		expect(f.links.json).toHaveBeenCalledWith('/gridspace/v1/managed-resource', expect.objectContaining({ data: { noteUrl: 'https://r.example/notes/original' } }));
	});
	test('does not forward hidden caller notes', async () => {
		const f = fixture(); f.state.hidden = true;
		await expect(f.service.request({ id: 'viewer' } as MiLocalUser, { kind: 'clip', action: 'add-note', id: 'clip', data: { noteId: 'native' } })).rejects.toThrow();
		expect(f.links.json).not.toHaveBeenCalled();
	});
	test('allows removing a previously clipped note after it becomes unreadable', async () => {
		const f = fixture(); f.state.hidden = true;
		await f.peer('remove-note');
		expect(f.execute).toHaveBeenCalledWith('clips/remove-note');
		f.execute.mockClear();
		await f.service.request({ id: 'viewer' } as MiLocalUser, { kind: 'clip', action: 'remove-note', id: 'clip', data: { noteId: 'native' } });
		expect(f.execute).not.toHaveBeenCalled();
	});
});
