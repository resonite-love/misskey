/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, expect, test, vi } from 'vitest';
import Endpoint from '@/server/api/endpoints/drive/files/resonite-package.js';

const fileId = 'aaaaaaaaaaaaaaaa';
const noteId = 'bbbbbbbbbbbbbbbb';
const info = { schemaVersion: 1, name: 'Box', assetCount: 1, assetBytes: 24, unpackedBytes: 100, variantCount: 0, recordCount: 1 };
const file = { id: fileId, userId: 'owner', name: 'Box.resonitepackage', properties: {} };
const files = { findOneBy: vi.fn() };
const getter = { getNoteWithRelations: vi.fn() };
const notes = { pack: vi.fn() };
const roles = { isModerator: vi.fn() };
const packages = { inspect: vi.fn() };
const server = { ugcVisibilityForVisitor: 'all' };

function endpoint() {
	return new Endpoint(files as never, server as never, getter as never, notes as never, roles as never, packages as never);
}

beforeEach(() => {
	vi.resetAllMocks();
	server.ugcVisibilityForVisitor = 'all';
	files.findOneBy.mockResolvedValue(file);
	getter.getNoteWithRelations.mockResolvedValue({ id: noteId, userHost: null, user: { requireSigninToViewContents: false } });
	notes.pack.mockResolvedValue({ files: [{ id: fileId }] });
	roles.isModerator.mockResolvedValue(false);
	packages.inspect.mockResolvedValue(info);
});

test('owners can inspect their own unattached file', async () => {
	expect(await endpoint().exec({ fileId }, { id: 'owner' } as never, null)).toEqual(info);
	expect(getter.getNoteWithRelations).not.toHaveBeenCalled();
});

test('app tokens need read:drive for private owner access but can read public note attachments', async () => {
	const restricted = { permission: [] } as never;
	await expect(endpoint().exec({ fileId }, { id: 'owner' } as never, restricted)).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });
	expect(packages.inspect).not.toHaveBeenCalled();
	expect(await endpoint().exec({ fileId, noteId }, { id: 'owner' } as never, restricted)).toEqual(info);
	expect(await endpoint().exec({ fileId }, { id: 'owner' } as never, { permission: ['read:drive'] } as never)).toEqual(info);
});

test('other viewers need a readable note containing the exact attachment', async () => {
	await expect(endpoint().exec({ fileId }, { id: 'viewer' } as never, null)).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });
	expect(packages.inspect).not.toHaveBeenCalled();
	expect(await endpoint().exec({ fileId, noteId }, null, null)).toEqual(info);
});

test.each([{ isHidden: true, files: [{ id: fileId }] }, { files: [{ id: 'other' }] }])('does not inspect hidden or unrelated attachments', async packed => {
	notes.pack.mockResolvedValue(packed);
	await expect(endpoint().exec({ fileId, noteId }, { id: 'viewer' } as never, null)).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });
	expect(packages.inspect).not.toHaveBeenCalled();
});

test('respects server and author guest restrictions before reading content', async () => {
	server.ugcVisibilityForVisitor = 'none';
	await expect(endpoint().exec({ fileId, noteId }, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });
	server.ugcVisibilityForVisitor = 'all';
	getter.getNoteWithRelations.mockResolvedValue({ user: { requireSigninToViewContents: true } });
	await expect(endpoint().exec({ fileId, noteId }, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });
	expect(packages.inspect).not.toHaveBeenCalled();
});

test('rechecks access after an older package finishes loading', async () => {
	notes.pack.mockResolvedValueOnce({ files: [{ id: fileId }] }).mockResolvedValueOnce({ isHidden: true, files: [] });
	await expect(endpoint().exec({ fileId, noteId }, { id: 'viewer' } as never, null)).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });
	expect(packages.inspect).toHaveBeenCalledOnce();
});

test('unreadable packages remain unavailable without breaking their existing download', async () => {
	packages.inspect.mockRejectedValue(new Error('not a package'));
	expect(await endpoint().exec({ fileId }, { id: 'owner' } as never, null)).toBeNull();
});
