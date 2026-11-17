/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Config } from '@/config.js';
import type { Packed } from '@/misc/json-schema.js';
import type { MiLocalUser } from '@/models/User.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { openGridspaceSecret } from '@/core/gridspace/link-crypto.js';
import { resolveGridspaceConfig } from '@/core/gridspace/peer-protocol.js';
import type { GridspacePrivateService } from '@/core/gridspace/GridspacePrivateService.js';
import { GridspaceTimelineService } from '@/core/gridspace/timeline/GridspaceTimelineService.js';
import type { TimelineSessionStore } from '@/core/gridspace/timeline/TimelineSessionStore.js';
import type { TimelineLocalSource } from '@/core/gridspace/timeline/TimelineLocalSource.js';
import type { TimelineReferenceService } from '@/core/gridspace/timeline/TimelineReferenceService.js';
import type { TimelineReference, TimelinePosition } from '@/core/gridspace/timeline/timeline-protocol.js';

const viewer = { id: 'viewer' } as MiLocalUser;
const options = { kind: 'home' } as const;
const ref = (source: 'local' | 'peer', id: string, time = Number(id), uri = `https://${source}.test/notes/${id}`): TimelineReference => ({ source, noteId: id, sortAt: String(time * 1000), canonicalUri: uri, generation: 1, normalized: true });
const body = (reference: TimelineReference) => ({ id: reference.noteId, uri: reference.canonicalUri, text: reference.noteId }) as Packed<'Note'>;

class MemorySessions {
	private readonly sessions = new Map<string, string>();
	private readonly pages = new Map<string, string>();
	private readonly results = new Map<string, string>();
	public async start(_viewer: string, session: string, json: string) { this.sessions.set(session, json); }
	public async getSession(session: string) { return this.sessions.get(session) ?? null; }
	public async putSession(session: string, json: string) { this.sessions.set(session, json); return json; }
	public async getCheckpoint(session: string, id: string) { return this.pages.get(`${session}:${id}`) ?? null; }
	public async putCheckpoint(session: string, id: string, json: string, _expires: number, onlyAbsent = false) {
		const key = `${session}:${id}`;
		if (!onlyAbsent || !this.pages.has(key)) this.pages.set(key, json);
	}
	public async claimResult(session: string, id: string, json: string) {
		const key = `${session}:${id}`;
		if (!this.results.has(key)) this.results.set(key, json);
		return this.results.get(key)!;
	}
	public state(session: string) { return JSON.parse(this.sessions.get(session)!); }
}

function fixture(localRows: TimelineReference[] = [], remoteRows: TimelineReference[] = []) {
	process.env.GRIDSPACE_TIMELINE_TEST_SECRET = Buffer.alloc(32, 1).toString('base64');
	const config = { url: 'https://local.test', gridspace: { enabled: true, communityId: 'test', keyId: 'test', peerUrl: 'https://peer.test', secretEnv: 'GRIDSPACE_TIMELINE_TEST_SECRET' } } as Config;
	const sessions = new MemorySessions();
	const data = { localRows, remoteRows, sequence: '0', events: [] as { sequence: string; noteId: string | null; canonicalUri: string | null; kind: string; affectedUserId: string | null }[], unavailable: false, visible: new Set(localRows.map(row => row.noteId)), privateLease: 10_000, localLease: null as number | null };
	const sourceRows = (rows: TimelineReference[], before?: TimelinePosition, upper?: TimelinePosition) => rows.filter(row => (!before?.noteId || row.noteId < before.noteId) && (!upper?.noteId || row.noteId <= upper.noteId));
	const local = {
		nextViewerPolicyCheck: vi.fn(async () => null),
		read: vi.fn(async (_viewer, _options, position) => sourceRows(data.localRows, position.before, position.upper).slice(0, position.limit)),
		readPage: vi.fn(async (_viewer, _options, position) => {
			const rows = sourceRows(data.localRows, position.before, position.upper);
			const selected = rows.slice(0, position.limit);
			return { references: selected, next: rows.length > selected.length ? selected.at(-1) : null, upper: position.upper ?? rows[0] ?? null, ended: rows.length <= selected.length };
		}),
		hydrate: vi.fn(async (_viewer, _options, rows: TimelineReference[]) => rows.filter(row => data.visible.has(row.noteId)).map(reference => ({ reference, payload: body(reference), validForMs: data.localLease, nextPolicyCheckAt: null }))),
		ownerReferences: vi.fn(async (_viewer, _options, uris: string[], upper?: TimelinePosition | null) => upper === null ? [] : data.localRows.filter(row => uris.includes(row.canonicalUri) && data.visible.has(row.noteId) && (!upper?.noteId || row.noteId <= upper.noteId))),
	};
	const references = {
		status: vi.fn(async () => ({ generation: 1 })),
		currentPosition: vi.fn(async () => data.sequence),
		changes: vi.fn(async (after: string) => ({ events: data.events.filter(event => BigInt(event.sequence) > BigInt(after)), cursor: data.sequence, resetRequired: false })),
		getMany: vi.fn(async (ids: string[]) => data.localRows.filter(row => ids.includes(row.noteId))),
	};
	const delegated = { timeline: vi.fn(async (_viewer, input) => {
		if (data.unavailable) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		const rows = sourceRows(data.remoteRows, input.before, input.upper);
		const selected = input.ids ? data.remoteRows.filter(row => input.ids.includes(row.noteId)) : rows;
		return { references: selected, notes: selected.map(reference => ({ ...body(reference), origin: 'https://peer.test' })), next: null, upper: input.upper ?? rows[0] ?? null, sequence: '0', changed: false, newReferences: [], validForMs: data.privateLease };
	}) };
	const service = new GridspaceTimelineService(config, sessions as unknown as TimelineSessionStore, local as unknown as TimelineLocalSource, references as unknown as TimelineReferenceService, delegated as unknown as GridspacePrivateService);
	const cursor = (value: string | null) => value == null ? null : JSON.parse(openGridspaceSecret(resolveGridspaceConfig(config.gridspace, config.url, process.env)!, value, `timeline-v1:${viewer.id}:unified:${JSON.stringify(options)}`));
	const change = (sequence: string, row: TimelineReference, kind = 'insert') => {
		data.sequence = sequence;
		data.events.push({ sequence, noteId: row.noteId, canonicalUri: row.canonicalUri, kind, affectedUserId: null });
	};
	return { service, data, sessions, local, delegated, change, cursor };
}

afterEach(() => { vi.restoreAllMocks(); delete process.env.GRIDSPACE_TIMELINE_TEST_SECRET; });

describe('unified timeline coordinator', () => {
	test('retries and concurrent requests keep the same selected page and next cursor', async () => {
		const { service, data, cursor } = fixture([ref('local', '003'), ref('local', '002'), ref('local', '001')]);
		const first = await service.page(viewer, options, 1);
		const [a, b] = await Promise.all([service.page(viewer, options, 1, first.nextCursor!), service.page(viewer, options, 1, first.nextCursor!)]);
		expect(a.items.map(item => item.key)).toEqual(['https://local.test/notes/002']);
		expect(b.items.map(item => item.key)).toEqual(a.items.map(item => item.key));
		expect(cursor(b.nextCursor)).toEqual(cursor(a.nextCursor));
		data.visible.delete('002');
		const revoked = await service.page(viewer, options, 1, first.nextCursor!);
		expect(revoked.items).toEqual([]);
		expect(cursor(revoked.nextCursor)).toEqual(cursor(a.nextCursor));
	});

	test('canonical local ownership deduplicates the peer while unrelated ID collisions remain', async () => {
		const own = ref('local', '003', 3, 'https://common.test/object');
		const { service } = fixture([own, ref('local', '002')], [ref('peer', '003', 10, own.canonicalUri), ref('peer', '002', 2)]);
		const page = await service.page(viewer, options, 10);
		expect(page.items.map(item => item.key)).toEqual([own.canonicalUri, 'https://local.test/notes/002', 'https://peer.test/notes/002']);
		expect(page.items.filter(item => item.key === own.canonicalUri)[0].representation).toBe('normal');
	});

	test('an unrelated committed event does not reset a retained window', async () => {
		const { service, data, change } = fixture([ref('local', '003')]);
		const first = await service.page(viewer, options, 10);
		const unrelated = ref('local', '001');
		data.localRows.push(unrelated);
		change('1', unrelated, 'update');
		const update = await service.changes(viewer, { session: first.session, revision: first.revision, updatesCursor: first.updatesCursor, refs: first.items.map(item => item.ref), phase: 'changes' });
		expect(update.resetRequired).toBe(false);
		expect(update.items.map(item => item.key)).toEqual(first.items.map(item => item.key));
	});

	test('new inserts advance the head and a late arrival requests anchored reset', async () => {
		const { service, data, sessions, change } = fixture([ref('local', '003')]);
		const first = await service.page(viewer, options, 10);
		const fresh = ref('local', '005');
		data.localRows.unshift(fresh); data.visible.add(fresh.noteId); change('1', fresh);
		const update = await service.changes(viewer, { session: first.session, revision: first.revision, updatesCursor: first.updatesCursor, refs: first.items.map(item => item.ref), phase: 'changes' });
		expect(update.newItems.map(item => item.key)).toEqual([fresh.canonicalUri]);
		expect(update.resetRequired).toBe(false);
		expect(sessions.state(first.session).windowHead.noteId).toBe('005');
		const late = ref('local', '004');
		data.localRows.push(late); data.visible.add(late.noteId); change('2', late);
		const after = await service.changes(viewer, { session: first.session, revision: first.revision, updatesCursor: update.updatesCursor, refs: [...first.items, ...update.newItems].map(item => item.ref), phase: 'changes' });
		expect(after.resetRequired).toBe(true);
		expect(after.newItems).toEqual([]);
	});

	test('a changed retained owner requests reset and hides its revoked body', async () => {
		const own = ref('local', '003', 3, 'https://common.test/object');
		const { service, data, change } = fixture([own], [ref('peer', 'peer003', 3, own.canonicalUri)]);
		const first = await service.page(viewer, options, 10);
		data.visible.delete(own.noteId); change('1', own, 'update');
		const update = await service.changes(viewer, { session: first.session, revision: first.revision, updatesCursor: first.updatesCursor, refs: first.items.map(item => item.ref), phase: 'changes' });
		expect(update.resetRequired).toBe(true);
		expect(update.items).toEqual([]);
		expect(update.removed).toContain(own.canonicalUri);
	});

	test('expired cursors and replay by a different viewer are rejected', async () => {
		const { service } = fixture([ref('local', '003'), ref('local', '002')]);
		const first = await service.page(viewer, options, 1);
		await expect(service.page({ id: 'other' } as MiLocalUser, options, 1, first.nextCursor!)).rejects.toThrow('INVALID_CURSOR');
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + 3600_001);
		await expect(service.page(viewer, options, 1, first.nextCursor!)).rejects.toThrow('INVALID_CURSOR');
	});

	test('expired delegated leases return no body and peer failure preserves a retryable checkpoint', async () => {
		const { service, data } = fixture([ref('local', '003')], [ref('peer', '004')]);
		data.privateLease = 0;
		const expired = await service.page(viewer, options, 10);
		expect(expired.items.map(item => item.representation)).toEqual(['normal']);
		data.unavailable = true;
		const failed = await service.page(viewer, options, 10);
		expect(failed.complete).toBe(false);
		expect(failed.sources.find(source => source.source === 'peer')?.status).toBe('unavailable');
		data.unavailable = false; data.privateLease = 10_000;
		const restored = await service.page(viewer, options, 10, failed.nextCursor!);
		expect(restored.complete).toBe(true);
		expect(restored.items.map(item => item.key)).toEqual(['https://peer.test/notes/004', 'https://local.test/notes/003']);
	});
});
