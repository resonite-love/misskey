/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { DataSource, SelectQueryBuilder } from 'typeorm';
import type { Config } from '@/config.js';
import { noteListingCondition } from '@/misc/note-distribution.js';
import type { QueryService } from '@/core/QueryService.js';
import type { RoleService } from '@/core/RoleService.js';
import type { IdService } from '@/core/IdService.js';
import type { MiNote } from '@/models/Note.js';
import type { MiLocalUser } from '@/models/User.js';
import type { GridspaceSearchService } from '../GridspaceSearchService.js';
import type { GridspaceHistoryService } from '../GridspaceHistoryService.js';
import type { TimelineLocalSource } from './TimelineLocalSource.js';
import { GridspaceTimelineListSourceService } from './GridspaceTimelineListSourceService.js';

const viewer = { id: 'viewer' } as MiLocalUser;

function fixture() {
	const builder = {
		innerJoinAndSelect: vi.fn().mockReturnThis(), leftJoinAndSelect: vi.fn().mockReturnThis(),
		where: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(), setParameters: vi.fn().mockReturnThis(),
		select: vi.fn().mockReturnThis(), addSelect: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
		getRawMany: vi.fn().mockResolvedValue([{ noteId: 'a', uri: null }]),
		getMany: vi.fn().mockResolvedValue([{ id: 'a', uri: null }]),
	};
	const query = builder as unknown as SelectQueryBuilder<MiNote>;
	const db = { getRepository: vi.fn(() => ({ createQueryBuilder: () => query, findOneBy: vi.fn().mockResolvedValue({ id: 'counterpart' }) })) };
	const queries = { generateVisibilityQuery: vi.fn(), generateBaseNoteFilteringQuery: vi.fn(), generateMutedNoteThreadQuery: vi.fn() };
	const roles = { getUserPolicies: vi.fn().mockResolvedValue({ canSearchNotes: true }) };
	const search = { noteQuery: vi.fn(() => query), read: vi.fn((query: SelectQueryBuilder<MiNote>) => query.getMany()) };
	const history = { findLink: vi.fn().mockResolvedValue(null), viewerQuery: vi.fn(() => query) };
	const hydrateQuery = vi.fn(async (_viewer, factory, refs) => { await factory(); return refs.map((reference: unknown) => ({ reference })); });
	const service = new GridspaceTimelineListSourceService(db as unknown as DataSource, { id: 'aidx', url: 'https://local.test' } as Config,
		queries as unknown as QueryService, roles as unknown as RoleService, search as unknown as GridspaceSearchService,
		history as unknown as GridspaceHistoryService, { parse: () => ({ date: new Date(1234) }) } as unknown as IdService,
		{ hydrateQuery } as unknown as TimelineLocalSource);
	return { service, builder, queries, roles, search, history, hydrateQuery };
}

describe('other-list source authorization and keysets', () => {
	test('ownership candidates keep the list ACL without packing display bodies', async () => {
		const { service, builder, hydrateQuery } = fixture();
		const refs = await service.ownerCandidates(viewer, { kind: 'mentions' }, ['https://local.test/notes/a']);
		expect(refs).toHaveLength(1);
		expect(builder.andWhere).toHaveBeenCalledWith('(:listViewer::varchar[] <@ note.mentions OR :listViewer::varchar[] <@ note.visibleUserIds)', { listViewer: ['viewer'] });
		expect(hydrateQuery).not.toHaveBeenCalled();
	});
	test.each(['mentions', 'direct'] as const)('%s uses current viewer recipients, visibility and thread filtering', async kind => {
		const { service, builder, search, queries } = fixture();
		await service.buildQuery(viewer, { kind });
		expect(search.noteQuery).toHaveBeenCalledWith(viewer, { query: '' }, false, true, undefined, false, true);
		expect(builder.andWhere).toHaveBeenCalledWith('(:listViewer::varchar[] <@ note.mentions OR :listViewer::varchar[] <@ note.visibleUserIds)', { listViewer: ['viewer'] });
		expect(queries.generateMutedNoteThreadQuery).toHaveBeenCalledWith(expect.anything(), viewer);
		expect(builder.andWhere.mock.calls.some(([sql]) => sql === "note.visibility = 'specified'")).toBe(kind === 'direct');
	});
	test('search checks current search permission before building a result query', async () => {
		const { service, roles, search } = fixture(); roles.getUserPolicies.mockResolvedValue({ canSearchNotes: false });
		await expect(service.buildQuery(viewer, { kind: 'search', query: 'secret' })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		expect(search.noteQuery).not.toHaveBeenCalled();
	});
	test('ordinary profile retains author-mute exception and applies channel and specified-recipient rules', async () => {
		const { service, builder, queries } = fixture();
		await service.buildQuery(viewer, { kind: 'profile', userId: 'author', withChannelNotes: true, withRenotes: false });
		expect(queries.generateBaseNoteFilteringQuery).toHaveBeenCalledWith(expect.anything(), viewer, { excludeAuthor: true, excludeUserFromMute: 'author' });
		expect(builder.andWhere).toHaveBeenCalledWith(...noteListingCondition({ kind: 'profile', viewerId: viewer.id }));
		expect(builder.andWhere.mock.calls.map(([sql]) => sql).join('\n')).toContain(':privacyViewer = ANY(note.visibleUserIds)');
		expect(builder.andWhere.mock.calls.map(([sql]) => sql).join('\n')).toContain('cm."expiresAt" > CURRENT_TIMESTAMP');
		expect(builder.andWhere.mock.calls.map(([sql]) => sql).join('\n')).toContain('profile_block."blockeeId" = :listSelf');
	});
	test.each([true, false])('unlinked profile reads and hydration use the same listing when withChannelNotes=%s', async withChannelNotes => {
		const { service, builder } = fixture();
		const options = { kind: 'profile' as const, userId: 'author', withChannelNotes };
		const expected = noteListingCondition(withChannelNotes ? { kind: 'profile', viewerId: viewer.id } : { kind: 'default' });
		const refs = await service.read(viewer, options, { limit: 10 });
		expect(builder.andWhere).toHaveBeenCalledWith(...expected);
		builder.andWhere.mockClear();
		await service.hydrate(viewer, options, refs);
		expect(builder.andWhere).toHaveBeenCalledWith(...expected);
		builder.andWhere.mockClear();
		await service.hydrateImported(viewer, options, refs);
		expect(builder.andWhere).toHaveBeenCalledWith(...expected);
	});
	test('linked profile reuses history ACL and re-resolves the link during hydration', async () => {
		const { service, history, hydrateQuery } = fixture();
		history.findLink.mockResolvedValue({ id: 'link', localUserId: 'author', peerUserId: 'peer' } as never);
		await service.buildQuery(viewer, { kind: 'profile', userId: 'author' });
		expect(history.viewerQuery).toHaveBeenCalledWith(expect.objectContaining({ id: 'link' }), viewer, { withReplies: false, withRenotes: true, withFiles: false, withChannelNotes: false }, false);
		await service.hydrate(viewer, { kind: 'profile', userId: 'author' }, []);
		expect(history.findLink).toHaveBeenCalledTimes(2); expect(hydrateQuery).toHaveBeenCalled();
	});
	test('read preserves own-source ID order and independent before/upper cursor bounds', async () => {
		const { service, builder } = fixture();
		const refs = await service.read(viewer, { kind: 'mentions' }, { before: { noteId: 'before', sortAt: '1', canonicalUri: 'https://x/a' }, upper: { noteId: 'head', sortAt: '2', canonicalUri: 'https://x/b' }, limit: 20 });
		expect(builder.andWhere).toHaveBeenCalledWith('note.id < :listBefore', { listBefore: 'before' });
		expect(builder.andWhere).toHaveBeenCalledWith('note.id <= :listUpper', { listUpper: 'head' });
		expect(builder.orderBy).toHaveBeenCalledWith('CONCAT(note.id)', 'DESC');
		expect(refs).toEqual([{ noteId: 'a', canonicalUri: 'https://local.test/notes/a', sortAt: '1234000', source: 'local', normalized: true, generation: 1 }]);
	});
	test('linked search expands only the author pair and keeps the query on the local/peer hosts', async () => {
		const { service, history, search, builder } = fixture();
		Object.assign(service, { peer: { origin: 'https://local.test', peerOrigin: 'https://peer.test' } });
		history.findLink.mockResolvedValue({ id: 'link', localUserId: 'author', peerUserId: 'peer' } as never);
		await service.buildQuery(viewer, { kind: 'search', query: '  match  ', userId: 'author', rangeStartAt: 1000, rangeEndAt: 2000 });
		expect(search.noteQuery).toHaveBeenCalledWith(viewer, expect.objectContaining({ query: 'match', userId: 'author', rangeStartAt: 1000, rangeEndAt: 2000 }), false, true, undefined, true);
		expect(builder.andWhere).toHaveBeenCalledWith('(note.userHost IS NULL OR note.userHost = :listPeerHost)', { listPeerHost: 'peer.test' });
		expect(builder.andWhere).toHaveBeenCalledWith('note.userId IN (:...listAuthors)', { listAuthors: ['author', 'counterpart'] });
	});
	test('ownership respects the original snapshot upper boundary and rechecks root ACL', async () => {
		const { service, builder, hydrateQuery } = fixture();
		const refs = await service.ownerReferences(viewer, { kind: 'mentions' }, ['https://local.test/notes/a'], { noteId: 'head', sortAt: '2', canonicalUri: 'https://local.test/notes/head' });
		expect(builder.andWhere).toHaveBeenCalledWith('note.id <= :listOwnerUpper', { listOwnerUpper: 'head' });
		expect(hydrateQuery).toHaveBeenCalledWith(viewer, expect.any(Function), expect.arrayContaining([expect.objectContaining({ noteId: 'a' })]));
		expect(refs).toHaveLength(1);
	});
	test('ownership requires fresh allowed hydration rather than the existence of a cached URI', async () => {
		const { service, hydrateQuery } = fixture(); hydrateQuery.mockResolvedValue([]);
		expect(await service.ownerReferences(viewer, { kind: 'mentions' }, ['https://local.test/notes/a'])).toEqual([]);
		expect(hydrateQuery).toHaveBeenCalled();
	});
	test('rejects malformed cursor IDs and inactive viewers before a page is returned', async () => {
		const { service, builder } = fixture();
		await expect(service.read(viewer, { kind: 'mentions' }, { before: { noteId: '../secret', sortAt: '1', canonicalUri: 'https://x/a' }, limit: 20 })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
		await expect(service.buildQuery({ ...viewer, isSuspended: true }, { kind: 'direct' })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		expect(builder.getRawMany).not.toHaveBeenCalled();
	});
});
