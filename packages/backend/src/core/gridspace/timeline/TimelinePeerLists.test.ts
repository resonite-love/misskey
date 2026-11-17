/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { SelectQueryBuilder } from 'typeorm';
import type { MiNote } from '@/models/Note.js';
import { GridspacePrivateService } from '../GridspacePrivateService.js';
import { GridspaceLinkError } from '../GridspaceLinkService.js';
import type { PrivatePeerRequest } from '../private-protocol.js';

type Row = MiNote & { gridspaceCollection?: { id: string } };
const row = (id: string, sourceId?: string) => ({ id, uri: null, userId: 'author', user: {}, ...(sourceId ? { gridspaceCollection: { id: sourceId } } : {}) }) as Row;

function fixture(rows: Row[], publicIds: string[] = []) {
	const makeQuery = (arm: string) => {
		const builder = {
			arm, ids: null as string[] | null, clone: vi.fn(() => makeQuery(arm)),
			andWhere: vi.fn(function (this: { ids: string[] | null }, _sql: string, params?: Record<string, unknown>) { const ids = params?.listPublicIds ?? params?.listPrivateIds; if (ids) this.ids = ids as string[]; return this; }),
			limit: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(),
		};
		return builder;
	};
	const scan = { select: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
		innerJoin: vi.fn().mockReturnThis(), innerJoinAndMapOne: vi.fn().mockReturnThis(),
		getMany: vi.fn(async () => rows), getOne: vi.fn(async () => rows[0] ?? null), clone: vi.fn().mockReturnThis() };
	const authorizeRead = vi.fn(async () => ({ localUserId: 'oldViewer', initiator: false }));
	const read = vi.fn(async (query: ReturnType<typeof makeQuery>) => rows.filter(note => (!query.ids || query.ids.includes(note.id)) && (query.arm !== 'public' || publicIds.includes(note.id))));
	const publicBuild = vi.fn(async () => makeQuery('public'));
	const privateBuild = vi.fn(async () => makeQuery('private'));
	const peerNotes = vi.fn(async (input: PrivatePeerRequest) => ({ notes: rows.filter(note => input.ids?.includes(note.id)).map(note => ({ id: note.id, uri: `https://source.test/notes/${note.id}`, origin: 'https://source.test', text: note.id, files: [] })) }));
	const service = Object.assign(Object.create(GridspacePrivateService.prototype), {
		authorizeRead, listQuery: privateBuild, publicLists: { buildQuery: publicBuild }, peerNotes,
		db: { getRepository: () => ({ createQueryBuilder: () => scan, find: async () => [{ id: 'author' }] }) },
		peer: { origin: 'https://source.test', peerOrigin: 'https://reader.test' },
		ids: { parse: (id: string) => ({ date: new Date(Number(id.replace(/\D/g, '')) || 1) }), gen: (at: number) => String(at) },
		timelineReferences: { status: async () => ({ generation: 1 }), currentPosition: async () => '10', changes: async () => ({ events: [], cursor: '10', resetRequired: false }) },
		search: { read }, query: () => makeQuery('policy'), roles: { getUserPolicies: async () => ({ canSearchNotes: true }) },
	}) as GridspacePrivateService;
	return { service, scan, read, authorizeRead, publicBuild, privateBuild, peerNotes };
}

describe('peer list source scope and paging', () => {
	test('public profile without a private credential reads only its public arm', async () => {
		const { service, authorizeRead, privateBuild } = fixture([row('30'), row('20')], ['30']);
		const result = await service.peerListTimeline({ mode: 'profile', timelineViewerId: 'viewer', targetUris: ['https://source.test/users/author'] });
		expect(result.references.map(ref => [ref.noteId, ref.public])).toEqual([['30', true]]);
		expect(authorizeRead).not.toHaveBeenCalled(); expect(privateBuild).not.toHaveBeenCalled();
	});
	test('union applies public representation once while preserving a different private row', async () => {
		const { service } = fixture([row('30'), row('20')], ['30']);
		const result = await service.peerListTimeline({ mode: 'search', timelineViewerId: 'viewer', accessToken: 'token', query: 'query' });
		expect(result.references.map(ref => [ref.noteId, ref.public ?? false])).toEqual([['30', true], ['20', false]]);
	});
	test('channel guests cannot turn their credential into a direct-message scope', async () => {
		const { service, authorizeRead } = fixture([]);
		authorizeRead.mockRejectedValue(new GridspaceLinkError('AUTHORIZATION_REVOKED'));
		await expect(service.peerListTimeline({ mode: 'direct', channelActorId: 'guest' })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	});
	test('same-time favorites page by their save IDs without substituting note IDs', async () => {
		const { service, scan } = fixture([row('3', '30'), row('2', '20')]);
		await service.peerListTimeline({ mode: 'favorites', accessToken: 'token', timelineBefore: { noteId: '3', sourceId: '40', canonicalUri: 'https://source.test/notes/3', sortAt: '40000' } });
		expect(scan.andWhere).toHaveBeenCalledWith('collection.id < :listBefore', { listBefore: '40' });
	});
	test('oldest clip retains ascending order, snapshot ceiling, and forward cursor', async () => {
		const { service, scan } = fixture([row('10'), row('20')]);
		const result = await service.peerListTimeline({ mode: 'clip', clipId: 'clip', order: 'oldest', accessToken: 'token', timelineBefore: { noteId: '5', canonicalUri: 'https://source.test/notes/5', sortAt: '5000' }, timelineUpper: { noteId: '30', canonicalUri: 'https://source.test/notes/30', sortAt: '30000' } });
		expect(scan.andWhere).toHaveBeenCalledWith('candidate.id > :listBefore', { listBefore: '5' });
		expect(scan.andWhere).toHaveBeenCalledWith('candidate.id <= :listUpper', { listUpper: '30' });
		expect(scan.orderBy).toHaveBeenCalledWith('candidate.id', 'ASC');
		expect(result.references.map(ref => ref.noteId)).toEqual(['10', '20']);
	});
	test('favorite validation rejects an unfavorite/resave with a different save ID', async () => {
		const { service } = fixture([row('3', 'newSave')]);
		const result = await service.peerListTimeline({ mode: 'validate', contextMode: 'favorites', accessToken: 'token', ids: ['3'], timelineValidate: true,
			timelineCandidates: [{ noteId: '3', sourceId: 'oldSave', canonicalUri: 'https://source.test/notes/3', sortAt: '3000' }] });
		expect(result.references).toEqual([]); expect(result.notes).toEqual([]);
	});
	test('antenna scan includes only the current native antenna candidates', async () => {
		const { service, scan } = fixture([row('3')]);
		const get = vi.fn(async () => ['3']);
		Object.assign(service, { fanout: { get } });
		await service.peerListTimeline({ mode: 'antenna', antennaId: 'antenna', accessToken: 'token' });
		expect(get).toHaveBeenCalledWith('antennaTimeline:antenna');
		expect(scan.andWhere).toHaveBeenCalledWith('candidate.id IN (:...listAntenna)', { listAntenna: ['3'] });
	});
	test('a private read revoked during packing cannot return its captured body', async () => {
		const { service, peerNotes, authorizeRead } = fixture([row('3')]);
		peerNotes.mockImplementation(async () => { authorizeRead.mockRejectedValue(new GridspaceLinkError('AUTHORIZATION_REVOKED')); return { notes: [{ id: '3', uri: 'https://source.test/notes/3', origin: 'https://source.test', text: 'secret', files: [] }] }; });
		await expect(service.peerListTimeline({ mode: 'validate', contextMode: 'direct', accessToken: 'token', ids: ['3'], timelineValidate: true })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	});
	test('the change position precedes the scan so an insert during scanning remains replayable', async () => {
		const { service, scan } = fixture([row('3')]);
		let sequence = '10';
		Object.assign(service, { timelineReferences: { status: async () => ({ generation: 1 }), currentPosition: async () => sequence } });
		scan.getMany.mockImplementation(async () => { sequence = '11'; return [row('3')]; });
		const page = await service.peerListTimeline({ mode: 'direct', accessToken: 'token' });
		expect(page.sequence).toBe('10');
	});
	test('unrelated note changes do not force a profile reset', async () => {
		const { service } = fixture([row('3')], ['3']);
		Object.assign(service, { timelineReferences: { status: async () => ({ generation: 1 }), currentPosition: async () => '10', changes: async () => ({ events: [{ noteId: 'other', kind: 'update' }], cursor: '11', resetRequired: false }) } });
		const page = await service.peerListTimeline({ mode: 'validate', contextMode: 'profile', timelineViewerId: 'viewer', targetUris: ['https://source.test/users/author'], ids: ['3'], timelineValidate: true, timelineSequence: '10' });
		expect(page.changed).toBe(false); expect(page.sequence).toBe('11');
	});
	test('a retained note deleted after selection forces a reset even when no fresh row exists', async () => {
		const { service } = fixture([]);
		Object.assign(service, { timelineReferences: { status: async () => ({ generation: 1 }), currentPosition: async () => '10', changes: async () => ({ events: [{ noteId: 'deleted', kind: 'remove' }], cursor: '11', resetRequired: false }) } });
		const page = await service.peerListTimeline({ mode: 'validate', contextMode: 'direct', accessToken: 'token', ids: ['deleted'], timelineValidate: true, timelineSequence: '10' });
		expect(page.changed).toBe(true); expect(page.notes).toEqual([]);
	});
});
