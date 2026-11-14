/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Config } from '@/config.js';
import { MiUser } from '@/models/User.js';
import { MiGridspaceLink } from '@/models/Gridspace.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceManagedResourceService } from './GridspaceManagedResourceService.js';
import type { ModuleRef } from '@nestjs/core';
import type { DataSource } from 'typeorm';

function fixture() {
	const db = mockDeep<DataSource>(); const modules = mockDeep<ModuleRef>();
	const pair = { id: 'pair', localUserId: 'viewer', peerUserId: 'peer', generation: 1 };
	const state = { active: true, visible: true, favorited: false };
	db.getRepository.mockImplementation(entity => {
		if (entity === MiUser) return { existsBy: async () => true, findOneByOrFail: async () => ({ id: 'viewer' }) } as never;
		if (entity === MiGridspaceLink) return { findOneBy: async () => state.active ? pair : null } as never;
		throw Error('Unexpected repository');
	});
	const native = vi.fn(async (path: string, _data: unknown, actor: { id: string }) => {
		expect(actor.id).toBe('viewer');
		if (path === 'clips/show') { if (!state.visible) throw new ApiError({ id: 'not-visible', message: 'Missing clip', code: 'NO_SUCH_CLIP' }); return { id: 'clip', userId: 'someone-else', isPublic: true, isFavorited: state.favorited }; }
		if (path === 'clips/favorite') { if (state.favorited) throw new ApiError({ id: 'duplicate', message: 'Already', code: 'ALREADY_FAVORITED' }); state.favorited = true; }
		if (path === 'clips/unfavorite') state.favorited = false;
	});
	modules.get.mockImplementation(token => ({ exec: (data: unknown, user: { id: string }) => native(String(token).replace('ep:', ''), data, user) }) as never);
	const service = new GridspaceManagedResourceService(db, { url: 'https://source.example', gridspace: { enabled: true, peerUrl: 'https://destination.example' } } as Config, modules, {} as never, {} as never, {} as never, {} as never);
	const run = (action: 'favorite' | 'unfavorite') => service.peer({ kind: 'clip', action, id: 'clip', linkId: pair.id, generation: 1, peerUserId: 'viewer', localUserId: 'peer' });
	return { state, native, run };
}

describe('shared clip favorites', () => {
	test('favorites public clips owned by another user under the linked source account', async () => {
		const { run, native } = fixture();
		expect(await run('favorite')).toMatchObject({ item: { isFavorited: true } });
		expect(native.mock.calls.map(([path]) => path)).toEqual(['clips/show', 'clips/favorite', 'clips/show']);
		expect(await run('favorite')).toMatchObject({ item: { isFavorited: true } });
		expect(await run('unfavorite')).toMatchObject({ item: { isFavorited: false } });
	});
	test('rejects non-readable clips before writing and rejects revoked links', async () => {
		const f = fixture(); f.state.visible = false;
		await expect(f.run('favorite')).rejects.toMatchObject({ code: 'NO_SUCH_CLIP' });
		expect(f.native.mock.calls.some(([path]) => path === 'clips/favorite')).toBe(false);
		f.state.active = false; f.native.mockClear();
		await expect(f.run('favorite')).rejects.toMatchObject({ code: 'GRIDSPACE_RESOURCE_UNAVAILABLE' });
		expect(f.native).not.toHaveBeenCalled();
	});
	test('allows removal when the clip is no longer readable', async () => {
		const f = fixture(); f.state.visible = false; f.state.favorited = true;
		expect(await f.run('unfavorite')).toMatchObject({ item: null });
		expect(f.state.favorited).toBe(false);
	});
});
