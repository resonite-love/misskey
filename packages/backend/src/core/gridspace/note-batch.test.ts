/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { MiNote } from '@/models/Note.js';
import { GridspaceNoteService } from './GridspaceNoteService.js';
import { GridspaceEndpointUnavailable, requestGridspacePeer } from './peer-client.js';

vi.mock('./peer-client.js', async importOriginal => ({ ...await importOriginal<object>(), requestGridspacePeer: vi.fn() }));
vi.mock('@/misc/distributed-lock.js', () => ({ acquireApObjectLock: async () => async () => {} }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

function fixture() {
	vi.stubEnv('NOTE_BATCH_TEST_KEY', Buffer.alloc(32, 7).toString('base64'));

	type Args = ConstructorParameters<typeof GridspaceNoteService>;
	const db = mockDeep<Args[1]>(); const ap = mockDeep<Args[5]>(); const resolver = mockDeep<Args[6]>();
	const create = mockDeep<Args[7]>(); const remove = mockDeep<Args[8]>();
	db.getRepository.mockReturnValue({ existsBy: async () => false } as never);
	ap.fetchNote.mockImplementation(async uri => ({ id: uri.split('/').at(-1), gridspaceShared: true } as MiNote));
	const service = new GridspaceNoteService({ url: 'https://g.example', gridspace: { enabled: true, peerUrl: 'https://r.example', communityId: 'test', keyId: 'test', secretEnv: 'NOTE_BATCH_TEST_KEY' } } as Args[0],
		db, mockDeep<Args[2]>(), mockDeep<Args[3]>(), mockDeep<Args[4]>(), ap, resolver, create, remove, mockDeep<Args[9]>(), mockDeep<Args[10]>());
	return { service, ap, create, remove, budget: { remaining: 64, deadline: Date.now() + 15000 } };
}

function bundle(id: string) {
	return { deleted: false, notes: [{ localOnly: true, reactionAcceptance: null, object: {
		type: 'Note', id: `https://r.example/notes/${id}`, attributedTo: 'https://r.example/users/author', to: ['https://www.w3.org/ns/activitystreams#Public'], cc: [],
	} }] };
}

test('reads a full page once, excludes unavailable posts and does not republish existing posts', async () => {
	const f = fixture();
	vi.mocked(requestGridspacePeer).mockResolvedValue({ items: [{ id: 'a', bundle: bundle('a') }, { id: 'b', bundle: { deleted: false, unavailable: true, notes: [] } }] });
	expect([...(await f.service.historyNotes(['a', 'b'], f.budget)).keys()]).toEqual(['a']);
	expect(requestGridspacePeer).toHaveBeenCalledTimes(1);
	expect(f.create.pushToTl).not.toHaveBeenCalled();
	expect(f.remove.delete).not.toHaveBeenCalled();
});

test('validates the whole response before importing and never retries failures per note', async () => {
	const f = fixture();
	vi.mocked(requestGridspacePeer).mockResolvedValue({ items: [{ id: 'a', bundle: bundle('a') }] });
	await expect(f.service.historyNotes(['a', 'b'], f.budget)).rejects.toThrow();
	expect(f.ap.fetchNote).not.toHaveBeenCalled();
	vi.mocked(requestGridspacePeer).mockRejectedValue(new Error('offline'));
	await expect(f.service.historyNotes(['a', 'b'], f.budget)).rejects.toThrow('offline');
	expect(requestGridspacePeer).toHaveBeenCalledTimes(2);
});

test('only an absent endpoint falls back to individually authorized reads during rolling upgrades', async () => {
	const f = fixture();
	vi.mocked(requestGridspacePeer).mockRejectedValueOnce(new GridspaceEndpointUnavailable()).mockImplementation(async (_peer, _path, input) => bundle((input as { noteId: string }).noteId));
	expect([...(await f.service.historyNotes(['a', 'b'], f.budget)).keys()].sort()).toEqual(['a', 'b']);
	expect(requestGridspacePeer).toHaveBeenCalledTimes(3);
});

test('enforces the shared import budget even with prefetched bodies', async () => {
	const f = fixture();
	vi.mocked(requestGridspacePeer).mockResolvedValue({ items: [{ id: 'a', bundle: bundle('a') }] });
	await expect(f.service.historyNotes(['a'], { ...f.budget, remaining: 0 })).rejects.toThrow('budget');
	expect(f.ap.fetchNote).not.toHaveBeenCalled();
});
