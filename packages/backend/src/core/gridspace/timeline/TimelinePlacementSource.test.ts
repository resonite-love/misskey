/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { DataSource, type QueryRunner } from 'typeorm';
import { mockDeep } from 'vitest-mock-extended';
import Fastify from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { loadConfig, type Config } from '@/config.js';
import { registerGridspacePeer } from '@/server/gridspace/peer-server.js';
import type { MiLocalUser, MiRemoteUser } from '@/models/User.js';
import type { NotePlacementService } from '@/core/NotePlacementService.js';
import type { RoleService } from '@/core/RoleService.js';
import { MiGridspaceTimelineChange, MiGridspaceTimelineState } from '@/models/GridspaceTimeline.js';
import { ChannelEntityService } from '@/core/entities/ChannelEntityService.js';
import * as peerClient from '../peer-client.js';
import { createGridspaceHeaders, resolveGridspaceConfig } from '../peer-protocol.js';
import { GridspaceLinkError, type GridspaceLinkService } from '../GridspaceLinkService.js';
import { TimelineReferenceService } from './TimelineReferenceService.js';
import { refreshPlacementChannel, replacePlacementPins } from './placement-change.js';
import { TimelinePlacementSource } from './TimelinePlacementSource.js';
import type { GridspaceChannelAuthService } from '../GridspaceChannelAuthService.js';
import type { GridspaceSearchService } from '../GridspaceSearchService.js';
import type { GridspacePrivateService } from '../GridspacePrivateService.js';
import type { GridspacePlacementService } from '../GridspacePlacementService.js';
import type { GridspaceNoteService } from '../GridspaceNoteService.js';
import type { TimelineLocalSource } from './TimelineLocalSource.js';
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
	const channelAuth = mockDeep<GridspaceChannelAuthService>();
	const links = mockDeep<GridspaceLinkService>();
	const notePlacements = mockDeep<NotePlacementService>();
	const search = mockDeep<GridspaceSearchService>();
	return { local, shared, delegated, placements, changes, links, channelAuth, search, notePlacements, source: new TimelinePlacementSource(config, db, local, shared, delegated, changes, placements, roles, channelAuth, links, notePlacements, search) };
}

describe('listing authority and body authority', () => {
	test.each([{ count: 30, revoked: false }, { count: 50, revoked: false }, { count: 100, revoked: false }, { count: 50, revoked: true }])(
		'loads $count legacy channel notes through the signed peer API; revoked=$revoked', async ({ count, revoked }) => {
			const { source, local, delegated } = fixture(mockDeep<DataSource>());
			local.hydrateQuery.mockResolvedValue([]);
			const caller = resolveGridspaceConfig(config.gridspace, origin, process.env)!;
			const receiver = resolveGridspaceConfig({ ...config.gridspace!, peerUrl: origin }, other, process.env)!;
			const app = Fastify();
			await app.register(fastifyRawBody, { global: false, encoding: null, runFirst: true });
			await app.register(async child => {
				registerGridspacePeer(child, receiver, async () => true, undefined, undefined, undefined, undefined, async (_name, request) => {
					if (revoked) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
					return { notes: request.ids!.map(id => ({ id, origin: other, uri: `${other}/notes/${id}` })) };
				});
			}, { prefix: '/gridspace/v1' });
			delegated.notes.mockImplementation(async (_viewer, options, limit) => {
				const url = '/gridspace/v1/private/notes';
				const payload = Buffer.from(JSON.stringify({ ...options, limit, channelActorId: viewer.id }));
				const response = await app.inject({ method: 'POST', url, payload, headers: createGridspaceHeaders(caller, 'POST', url, payload) });
				if (response.statusCode !== 200) throw new GridspaceLinkError(response.json().error === 'AUTHORIZATION_REVOKED' ? 'AUTHORIZATION_REVOKED' : 'PEER_UNAVAILABLE');
				return response.json();
			});
			const refs = Array.from({ length: count }, (_, index): TimelineReference => ({
				source: 'peer', noteId: `note${index}`, canonicalUri: `${other}/notes/note${index}`, sortAt: String(count - index), generation: 2, normalized: true,
				placement: { channelId: 'channel', channelOrigin: other, noteOrigin: other, includeDefault: false, legacy: true },
			}));
			try {
				const result = await source.bodies(viewer, refs, Date.now() + 5000);
				expect([...result.keys()].sort()).toEqual(revoked ? [] : refs.map(ref => ref.canonicalUri).sort());
				expect(delegated.notes).toHaveBeenCalledTimes(Math.ceil(count / 20));
			} finally { await app.close(); }
		},
	);

	test.each([false, true])('batches only legacy notes in the same channel; revoked batch=%s', async revoked => {
		const { source, local, delegated } = fixture(mockDeep<DataSource>());
		local.hydrateQuery.mockResolvedValue([]);
		const refs = ['a1', 'a2', 'b1', 'modern'].map((id): TimelineReference => ({ source: 'peer', noteId: id,
																																																																														canonicalUri: `${other}/notes/${id}`, sortAt: '1', generation: 2, normalized: true,
																																																																														placement: { channelId: id === 'b1' ? 'b' : 'a', channelOrigin: other, noteOrigin: other, includeDefault: false, legacy: id !== 'modern' },
		}));
		delegated.notes.mockImplementation(async (_viewer, options) => {
			if (options.channelId === 'a' && revoked) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			// A deleted/unreadable member is omitted by the source; another member remains readable.
			const ids = options.ids?.filter(id => id !== 'a2') ?? [options.noteId!];
			return { notes: ids.map(id => ({ id, origin: other, uri: `${other}/notes/${id}` })) } as never;
		});
		const result = await source.bodies(viewer, refs, Date.now() + 5000);
		expect([...result.keys()].sort()).toEqual((revoked ? ['b1', 'modern'] : ['a1', 'b1', 'modern']).map(id => `${other}/notes/${id}`).sort());
		expect(delegated.notes).toHaveBeenCalledTimes(3);
		expect(delegated.notes).toHaveBeenCalledWith(viewer, { mode: 'validate', contextMode: 'channel', channelId: 'a', ids: ['a1', 'a2'] }, 2);
		expect(delegated.notes).toHaveBeenCalledWith(viewer, { mode: 'validate', contextMode: 'channel', channelId: 'b', ids: ['b1'] }, 1);
		expect(delegated.notes).toHaveBeenCalledWith(viewer, { mode: 'show', noteId: 'modern', conversationUri: `${other}/notes/modern` }, 1);
	});

	test('existing home placements remain readable after disabling new writes', async () => {
		const { source, placements } = fixture(mockDeep<DataSource>());
		placements.peerEnabled.mockResolvedValue(false);
		placements.hasPeerCapability.mockResolvedValue(true);
		expect(await source.supportHome()).toBe(true);
		expect(placements.peerEnabled).not.toHaveBeenCalled();
	});
	test('binds followed-channel grants to the current caller, source role and read purpose', async () => {
		const f = fixture(mockDeep<DataSource>());
		const followedLink = { localUserId: 'caller', accessToken: 'test-token', linkId: 'link', generation: 1 };
		f.placements.resolveActor.mockResolvedValue({ id: 'remoteCaller' } as MiRemoteUser);
		const input = { actorId: 'caller', followed: true, followedLink };
		await expect(f.source.peerPage({ ...input, actorId: 'different' })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		await expect(f.source.peerPage({ ...input, followed: false, channelId: 'a' })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		f.channelAuth.assertSource.mockImplementationOnce(() => { throw new GridspaceLinkError('AUTHORIZATION_REVOKED'); });
		await expect(f.source.peerPage(input)).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		expect(f.links.authorizePrivate).not.toHaveBeenCalled();
		for (const link of [{ initiator: true, peerUserId: 'caller' }, { initiator: false, peerUserId: 'different' }]) {
			f.links.authorizePrivate.mockResolvedValueOnce(link as never);
			await expect(f.source.peerPage(input)).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
		}
		f.links.authorizePrivate.mockRejectedValueOnce(new GridspaceLinkError('AUTHORIZATION_REVOKED'));
		await expect(f.source.peerPage(input)).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	});

	test('rechecks the linked channel context after the peer read and negotiates older peers', async () => {
		const f = fixture(mockDeep<DataSource>());
		Object.defineProperty(f.channelAuth, 'isClient', { value: true });
		f.placements.currentActorCredential.mockResolvedValue({ actorId: viewer.id });
		const credential = { accessToken: 'test-token', localUserId: viewer.id, linkId: 'link', generation: 1 };
		const check = vi.fn(async () => { throw new GridspaceLinkError('AUTHORIZATION_REVOKED'); });
		f.channelAuth.destination.mockResolvedValue({ credential, check } as never);
		const request = vi.spyOn(peerClient, 'requestGridspacePeer').mockResolvedValue({ references: [], sequence: '1' });
		try {
			const read = () => f.source.read(viewer, other, { followed: true }, Date.now() + 1000);
			f.placements.supportsLinkedChannelFollows.mockResolvedValueOnce(false);
			await read();
			expect(f.channelAuth.destination).not.toHaveBeenCalled();
			f.placements.supportsLinkedChannelFollows.mockResolvedValue(true);
			await expect(read()).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
			expect(request.mock.lastCall?.[2]).toEqual({ followed: true, followedLink: credential, actorId: viewer.id });
			expect(check).toHaveBeenCalledOnce();
			f.channelAuth.destination.mockRejectedValueOnce(new GridspaceLinkError('AUTHORIZATION_REVOKED'));
			await read();
			expect(request.mock.lastCall?.[2]).toEqual({ followed: true, actorId: viewer.id, followedLink: undefined });
		} finally {
			request.mockRestore();
		}
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
			'note (id text PRIMARY KEY, uri text, "channelId" text, "userId" text, "includeDefault" boolean, "multiNoteKind" text, "gridspaceShared" boolean, "userHost" text, visibility text, "fileIds" text[] DEFAULT ARRAY[]::text[], "threadId" text, "multiNoteRootId" text)',
			'note_channel_placement ("canonicalUri" text, "sortAt" timestamptz, "noteId" text, "channelId" text, state text)',
			'gridspace_placement_target ("noteId" text, "channelId" text, "peerOrigin" text, state text)',
			'gridspace_channel_placement ("canonicalUri" text, "sortAt" timestamptz, "originNoteId" text, "channelId" text, state text, "noteOrigin" text, "includeDefault" boolean, "authorUri" text, id uuid DEFAULT gen_random_uuid())',
			'gridspace_timeline_state (key text PRIMARY KEY, generation int DEFAULT 1, "nextSequence" bigint DEFAULT 0, "trimmedThrough" bigint DEFAULT 0)',
			'gridspace_timeline_change (sequence bigint PRIMARY KEY, kind text, "noteId" text, "channelId" text, "canonicalUri" text, "channelOrigin" text)',
			'channel_placement_pin ("channelId" text, "canonicalUri" text, rank integer, PRIMARY KEY ("channelId","canonicalUri"))',
			'channel_following ("followerId" text, "followeeId" text)',
			'channel_muting ("userId" text, "channelId" text, "expiresAt" timestamptz)',
			'blocking ("blockerId" text, "blockeeId" text)',
		];
		for (const table of ddl) await runner.query('CREATE TEMP TABLE ' + table + ' ON COMMIT DROP');
		await runner.query('INSERT INTO channel VALUES (\'a\',\'A\',\'#fff\',false,\'owner\',null,0,0,\'{}\'),(\'b\',\'B\',\'#fff\',false,\'owner\',null,0,0,\'{}\')');
		await runner.query('INSERT INTO "user" VALUES (\'viewer\',null),(\'owner\',null)');
		await runner.query('INSERT INTO note VALUES (\'00000001\',null,\'a\',\'owner\',null,null,false)');
		await runner.query('INSERT INTO channel_following VALUES (\'viewer\',\'a\'),(\'viewer\',\'b\')');
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
	test('lists historical dedicated descendants by child time in both explicit channel lanes and rechecks each active route', async () => {
		const rootId = '00010000';
		const children = ['00010001', '00010002'];
		const channelId = 'replyChannel';
		await runner.query('INSERT INTO channel VALUES ($1, \'Replies\', \'#fff\', false, \'owner\', NULL, 0, 0, \'{}\')', [channelId]);
		await runner.query('INSERT INTO note (id, "userId", "includeDefault", "multiNoteKind") VALUES ($1, $2, false, $3)', [rootId, 'owner', 'root']);
		for (const id of children) await runner.query('INSERT INTO note (id, "userId", "includeDefault", "multiNoteKind", "threadId", "multiNoteRootId") VALUES ($1, $2, false, $3, $4, $4)', [id, 'viewer', 'conversation-reply', rootId]);
		await runner.query('INSERT INTO note_channel_placement VALUES ($1, \'1999-01-01\', $2, $3, \'active\')', [origin + '/notes/' + rootId, rootId, channelId]);
		await runner.query('INSERT INTO gridspace_placement_target VALUES ($1,$2,$3,\'active\')', [rootId, channelId, other]);
		const f = fixture({ query: runner.query.bind(runner) } as unknown as DataSource);
		f.placements.supportsChannelReplies.mockResolvedValue(true);
		const visible = new Set([rootId, ...children]);
		const builder = { select() { return this; }, andWhere() { return this; }, getRawMany: async () => [...visible].map(id => ({ id })) };
		f.search.noteQuery.mockReturnValue(builder as never);
		let active = true;
		f.notePlacements.pack.mockImplementation(async () => new Map([[rootId, active ? [origin, other].map(site => ({
			origin: site, channelId, canonicalUri: site + '/notes/' + rootId, name: 'Replies', color: '#fff', state: 'active' as const, canRemove: true,
		})) : []]]));
		for (const listing of [origin, other]) {
			const params = { channelId, ...(listing === other ? { replyChannelOrigin: other } : {}) };
			const read = (options = {}) => f.source.read(viewer, origin, { ...params, ...options }, Date.now() + 5000);
			const page = await read({ limit: 1 });
			expect(page.references.map(ref => ref.noteId)).toEqual([children[1]]);
			expect(page.references[0].placement!.chips).toMatchObject([{ canonicalUri: origin + '/notes/' + children[1], origin: listing, canRemove: false }]);
			expect((await read({ before: page.next, limit: 1 })).references.map(ref => ref.noteId)).toEqual([children[0]]);
			expect(await f.source.changedReplies(listing, channelId, [children[1]], viewer.id)).toBe(true);
			visible.delete(children[1]);
			expect((await read({ uris: [origin + '/notes/' + children[1]] })).references).toEqual([]);
			visible.add(children[1]);
			visible.delete(rootId);
			expect((await read({ uris: [origin + '/notes/' + children[1]] })).references).toEqual([]);
			visible.add(rootId);
			f.changes.changes.mockResolvedValueOnce({ cursor: '2', resetRequired: false, hasMore: false,
																																													events: [{ kind: 'insert', noteId: children[1] }] } as never);
			expect((await read({ uris: [], after: '1' })).changed).toBe(true);
			active = false;
			expect((await read({ uris: [origin + '/notes/' + children[1]] })).references).toEqual([]);
			active = true;
		}
		await runner.query('INSERT INTO channel_following VALUES ($1, $2)', [viewer.id, channelId]);
		const retained = children.map(id => origin + '/notes/' + id);
		expect((await f.source.read(viewer, origin, { followed: true, uris: retained }, Date.now() + 5000)).references).toEqual([]);
		await runner.query('UPDATE note_channel_placement SET state = $1 WHERE "channelId" = $2', ['removed', channelId]);
		await runner.query('UPDATE gridspace_placement_target SET state = $1 WHERE "channelId" = $2', ['removed', channelId]);
		expect((await f.source.read(viewer, origin, { channelId, uris: retained }, Date.now() + 5000)).references).toEqual([]);
		expect((await f.source.read(viewer, origin, { channelId, replyChannelOrigin: other, uris: retained }, Date.now() + 5000)).references).toEqual([]);
		expect((await f.source.read(viewer, origin, { channelId, pinnedOnly: true }, Date.now() + 5000)).references).toEqual([]);
	});
	test('one URI retains all followed routes and a mute removes only its own route', async () => {
		const read = async () => (await source.read(viewer, origin, { followed: true }, Date.now() + 1000)).references;
		expect((await read()).map(ref => ref.placement!.channelIds)).toEqual([['a', 'b']]);
		await runner.query('INSERT INTO channel_muting VALUES (\'viewer\',\'a\',NULL)');
		expect((await read()).map(ref => ref.placement!.channelIds)).toEqual([['b']]);
	});
	test('a linked follow selects a dedicated root while retaining the guest ACL and both channel policies', async () => {
		const channel = 'linkedOnly';
		const uri = other + '/notes/linkedOriginal';
		const f = fixture({ query: runner.query.bind(runner) } as unknown as DataSource);
		const followedLink = { localUserId: 'caller', accessToken: 'test-token', linkId: 'link', generation: 1 };
		const input = { actorId: 'caller', followed: true, uris: [uri] };
		const link = { localUserId: 'linkedOwner', peerUserId: 'caller', initiator: false };
		f.placements.resolveActor.mockResolvedValue({ id: 'guest' } as MiRemoteUser);
		f.links.authorizePrivate.mockResolvedValue(link as never);
		await runner.query('INSERT INTO channel VALUES ($1, \'Linked\', \'#aaa\', false, \'linkedOwner\', NULL, 0, 0, \'{}\')', [channel]);
		await runner.query('INSERT INTO gridspace_channel_placement VALUES ($1, \'2026-01-01\', \'linkedOriginal\', $2, \'active\', $3, false, $4)',
			[uri, channel, other, other + '/users/anotherAuthor']);
		await runner.query('INSERT INTO channel_following VALUES (\'linkedOwner\', $1)', [channel]);
		const read = async () => (await f.source.peerPage({ ...input, followedLink })).references;
		expect((await f.source.peerPage(input)).references).toEqual([]);
		expect(await read()).toMatchObject([{ canonicalUri: uri, placement: { chips: [{ canRemove: false }] } }]);
		for (const id of ['guest', 'linkedOwner', 'unrelated']) {
			f.changes.changes.mockResolvedValueOnce({ events: [{ kind: 'policy', affectedUserId: id }], cursor: '1', resetRequired: false, hasMore: false } as never);
			const after = await f.source.peerPage({ ...input, followedLink, uris: [], after: '0' });
			expect(after.changed).toBe(id !== 'unrelated');
		}
		await runner.query('UPDATE gridspace_channel_placement SET "authorUri" = $1 WHERE "canonicalUri" = $2', [other + '/users/caller', uri]);
		await runner.query('INSERT INTO "user" VALUES ($1, $2)', ['guest', other + '/users/caller']);
		expect(await read()).toMatchObject([{ canonicalUri: uri, placement: { chips: [{ canRemove: true }] } }]);
		await runner.query('UPDATE channel_following SET "followerId" = $1 WHERE "followeeId" = $2', ['guest', channel]);
		expect(await read()).toHaveLength(1);
		for (const id of ['guest', 'linkedOwner']) {
			await runner.query('INSERT INTO channel_muting VALUES ($1, $2, NULL)', [id, channel]);
			expect(await read()).toEqual([]);
			await runner.query('DELETE FROM channel_muting WHERE "userId" = $1 AND "channelId" = $2', [id, channel]);
		}
		await runner.query('UPDATE channel SET "userId" = \'otherOwner\' WHERE id = $1', [channel]);
		for (const id of ['guest', 'linkedOwner']) {
			await runner.query('INSERT INTO blocking VALUES (\'otherOwner\', $1)', [id]);
			expect(await read()).toEqual([]);
			await runner.query('DELETE FROM blocking WHERE "blockeeId" = $1', [id]);
		}
		f.links.authorizePrivate.mockResolvedValueOnce(link as never).mockRejectedValueOnce(new GridspaceLinkError('AUTHORIZATION_REVOKED'));
		await expect(read()).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
	});
	test('local and peer readers can open and follow a sensitive channel with the same mute and block rules', async () => {
		const channelId = 'sensitive';
		const uri = other + '/notes/sensitive';
		await runner.query('INSERT INTO channel VALUES ($1, \'Sensitive\', \'#aaa\', true, \'sensitiveOwner\', NULL, 0, 0, \'{}\')', [channelId]);
		await runner.query('INSERT INTO gridspace_channel_placement VALUES ($1, \'2026-01-01\', \'sensitive\', $2, \'active\', $3, false, $4)',
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
		await runner.query('INSERT INTO channel VALUES ($1,\'Later\',\'#aaa\',false,\'owner\',NULL,0,0,\'{}\')', [channelId]);
		await runner.query('INSERT INTO gridspace_channel_placement VALUES ($1,\'2026-01-02\',\'later\',$2,\'active\',$3,true,$4)', [uri, channelId, other, other + '/users/author']);
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
		await runner.query('INSERT INTO note (id, uri, "userHost", visibility, "gridspaceShared") VALUES (\'mirror\',$1,\'other.example\',\'public\',false)', [uri]);
		await runner.query('INSERT INTO gridspace_timeline_change VALUES (1,\'insert\',\'mirror\',NULL,$1,NULL)', [uri]);
		await service.projectPlacedMirrors();
		expect((await pack()).pinnedNotes).toEqual([]);
		await runner.query('UPDATE note SET "gridspaceShared" = true WHERE id=\'mirror\'');
		await runner.query('INSERT INTO gridspace_timeline_change VALUES (2,\'mirror-ready\',\'mirror\',NULL,$1,NULL)', [uri]);
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
		const [channel] = await runner.query('SELECT * FROM channel WHERE id=\'a\'');
		expect(channel).toMatchObject({ notesCount: 2, usersCount: 2, pinnedNoteIds: [] });
		await runner.query('UPDATE gridspace_channel_placement SET state=\'removed\' WHERE "channelId"=\'a\'');
		await refreshPlacementChannel(runner.manager, 'a', origin, 'aidx');
		expect(await runner.query('SELECT "canonicalUri" FROM channel_placement_pin')).toEqual([]);
		expect((await runner.query('SELECT * FROM channel WHERE id=\'a\''))[0].notesCount).toBe(1);
	});
});
