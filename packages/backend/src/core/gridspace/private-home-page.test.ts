/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource, SelectQueryBuilder } from 'typeorm';
import type { MiNote } from '@/models/Note.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import type { PrivatePeerRequest } from './private-protocol.js';

const id = (n: number) => String(n).padStart(8, '0');
const input = { mode: 'home', limit: 2 } as PrivatePeerRequest;

function fixture(candidates: string[], visible: string[]) {
	const scan = mockDeep<SelectQueryBuilder<MiNote>>();
	for (const method of ['select', 'andWhere', 'orderBy', 'limit'] as const) scan[method].mockReturnValue(scan);
	scan.getRawMany.mockResolvedValue(candidates.map(id => ({ id })));
	const query = mockDeep<SelectQueryBuilder<MiNote>>();
	query.andWhere.mockReturnValue(query); query.take.mockReturnValue(query);
	const db = mockDeep<DataSource>();
	db.getRepository.mockReturnValue({ createQueryBuilder: () => scan } as never);
	const service = Object.assign(Object.create(GridspacePrivateService.prototype), {
		db, query: vi.fn(() => query), search: { read: vi.fn(async () => visible.map(id => ({ id }))) },
		ids: { parse: (value: string) => ({ date: new Date(Number(value)) }), gen: vi.fn((value: number) => id(value)) },
	}) as GridspacePrivateService;
	return { service, scan, query };
}

describe('bounded delegated home pages', () => {
	test('looks up a local anchor by primary key while retaining the caller visibility query', async () => {
		const { service, query } = fixture([], [id(20)]);
		Object.assign(service, { peer: { origin: 'https://source.example' } });
		query.clone.mockReturnValue(query); query.limit.mockReturnValue(query);
		const rows = await service['readTimelineAnchor'](query, `https://source.example/notes/${id(20)}`);
		expect(query.clone).toHaveBeenCalledOnce();
		expect(query.andWhere).toHaveBeenCalledWith('note.id = :timelineAnchorId', expect.objectContaining({ timelineAnchorId: id(20) }));
		expect(query.limit).toHaveBeenCalledWith(1);
		expect(service['search'].read).toHaveBeenCalledWith(query);
		expect(rows.map(row => row.id)).toEqual([id(20)]);
	});
	test('matches foreign anchors by URI and does not treat a foreign ID as a local primary key', async () => {
		const { service, query } = fixture([], []);
		Object.assign(service, { peer: { origin: 'https://source.example' } });
		query.clone.mockReturnValue(query); query.limit.mockReturnValue(query);
		const anchor = `https://other.example/notes/${id(20)}`;
		expect(await service['readTimelineAnchor'](query, anchor)).toEqual([]);
		expect(query.andWhere).toHaveBeenCalledWith('note.uri = :timelineAnchorUri', expect.objectContaining({ timelineAnchorUri: anchor }));
	});
	test('a primary-key anchor remains hidden when the visibility query returns no row', async () => {
		const { service, query } = fixture([], []);
		Object.assign(service, { peer: { origin: 'https://source.example' } });
		query.clone.mockReturnValue(query); query.limit.mockReturnValue(query);
		expect(await service['readTimelineAnchor'](query, `https://source.example/notes/${id(20)}`)).toEqual([]);
	});
	test('advances across a full window without readable notes instead of scanning the whole history', async () => {
		const candidates = Array.from({ length: 513 }, (_, n) => id(1000 - n));
		const { service, scan, query } = fixture(candidates, []);
		const page = await service['sourceHomePage']('viewer', input);
		expect(scan.limit).toHaveBeenCalledWith(513);
		expect(query.andWhere).toHaveBeenCalledWith('note.id IN (:...windowIds)', { windowIds: candidates.slice(0, 512) });
		expect(service['query']).toHaveBeenCalledWith('viewer', input);
		expect(page).toEqual({ rows: [], next: id(489), head: id(1000), scannedThrough: new Date(489).toISOString() });
	});

	test('a full visible page resumes after the last returned note, preserving its unread tail', async () => {
		const { service, query } = fixture([id(900), id(800), id(700), id(600)], [id(900), id(800), id(600)]);
		const page = await service['sourceHomePage']('viewer', input);
		expect(query.take).toHaveBeenCalledWith(3);
		expect(page.next).toBe(id(800));
		expect(page.scannedThrough).toBe(new Date(800).toISOString());
	});

	test('keeps the snapshot head and both date bounds while advancing the keyset', async () => {
		const { service, scan } = fixture([id(50)], [id(50)]);
		const page = await service['sourceHomePage']('viewer', { ...input, before: id(80), head: id(90), rangeStartAt: 10, rangeEndAt: 100 });
		expect(scan.andWhere.mock.calls).toEqual([
			['candidate.id < :before', { before: id(80) }], ['candidate.id <= :head', { head: id(90) }],
			['candidate.id > :start', { start: id(9) }], ['candidate.id < :end', { end: id(101) }],
		]);
		expect(page.next).toBeNull(); expect(page.head).toBe(id(90));
	});

	test('empty and final filtered windows end without a phantom continuation', async () => {
		for (const candidates of [[], [id(5)]]) {
			const { service } = fixture(candidates, []);
			const page = await service['sourceHomePage']('viewer', input);
			expect(page.next).toBeNull(); expect(page.rows).toEqual([]);
		}
	});

	test('an empty authorized result still exposes a usable next scan, without returning candidate IDs as notes', async () => {
		const { service } = fixture([], []);
		Object.assign(service, {
			authorizeRead: vi.fn(async () => ({ localUserId: 'viewer', initiator: false })),
			sourceHomePage: vi.fn(async () => ({ rows: [], next: id(10), head: id(30), scannedThrough: new Date(10).toISOString() })),
		});
		const page = await service.peerNotes(input);
		expect(page.notes).toEqual([]); expect(page.next).toBe(id(10)); expect(page.head).toBe(id(30));
		expect(page.scannedThrough).toBe(new Date(10).toISOString());
		expect(service['authorizeRead']).toHaveBeenCalledTimes(3);
	});

	test('the post-pack permission check removes a note, and revocation rejects the whole page', async () => {
		const { service } = fixture([], []);
		const note = { id: id(20), replyId: null, renoteId: null };
		const authorizeRead = vi.fn(async () => ({ localUserId: 'viewer', initiator: false }));
		Object.assign(service, {
			authorizeRead, sourceHomePage: vi.fn(async () => ({ rows: [note], next: null, head: note.id, scannedThrough: new Date(20).toISOString() })),
			extendedReactions: { show: async () => [{ noteId: note.id }] }, pack: vi.fn(async () => note),
		});
		expect((await service.peerNotes(input)).notes).toEqual([]);
		authorizeRead.mockRejectedValueOnce(new Error('revoked'));
		await expect(service.peerNotes(input)).rejects.toThrow('revoked');
	});
});
