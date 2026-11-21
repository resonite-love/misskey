/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { DataSource, type QueryRunner } from 'typeorm';
import { mockDeep } from 'vitest-mock-extended';
import { loadConfig, type Config } from '@/config.js';
import type { MiLocalUser, MiRemoteUser } from '@/models/User.js';
import type { RoleService } from '@/core/RoleService.js';
import type { GridspacePrivateService } from '../GridspacePrivateService.js';
import type { GridspacePlacementService } from '../GridspacePlacementService.js';
import type { GridspaceNoteService } from '../GridspaceNoteService.js';
import type { TimelineLocalSource } from './TimelineLocalSource.js';
import { MiGridspaceTimelineChange, MiGridspaceTimelineState } from '@/models/GridspaceTimeline.js';
import { ChannelEntityService } from '@/core/entities/ChannelEntityService.js';
import { TimelineReferenceService } from './TimelineReferenceService.js';
import { refreshPlacementChannel, replacePlacementPins } from './placement-change.js';
import { TimelinePlacementSource } from './TimelinePlacementSource.js';
import type { TimelineReference } from './timeline-protocol.js';

const origin = 'https://index.example';
const other = 'https://other.example';
const viewer = { id: 'viewer' } as MiLocalUser;
const config: Config = { ...loadConfig(), url: origin, id: 'aidx', gridspace: { enabled: true, timelineEnabled: true,
	keyId: 'test', communityId: 'test', peerUrl: other, secretEnv: 'TEST_PLACEMENT_TIMELINE_KEY' } };
const secret = process.env.TEST_PLACEMENT_TIMELINE_KEY;
beforeAll(() => { process.env.TEST_PLACEMENT_TIMELINE_KEY = Buffer.alloc(32, 9).toString('base64'); });
afterAll(() => {
	if (secret === undefined) delete process.env.TEST_PLACEMENT_TIMELINE_KEY;
	else process.env.TEST_PLACEMENT_TIMELINE_KEY = secret;
});

function fixture(db: DataSource) {
	const local = mockDeep<TimelineLocalSource>();
	const shared = mockDeep<GridspaceNoteService>();
	const delegated = mockDeep<GridspacePrivateService>();
	const changes = mockDeep<TimelineReferenceService>(); changes.currentPosition.mockResolvedValue('0');
	const roles = mockDeep<RoleService>(); roles.isModerator.mockResolvedValue(false);
	const placements = mockDeep<GridspacePlacementService>();
	return { local, shared, delegated, placements, source: new TimelinePlacementSource(config, db, local, shared, delegated, changes, placements, roles) };
}

describe('listing authority and body authority', () => {
	test('existing home placements remain readable after disabling new writes', async () => {
		const { source, placements } = fixture(mockDeep<DataSource>());
		placements.peerEnabled.mockResolvedValue(false);
		placements.hasPeerCapability.mockResolvedValue(true);
		expect(await source.supportHome()).toBe(true);
		expect(placements.peerEnabled).not.toHaveBeenCalled();
	});
	test.each(['local', 'peer'] as const)('a %s index returns local originals without a peer callback', async index => {
		const { source, local, delegated } = fixture(mockDeep<DataSource>());
		const ref: TimelineReference = { source: index, noteId: 'original', canonicalUri: origin + '/notes/original', sortAt: '1', generation: 2, normalized: true,
			placement: { channelId: 'chan', channelOrigin: index === 'local' ? origin : other, noteOrigin: origin, includeDefault: false, legacy: false } };
		local.hydrateQuery.mockResolvedValue([{ reference: ref, payload: { id: 'original' }, validForMs: null, nextPolicyCheckAt: null }] as never);
		expect((await source.bodies(viewer, [ref], Date.now() + 1000)).get(ref.canonicalUri)?.representation).toBe('normal');
		expect(delegated.notes).not.toHaveBeenCalled();
	});

	test.each(['local', 'peer'] as const)('a %s index delegates a dedicated remote original exactly once', async index => {
		const { source, local, shared, delegated } = fixture(mockDeep<DataSource>());
		local.hydrateQuery.mockResolvedValue([]);
		const uri = other + '/notes/original';
		const ref: TimelineReference = { source: index, noteId: 'original', canonicalUri: uri, sortAt: '1', generation: 2, normalized: true,
			placement: { channelId: 'chan', channelOrigin: index === 'local' ? origin : other, noteOrigin: other, includeDefault: false, legacy: false } };
		delegated.notes.mockResolvedValue({ notes: [{ id: 'original', uri, origin: other }] } as never);
		expect((await source.bodies(viewer, [ref], Date.now() + 1000)).get(uri)?.representation).toBe('delegated');
		expect(delegated.notes).toHaveBeenCalledWith(viewer, { mode: 'show', noteId: 'original', conversationUri: uri }, 1);
		expect(shared.historyNotes).not.toHaveBeenCalled();
	});
});

test.each(['failure', 'unavailable', 'imported'] as const)('normal remote original uses the available representation after import %s', async mode => {
	const db = { getRepository: () => ({ createQueryBuilder: () => ({ select() { return this; }, where() { return this; }, getMany: async () => [] }) }) };
	const { source, local, shared, delegated } = fixture(db as unknown as DataSource);
	const uri = other + '/notes/n';
	const ref: TimelineReference = { source: 'local', noteId: 'n', canonicalUri: uri, sortAt: '1', generation: 2, normalized: true,
		placement: { channelId: 'c', channelOrigin: origin, noteOrigin: other, includeDefault: true, legacy: false } };
	if (mode === 'failure') shared.historyNotes.mockRejectedValue(new Error('import unavailable'));
	else shared.historyNotes.mockResolvedValue((mode === 'imported' ? new Map([['n', { id: 'mirror', uri }]]) : new Map()) as never);
	local.hydrateQuery.mockImplementation(async (_viewer, _query, refs) => refs.map(reference => ({ reference, payload: { id: reference.noteId, myReaction: 'local' }, validForMs: null, nextPolicyCheckAt: null })) as never);
	delegated.notes.mockResolvedValue({ notes: [{ id: 'n', uri, origin: other, myReaction: 'peer', channelPlacements: [
		{ channelId: 'originChannel', origin: other, canonicalUri: uri, state: 'active', name: 'Source channel', color: '#abc' },
	] }] } as never);
	const body = (await source.bodies(viewer, [ref], Date.now() + 5000)).get(uri);
	if (mode === 'imported') expect(body).toMatchObject({ representation: 'normal', payload: { id: 'mirror', myReaction: 'local', channelPlacements: [{ channelId: 'originChannel' }] } });
	else {
		expect(body).toMatchObject({ representation: 'delegated', readOnly: true, payload: { id: 'n' } });
		expect(body?.payload).not.toHaveProperty('myReaction');
	}
});

describe('channel placement index and legacy projections', () => {
	let db: DataSource;
	let runner: QueryRunner;
	let source: TimelinePlacementSource;
	beforeAll(async () => {
		db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, database: config.db.db, username: config.db.user, password: config.db.pass,
			entities: [MiGridspaceTimelineChange, MiGridspaceTimelineState] });
		await db.initialize();
		runner = db.createQueryRunner();
		await runner.startTransaction();
		const ddl = [
			'renote_muting ("muterId" text, "muteeId" text)',
			'channel (id text PRIMARY KEY, name text, color text, "isSensitive" boolean, "userId" text, "lastNotedAt" timestamptz, "notesCount" integer, "usersCount" integer, "pinnedNoteIds" varchar[], "isArchived" boolean DEFAULT false, "allowRenoteToExternal" boolean DEFAULT true)',
			'"user" (id text PRIMARY KEY, uri text)',
			'note (id text PRIMARY KEY, uri text, "channelId" text, "userId" text, "includeDefault" boolean, "multiNoteKind" text, "gridspaceShared" boolean, "userHost" text, visibility text, "fileIds" text[] DEFAULT ARRAY[]::text[])',
			'note_channel_placement ("canonicalUri" text, "sortAt" timestamptz, "noteId" text, "channelId" text, state text)',
			'gridspace_channel_placement ("canonicalUri" text, "sortAt" timestamptz, "originNoteId" text, "channelId" text, state text, "noteOrigin" text, "includeDefault" boolean, "authorUri" text, id uuid DEFAULT gen_random_uuid())',
			'gridspace_timeline_state (key text PRIMARY KEY, generation int DEFAULT 1, "nextSequence" bigint DEFAULT 0, "trimmedThrough" bigint DEFAULT 0)',
			'gridspace_timeline_change (sequence bigint PRIMARY KEY, kind text, "noteId" text, "channelId" text, "canonicalUri" text, "channelOrigin" text)',
			'channel_placement_pin ("channelId" text, "canonicalUri" text, rank integer, PRIMARY KEY ("channelId","canonicalUri"))',
			'channel_following ("followerId" text, "followeeId" text)',
			'channel_muting ("userId" text, "channelId" text, "expiresAt" timestamptz)',
			'blocking ("blockerId" text, "blockeeId" text)',
		];
		for (const table of ddl) await runner.query('CREATE TEMP TABLE ' + table + ' ON COMMIT DROP');
		await runner.query("INSERT INTO channel VALUES ('a','A','#fff',false,'owner',null,0,0,'{}'),('b','B','#fff',false,'owner',null,0,0,'{}')");
		await runner.query("INSERT INTO \"user\" VALUES ('viewer',null),('owner',null)");
		await runner.query("INSERT INTO note VALUES ('00000001',null,'a','owner',null,null,false)");
		await runner.query("INSERT INTO channel_following VALUES ('viewer','a'),('viewer','b')");
		for (const channel of ['a', 'b']) await runner.query(`INSERT INTO gridspace_channel_placement VALUES
			($1,'2026-01-01','remote',$2,'active',$3,false,$4)`, [other + '/notes/remote', channel, other, other + '/users/author']);
		source = fixture({ query: runner.query.bind(runner) } as unknown as DataSource).source;
	});
	afterAll(async () => {
		if (runner) { await runner.rollbackTransaction(); await runner.release(); }
		if (db?.isInitialized) await db.destroy();
	});
	test('filters dedicated local and delegated reference renotes using current home mutes and listing options', async () => {
		const localUri = origin + '/notes/plain';
		const peerUri = other + '/notes/plain';
		const reference = (uri: string, server: string): TimelineReference => ({
			noteId: 'plain', canonicalUri: uri, source: 'local', sortAt: '1', generation: 2, normalized: true,
			placement: { channelId: 'a', channelOrigin: origin, noteOrigin: server, includeDefault: false, legacy: false },
		});
		const refs = [reference(localUri, origin), reference(peerUri, other)];
		const f = fixture({ query: runner.query.bind(runner) } as unknown as DataSource);
		const fields = { id: 'plain', text: null as string | null, cw: null, files: [], poll: null, includeDefault: false, multiNoteKind: 'root',
			gridspaceQuote: origin + '/notes/target?gridspaceChannelOrigin=' + encodeURIComponent(other) + '&gridspaceChannelId=a' };
		f.local.hydrateQuery.mockImplementation(async () => [{ reference: refs[0], payload: { ...fields, userId: viewer.id }, validForMs: null, nextPolicyCheckAt: null }] as never);
		f.delegated.notes.mockImplementation(async () => ({ notes: [{ ...fields, origin: other, uri: peerUri, author: { uri: other + '/users/renoter' } }] }) as never);
		const read = async (options = {}) => [...(await f.source.bodies(viewer, refs, Date.now() + 5000, options)).keys()];
		expect(await read()).toEqual([localUri, peerUri]);
		expect(await read({ withRenotes: false })).toEqual([]);
		expect(await read({ includeMyRenotes: false })).toEqual([peerUri]);
		await runner.query('INSERT INTO "user" VALUES ($1, $2)', ['cachedRenoter', other + '/users/renoter']);
		await runner.query('INSERT INTO renote_muting VALUES ($1,$2)', [viewer.id, 'cachedRenoter']);
		expect(await read()).toEqual([localUri]);
		fields.text = 'A comment';
		expect(await read({ withRenotes: false })).toEqual([localUri, peerUri]);
	});
	test('page boundaries use original time and canonical URI across legacy and remote rows', async () => {
		const first = await source.read(viewer, origin, { channelId: 'a', limit: 1 }, Date.now() + 1000);
		expect(first.references.map(ref => ref.noteId)).toEqual(['remote']);
		const second = await source.read(viewer, origin, { channelId: 'a', limit: 1, before: first.next! }, Date.now() + 1000);
		expect(second.references.map(ref => ref.noteId)).toEqual(['00000001']);
		expect(second.next).toBeNull();
	});
	test('one URI retains all followed routes and a mute removes only its own route', async () => {
		const read = async () => (await source.read(viewer, origin, { followed: true }, Date.now() + 1000)).references;
		expect((await read()).map(ref => ref.placement!.channelIds)).toEqual([['a', 'b']]);
		await runner.query("INSERT INTO channel_muting VALUES ('viewer','a',NULL)");
		expect((await read()).map(ref => ref.placement!.channelIds)).toEqual([['b']]);
	});
	test('local and peer readers can open and follow a sensitive channel with the same mute and block rules', async () => {
		const channelId = 'sensitive';
		const uri = other + '/notes/sensitive';
		await runner.query("INSERT INTO channel VALUES ($1, 'Sensitive', '#aaa', true, 'sensitiveOwner', NULL, 0, 0, '{}')", [channelId]);
		await runner.query("INSERT INTO gridspace_channel_placement VALUES ($1, '2026-01-01', 'sensitive', $2, 'active', $3, false, $4)",
			[uri, channelId, other, other + '/users/author']);
		await runner.query('INSERT INTO channel_following VALUES ($1, $2)', [viewer.id, channelId]);
		const { source: index, placements } = fixture({ query: runner.query.bind(runner) } as unknown as DataSource);
		placements.resolveActor.mockResolvedValue(mockDeep<MiRemoteUser>({ id: viewer.id }));
		await runner.query('INSERT INTO channel_placement_pin VALUES ($1, $2, 0)', [channelId, uri]);
		const read = async (followed: boolean, pinnedOnly = false) => {
			const input = { ...(followed ? { followed: true } : { channelId }), uris: [uri], pinnedOnly };
			const local = await index.read(viewer, origin, input, Date.now() + 1000);
			const peer = await index.peerPage({ ...input, actorId: 'peerViewer' });
			expect(peer.references).toEqual(local.references);
			return peer.references;
		};
		expect(await read(false)).toMatchObject([{ canonicalUri: uri, placement: { chips: [{ name: 'Sensitive', isArchived: false, isSensitive: true, allowRenoteToExternal: true }] } }]);
		expect(await read(false, true)).toHaveLength(1);
		expect(await read(true)).toHaveLength(1);
		await runner.query('INSERT INTO channel_muting VALUES ($1, $2, NULL)', [viewer.id, channelId]);
		expect(await read(true)).toEqual([]);
		await runner.query('INSERT INTO blocking VALUES ($1, $2)', ['sensitiveOwner', viewer.id]);
		expect(await read(false)).toEqual([]);
		expect(await read(false, true)).toEqual([]);
		await runner.query('DELETE FROM channel_placement_pin WHERE "channelId" = $1', [channelId]);
	});
	test('a delayed verified mirror populates legacy pins and a stale ID-only edit preserves the canonical pin', async () => {
		const channelId = 'late';
		const uri = other + '/notes/later';
		await runner.query("INSERT INTO channel VALUES ($1,'Later','#aaa',false,'owner',NULL,0,0,'{}')", [channelId]);
		await runner.query("INSERT INTO gridspace_channel_placement VALUES ($1,'2026-01-02','later',$2,'active',$3,true,$4)", [uri, channelId, other, other + '/users/author']);
		await replacePlacementPins(runner.manager, channelId, origin, 'aidx', { uris: [uri] });
		const service = new TimelineReferenceService({ transaction: runner.manager.transaction.bind(runner.manager) } as never, config, {} as never,
			{ publishPlacedChannelMirror: vi.fn() } as never, undefined, undefined, {} as never, { enableFanoutTimeline: false } as never);
		const pack = async () => {
			const [channel] = await runner.query('SELECT * FROM channel WHERE id = $1', [channelId]);
			const notes = await runner.query('SELECT * FROM note WHERE id = ANY($1::varchar[])', [channel.pinnedNoteIds]);
			const entity = Object.create(ChannelEntityService.prototype) as ChannelEntityService;
			Object.assign(entity, {
				channelsRepository: { manager: { getRepository: () => ({ find: () => runner.query('SELECT * FROM channel_placement_pin WHERE "channelId" = $1 ORDER BY rank', [channelId]) }) } },
				idService: { parse: () => ({ date: new Date(0) }) },
				config, notesRepository: { findBy: async () => notes }, noteEntityService: { packMany: async () => notes },
			});
			return entity.pack(channel, null, true);
		};
		expect((await pack()).pinnedNoteIds).toEqual([]);
		await runner.query(`INSERT INTO note (id, uri, "userHost", visibility, "gridspaceShared") VALUES ('mirror',$1,'other.example','public',false)`, [uri]);
		await runner.query("INSERT INTO gridspace_timeline_change VALUES (1,'insert','mirror',NULL,$1,NULL)", [uri]);
		await service.projectPlacedMirrors();
		expect((await pack()).pinnedNotes).toEqual([]);
		await runner.query(`UPDATE note SET "gridspaceShared" = true WHERE id='mirror'`);
		await runner.query("INSERT INTO gridspace_timeline_change VALUES (2,'mirror-ready','mirror',NULL,$1,NULL)", [uri]);
		await service.projectPlacedMirrors();
		const projected = await pack();
		expect(projected.pinnedNoteIds).toEqual(['mirror']);
		expect(projected.pinnedNotes?.map(note => note.id)).toEqual(['mirror']);
		await replacePlacementPins(runner.manager, channelId, origin, 'aidx', { ids: [] });
		expect((await pack()).pinnedNoteIds).toEqual(['mirror']);
		await replacePlacementPins(runner.manager, channelId, origin, 'aidx', { uris: [] });
		expect((await pack()).pinnedNoteIds).toEqual([]);
	});
	test('a legacy editor preserves a dedicated remote pin and its URI is counted once', async () => {
		const uri = other + '/notes/remote';
		await replacePlacementPins(runner.manager, 'a', origin, 'aidx', { uris: [origin + '/notes/00000001', uri] });
		const firstPin = await source.read(viewer, origin, { channelId: 'a', pinnedOnly: true, limit: 1 }, Date.now() + 1000);
		expect(firstPin.references.map(ref => ref.noteId)).toEqual(['00000001']);
		const secondPin = await source.read(viewer, origin, { channelId: 'a', pinnedOnly: true, before: firstPin.next!, limit: 1 }, Date.now() + 1000);
		expect(secondPin.references.map(ref => ref.noteId)).toEqual(['remote']);
		await replacePlacementPins(runner.manager, 'a', origin, 'aidx', { ids: [] });
		expect(await runner.query('SELECT "canonicalUri" FROM channel_placement_pin')).toEqual([{ canonicalUri: uri }]);
		const [channel] = await runner.query("SELECT * FROM channel WHERE id='a'");
		expect(channel).toMatchObject({ notesCount: 2, usersCount: 2, pinnedNoteIds: [] });
		await runner.query("UPDATE gridspace_channel_placement SET state='removed' WHERE \"channelId\"='a'");
		await refreshPlacementChannel(runner.manager, 'a', origin, 'aidx');
		expect(await runner.query('SELECT "canonicalUri" FROM channel_placement_pin')).toEqual([]);
		expect((await runner.query("SELECT * FROM channel WHERE id='a'"))[0].notesCount).toBe(1);
	});
});
