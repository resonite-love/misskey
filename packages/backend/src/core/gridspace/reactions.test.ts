/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource, SelectQueryBuilder } from 'typeorm';
import type { Config } from '@/config.js';
import { MiNote } from '@/models/Note.js';
import type { MiLocalUser } from '@/models/User.js';
import type { ExtendedReactionService } from '@/core/ExtendedReactionService.js';
import type { CustomEmojiService } from '@/core/CustomEmojiService.js';
import type { IdService } from '@/core/IdService.js';
import type { UserEntityService } from '@/core/entities/UserEntityService.js';
import type { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import type { GridspaceSearchService } from './GridspaceSearchService.js';
import { GridspaceReactionService } from './GridspaceReactionService.js';
import { GridspaceReactionDeliveryService } from './GridspaceReactionDeliveryService.js';
import { requestGridspacePeer } from './peer-client.js';

vi.mock('./peer-client.js', () => ({ requestGridspacePeer: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

function fixture(remote = false) {
	vi.stubEnv('REACTION_TEST_KEY', Buffer.alloc(32, 1).toString('base64'));
	const note = { id: 'note', userHost: remote ? 'r.example' : null, uri: remote ? 'https://r.example/notes/source' : null, visibility: 'public', channelId: null, reactionAcceptance: null } as MiNote;
	const viewer = { id: 'viewer', host: null } as MiLocalUser;
	const db = mockDeep<DataSource>(); const extended = mockDeep<ExtendedReactionService>(); const search = mockDeep<GridspaceSearchService>();
	const emojis = mockDeep<CustomEmojiService>(); const people = mockDeep<ApPersonService>(); const users = mockDeep<UserEntityService>();
	const query = mockDeep<SelectQueryBuilder<MiNote>>(); query.andWhere.mockReturnValue(query); query.select.mockReturnValue(query); query.orderBy.mockReturnValue(query);
	search.noteQuery.mockReturnValue(query); search.read.mockResolvedValue([note]);
	db.getRepository.mockReturnValue({ findBy: async () => [note], findOneBy: async () => null } as never);
	db.query.mockResolvedValue([]); emojis.populateEmojis.mockResolvedValue({}); emojis.localEmojisCache.fetch.mockResolvedValue(new Map());
	extended.show.mockResolvedValue([{ noteId: note.id, reactions: { '👍': 1 }, myReaction: '👍', myReactions: ['👍'], reactionEmojis: {} }]);
	const config = { url: 'https://g.example', id: 'aidx', gridspace: { enabled: true, communityId: 'reactions', peerUrl: 'https://r.example', keyId: 'v1', secretEnv: 'REACTION_TEST_KEY' } } as Config;
	const delivery = mockDeep<GridspaceReactionDeliveryService>(); delivery.supportsPush.mockResolvedValue(true);
	const service = new GridspaceReactionService(db, config, extended, search, emojis, mockDeep<IdService>(), people, users, delivery);
	return { service, note, viewer, db, extended, search, people };
}

describe('paired reaction authorization and failures', () => {
	test('returns an explicitly incomplete local snapshot on peer failure', async () => {
		const f = fixture(); vi.mocked(requestGridspacePeer).mockRejectedValue(new Error('offline'));
		expect(await f.service.show([f.note.id], f.viewer)).toEqual([expect.objectContaining({ complete: false, shared: true, myReactions: ['👍'] })]);
	});
	test('does not turn source denial into a cached reaction response', async () => {
		const f = fixture(true); vi.mocked(requestGridspacePeer).mockResolvedValue([]);
		expect(await f.service.show([f.note.id], f.viewer)).toEqual([]);
		await expect(f.service.create(f.viewer, f.note, '🎉')).rejects.toMatchObject({ id: '68e9d2d1-48bf-42c2-b90a-b20e09fd3d48' });
		expect(f.extended.create).not.toHaveBeenCalled();
	});
	test('fails remote mutations closed but permits local mutations during an outage', async () => {
		const f = fixture(true); vi.mocked(requestGridspacePeer).mockRejectedValue(new Error('offline'));
		await expect(f.service.create(f.viewer, f.note, '🎉')).rejects.toMatchObject({ id: 'gridspace-reactions-unavailable' });
		await expect(f.service.delete(f.viewer, f.note, '🎉')).rejects.toMatchObject({ id: 'gridspace-reactions-unavailable' });
		expect(f.extended.create).not.toHaveBeenCalled(); expect(f.extended.delete).not.toHaveBeenCalled();
		f.note.userHost = null; f.note.uri = null;
		await f.service.create(f.viewer, f.note, '🎉'); expect(f.extended.create).toHaveBeenCalled();
	});
	test('does not contact the peer for unrelated servers', async () => {
		const f = fixture(true); f.note.userHost = 'external.example'; f.note.uri = 'https://external.example/notes/source';
		await expect(f.service.create(f.viewer, f.note, '🎉')).rejects.toMatchObject({ id: 'extended-local-only' });
		expect((await f.service.show([f.note.id], f.viewer))[0]).toMatchObject({ complete: true, shared: false });
		expect(requestGridspacePeer).not.toHaveBeenCalled();
	});
	test('rechecks local visibility after the peer read', async () => {
		const f = fixture(); f.search.read.mockResolvedValueOnce([f.note]).mockResolvedValueOnce([]);
		vi.mocked(requestGridspacePeer).mockResolvedValue([]);
		expect(await f.service.show([f.note.id], f.viewer)).toEqual([]);
	});
	test('does not reinterpret signed uncached users as anonymous visitors', async () => {
		const f = fixture();
		await f.service.peerRead({ mode: 'show', uris: ['https://g.example/notes/note'], viewerId: 'uncached' });
		expect(f.search.noteQuery).toHaveBeenCalledWith({ id: '' }, { query: '' }, false, true);
	});
	test('returns cached contributions only to their original signed source without needing replicated follower edges', async () => {
		const f = fixture(true); f.note.visibility = 'followers';
		f.search.read.mockResolvedValue([]);
		f.db.query.mockResolvedValue([{ reaction: '👍', count: '1', revision: 'revision' }]);
		const result = await f.service.peerRead({ mode: 'show', uris: [f.note.uri!], viewerId: 'sourcefollower' });
		expect(result[0].reactions).toEqual({ '👍': 1 });
		expect(f.search.noteQuery).not.toHaveBeenCalled();
		f.note.userHost = null; f.note.uri = null;
		expect(await f.service.peerRead({ mode: 'show', uris: ['https://g.example/notes/note'], viewerId: 'unauthorized' })).toEqual([]);
	});
});
