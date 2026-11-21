/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { loadConfig } from '@/config.js';
import { entities } from '@/postgres.js';
import { QueryService } from '@/core/QueryService.js';
import { MiBlocking, MiFollowing, MiMuting, MiUserProfile } from '@/models/_.js';
import type { MiLocalUser } from '@/models/User.js';
import { MiGridspacePlacement, MiGridspacePlacementTarget } from '@/models/GridspacePlacement.js';
import { MiGridspaceNoteTombstone } from '@/models/Gridspace.js';
import { GridspacePlacement1795200743973 } from '../../../migration/1795200743973-gridspace-placement.js';
import { GridspacePlacementService } from './GridspacePlacementService.js';
import { previewHash } from './placement-protocol.js';
import { GridspaceSearchService } from './GridspaceSearchService.js';
import { searchNoteTimeSql } from './search-visibility.js';

const config = loadConfig();
const schema = 'placement_' + randomUUID().replaceAll('-', '');
const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db,
	schema, extra: { options: `-c search_path=${schema},public` }, entities });
const migration = new GridspacePlacement1795200743973();
const origin = 'https://source.example';
const peerOrigin = 'https://destination.example';
const service = Object.assign(Object.create(GridspacePlacementService.prototype), { db, config: { url: origin }, peer: { origin, peerOrigin } }) as GridspacePlacementService;

beforeAll(async () => {
	await db.initialize();
	await db.query(`CREATE SCHEMA "${schema}"`);
	await db.query('CREATE TABLE gridspace_note_tombstone (uri varchar(512) PRIMARY KEY)');
	await db.query(`CREATE TABLE channel (id varchar(32) PRIMARY KEY, name text, color text, description text, "userId" varchar(32), "lastNotedAt" timestamptz,
		"bannerId" varchar(32), "pinnedNoteIds" varchar[] DEFAULT '{}', "notesCount" integer DEFAULT 0, "usersCount" integer DEFAULT 0,
		"isArchived" boolean NOT NULL DEFAULT false, "allowRenoteToExternal" boolean NOT NULL DEFAULT true, "isSensitive" boolean NOT NULL DEFAULT false)`);
	await db.query(`CREATE TABLE note (id varchar(32) PRIMARY KEY, uri text, "userId" varchar(32), "gridspaceShared" boolean NOT NULL DEFAULT false,
		"userHost" text, "includeDefault" boolean, "multiNoteKind" text, visibility text DEFAULT 'public', "channelId" varchar, "renoteChannelId" varchar,
		"replyId" varchar, "renoteId" varchar, "replyUserId" varchar, "renoteUserId" varchar, "replyUserHost" text, "renoteUserHost" text, mentions varchar[] DEFAULT '{}', "visibleUserIds" varchar[] DEFAULT '{}')`);
	await db.query(`CREATE TABLE "user" (id varchar(32) PRIMARY KEY, uri text, "movedToUri" text, "isDeleted" boolean NOT NULL DEFAULT false, "isSuspended" boolean NOT NULL DEFAULT false,
		"requireSigninToViewContents" boolean DEFAULT false, "makeNotesHiddenBefore" integer, "makeNotesFollowersOnlyBefore" integer)`);
	await db.query('CREATE TABLE following ("followerId" varchar, "followeeId" varchar)');
	await db.query('CREATE TABLE user_profile ("userId" varchar, "mutedInstances" jsonb)');
	await db.query('CREATE TABLE blocking ("blockerId" varchar(32), "blockeeId" varchar(32))');
	await db.query('CREATE TABLE muting ("muterId" varchar(32), "muteeId" varchar(32), "expiresAt" timestamptz)');
	await db.query('CREATE TABLE channel_muting ("userId" varchar(32), "channelId" varchar(32), "expiresAt" timestamptz)');
	await db.query('CREATE TABLE note_channel_placement (id uuid DEFAULT gen_random_uuid(), "canonicalUri" varchar(512), "channelId" varchar(32), "noteId" varchar(32), state text)');
	await db.query('CREATE TABLE gridspace_timeline_outbox (kind text, "canonicalUri" text, "channelOrigin" text, "channelId" text, "noteId" text, "sourceRevision" bigint, "targetRevision" bigint, "eventId" uuid UNIQUE)');
	await migration.up({ query: db.query.bind(db) });
});

afterAll(async () => {
	if (!db.isInitialized) return;
	try {
		await migration.down({ query: db.query.bind(db) });
	} finally {
		await db.query(`DROP SCHEMA "${schema}" CASCADE`);
		await db.destroy();
	}
});

test('an origin deletion and an overlapping delivery commit exactly one URI tombstone', async () => {
	const key = { canonicalUri: peerOrigin + '/notes/one', channelId: 'c', sourceRevision: 2 };
	await Promise.all([service['receiveDelete'](key), service['receiveDelete'](key)]);
	const later = await service['receivePlace']({ ...key, sourceRevision: 10, actorId: 'guest', sortAt: new Date().toISOString(), includeDefault: true }, true);
	expect(later.state).toBe('origin-deleted');
	expect(await db.getRepository(MiGridspaceNoteTombstone).countBy({ uri: key.canonicalUri })).toBe(1);
	expect(await db.getRepository(MiGridspacePlacement).countBy({ canonicalUri: key.canonicalUri })).toBe(0);
});

test('deleting a channel schedules target-owned removals and a timeline event without deleting original metadata', async () => {
	const canonicalUri = peerOrigin + '/notes/two';
	const row = await db.getRepository(MiGridspacePlacement).save({ canonicalUri, channelId: 'c', channelOrigin: origin, noteOrigin: peerOrigin,
		originNoteId: 'two', authorUri: peerOrigin + '/users/author', authorOrigin: peerOrigin, includeDefault: false, sortAt: new Date(),
		state: 'active', sourceRevision: 1, targetRevision: 1, version: randomUUID(), attempts: 0, retryAt: null });
	await db.query("INSERT INTO channel (id) VALUES ('c')");
	await db.query("DELETE FROM channel WHERE id = 'c'");
	const terminal = await db.getRepository(MiGridspacePlacement).findOneByOrFail({ id: row.id });
	expect(terminal).toMatchObject({ state: 'removed', targetRevision: 2, sourceRevision: 1, canonicalUri });
	expect(terminal.retryAt).toBeInstanceOf(Date);
	expect(await db.query('SELECT kind, "channelOrigin" FROM gridspace_timeline_outbox WHERE "canonicalUri" = $1', [canonicalUri])).toEqual([{ kind: 'place-remove', channelOrigin: origin }]);
});

test('duplicate and stale status deliveries preserve the destination removal', async () => {
	const canonicalUri = origin + '/notes/three';
	const input = { canonicalUri, channelId: 'x', sourceRevision: 1, placementId: randomUUID() };
	await db.getRepository(MiGridspacePlacementTarget).insert({ ...input, noteId: 'three', peerOrigin, authorId: 'author', sortAt: new Date(),
		name: 'channel', color: '#112233', includeDefault: true, state: 'pending', targetRevision: 0, retryAt: new Date(), version: randomUUID(), attempts: 0 });
	const active = { ...input, state: 'active' as const, targetRevision: 1 };
	const removed = { ...input, state: 'removed' as const, targetRevision: 2 };
	await Promise.all([service['receiveStatus'](active), service['receiveStatus'](removed)]);
	await service['receiveStatus'](active);
	await service['receiveStatus'](removed);
	expect(await db.getRepository(MiGridspacePlacementTarget).findOneByOrFail({ canonicalUri })).toMatchObject({ state: 'removed', targetRevision: 2, retryAt: null });
	expect(await db.query('SELECT kind FROM gridspace_timeline_outbox WHERE "canonicalUri" = $1 AND kind = \'place-remove\'', [canonicalUri])).toHaveLength(1);
});

test('current channel-owner blocks and viewer mutes hide placement metadata while preserving other channels', async () => {
	const canonicalUri = peerOrigin + '/notes/lookup';
	const authorUri = peerOrigin + '/users/author';
	await db.query(`INSERT INTO "user" (id,uri) VALUES ('author',$1),('owner',NULL),('otherOwner',NULL)`, [authorUri]);
	await db.query("INSERT INTO channel (id,name,color,\"userId\") VALUES ('visible','Visible','red','otherOwner'),('hidden','Hidden','blue','owner')");
	await db.query("INSERT INTO blocking VALUES ('owner','viewer')");
	const repo = db.getRepository(MiGridspacePlacement);
	const keys = [];
	for (const channelId of ['hidden', 'visible']) {
		const row = await repo.save({ channelId, canonicalUri, channelOrigin: origin, noteOrigin: peerOrigin, originNoteId: 'lookup',
			authorUri, authorOrigin: peerOrigin, includeDefault: false, sortAt: new Date(), state: 'active',
			sourceRevision: 1, targetRevision: 1, version: randomUUID(), attempts: 0, retryAt: null });
		keys.push({ channelId, canonicalUri, placementId: row.id, sourceRevision: 1, targetRevision: 1 });
	}
	const reader = Object.assign(Object.create(GridspacePlacementService.prototype), { db, peer: { origin, peerOrigin },
		utility: { isBlockedHost: () => false }, meta: { blockedHosts: [] }, viewerActor: async () => ({ id: 'viewer' }) }) as GridspacePlacementService;
	const query = { keys, viewerActorUri: origin + '/users/viewer' };
	const result = await reader['visiblePeerTargets'](query);
	expect(result.items.map(item => item.name)).toEqual(['Visible']);
	await db.query("INSERT INTO channel_muting VALUES ('viewer','visible',NULL)");
	expect(await reader['visiblePeerTargets'](query)).toEqual({ items: [] });
	expect(await repo.countBy({ canonicalUri, state: 'active' })).toBe(2);
});

test.each([['g', origin, peerOrigin], ['r', peerOrigin, origin]])('%s lists, places and packs sensitive public channels with the original CW', async (prefix, target, source) => {
	const viewer = prefix + 'viewer';
	const author = prefix + 'author';
	const authorUri = source + '/users/' + author;
	const channelId = prefix + 'sensitive';
	const archived = prefix + 'archived';
	const blocked = prefix + 'blocked';
	const owner = prefix + 'owner';
	const term = prefix + ' sensitivity fixture';
	await db.query('INSERT INTO "user" (id,uri) VALUES ($1,$2),($3,NULL)', [author, authorUri, owner]);
	await db.query(`INSERT INTO channel (id,name,"isSensitive","isArchived","userId",color) VALUES
		($1,$4,true,false,NULL,'red'), ($2,$4,true,true,NULL,'blue'), ($3,$4,true,false,$5,'green')`, [channelId, archived, blocked, term, owner]);
	await db.query('INSERT INTO blocking VALUES ($1,$2),($1,$3)', [owner, viewer, author]);

	const receiver = Object.assign(Object.create(GridspacePlacementService.prototype), {
		db, config: { url: target, multiNote: { enabled: true }, gridspace: { timelineEnabled: true } }, peer: { origin: target, peerOrigin: source },
		resolveActor: async (id: string) => ({ id }), viewerActor: async () => ({ id: viewer }),
		roles: { getUserPolicies: async () => ({ canPublicNote: true, rateLimitFactor: 0 }), isModerator: async () => false },
		modules: { get: () => ({ pack: async () => ({}) }) },
		meta: { blockedHosts: [], sensitiveWords: ['moderated'], prohibitedWords: [] },
		utility: { isBlockedHost: () => false, concatNoteContentsForKeyWordCheck: (preview: { text?: string }) => preview.text ?? '',
			isKeyWordIncluded: (content: string, words: string[]) => words.some(word => content.includes(word)) }, changed: async () => {},
	}) as GridspacePlacementService;
	const candidates = await receiver['listCandidates']({ actorId: viewer, query: term, list: 'search' });
	expect(candidates.channels.map(c => ({ id: c.id, sensitive: c.isSensitive }))).toEqual([{ id: channelId, sensitive: true }]);
	const sendPrepare = vi.fn((_name: string, input: Parameters<typeof receiver['receivePrepare']>[0]) => receiver['receivePrepare'](input));
	const sender = Object.assign(Object.create(GridspacePlacementService.prototype), {
		peer: { origin: source, peerOrigin: target }, peerEnabled: async () => true, currentActorCredential: (actor: MiLocalUser) => ({ actorId: actor.id }),
		call: sendPrepare,
	}) as GridspacePlacementService;
	const prepare = (id: string, text: string, cw: string | null) => sender.prepare({ id: author } as MiLocalUser, [{ origin: target, channelId: id }], true, { text, cw });
	await expect(prepare(archived, 'post', null)).rejects.toThrow('CHANNEL_UNAVAILABLE');
	await expect(prepare(blocked, 'post', null)).rejects.toThrow('AUTHORIZATION_REVOKED');
	await expect(prepare(channelId, 'moderated', null)).rejects.toThrow('CHANNEL_UNAVAILABLE');

	for (const [index, cw] of [null, 'Author CW'].entries()) {
		const preview = { text: 'post', cw };
		const canonicalUri = source + '/notes/' + prefix + index;
		const hash = previewHash(preview);
		const sortAt = new Date().toISOString();
		const intent = { actorId: author, includeDefault: true, hash, sortAt };
		const prepared = await prepare(channelId, preview.text, cw);
		expect(prepared[0].channelId).toBe(channelId);
		expect(sendPrepare).toHaveBeenLastCalledWith('prepare', expect.objectContaining({ actorId: author, hash, preview }));
		Object.assign(receiver, { call: async () => intent });
		const status = await receiver['receivePlace']({ ...intent, preview, channelId, canonicalUri, sourceRevision: 1 }, false);
		expect(status.state).toBe('active');

		const visible = await receiver['visiblePeerTargets']({ keys: [status], viewerActorUri: target + '/users/' + viewer });
		expect(visible.items.map(item => item.placementId)).toEqual([status.placementId]);

		const mirrorId = prefix + 'mirror' + index;
		await db.query('INSERT INTO note (id,uri,"userId","gridspaceShared") VALUES ($1,$2,$3,true)', [mirrorId, canonicalUri, author]);
		expect((await receiver.pack([mirrorId], { id: viewer })).get(mirrorId)?.map(p => p.channelId)).toEqual([channelId]);
	}
	await db.query('INSERT INTO channel_muting VALUES ($1,$2,NULL)', [viewer, channelId]);
	expect((await receiver['listCandidates']({ actorId: viewer, query: term, list: 'search' })).channels).toEqual([]);
	expect((await receiver.pack([prefix + 'mirror0'], { id: viewer })).size).toBe(0);
});

test.each([['a', origin, peerOrigin], ['b', peerOrigin, origin]])('%s reads origin-only placements for existing ordinary mirrors with posting disabled', async (prefix, home, away) => {
	const root = prefix + 'originRoot';
	const normal = prefix + 'normal';
	const mirror = prefix + 'originMirror';
	const ordinaryMirror = prefix + 'ordinaryMirror';
	const author = prefix + 'originalAuthor';
	const mirroredAuthor = prefix + 'mirroredAuthor';
	const viewer = prefix + 'packViewer';
	const peerViewer = prefix + 'readerReplica';
	const owner = prefix + 'channelOwner';
	const ownerReplica = prefix + 'ownerReplica';
	const one = prefix + 'channelOne';
	const two = prefix + 'channelTwo';
	const rootUri = home + '/notes/' + root;
	await db.query('INSERT INTO "user" (id,uri) VALUES ($1,NULL),($2,$3),($4,NULL),($5,$6),($7,NULL),($8,$9)',
		[author, mirroredAuthor, home + '/users/' + author, viewer, peerViewer, away + '/users/' + viewer, owner, ownerReplica, home + '/users/' + owner]);
	await db.query("INSERT INTO user_profile VALUES ($1,'[]'),($2,'[]')", [viewer, peerViewer]);
	await db.query(`INSERT INTO note (id,"userId",uri,"userHost","multiNoteKind","includeDefault","gridspaceShared") VALUES
		($1,$2,NULL,NULL,'root',true,true),($3,$2,NULL,NULL,NULL,NULL,true),($4,$5,$6,$7,NULL,true,true),($8,$5,$9,$7,NULL,true,true)`,
	[root, author, normal, mirror, mirroredAuthor, rootUri, new URL(home).host, ordinaryMirror, home + '/notes/' + normal]);
	await db.query("INSERT INTO channel (id,name,color,\"userId\") VALUES ($1,'First','#112233',$3),($2,'Second','#445566',NULL)", [one, two, owner]);
	await db.query("INSERT INTO note_channel_placement (\"noteId\",\"channelId\",\"canonicalUri\",state) VALUES ($1,$2,$4,'active'),($1,$3,$4,'active')", [root, one, two, rootUri]);

	const meta = { blockedHosts: [], ugcVisibilityForVisitor: 'all' };
	const queries = Object.assign(Object.create(QueryService.prototype), { meta, mutingsRepository: db.getRepository(MiMuting), blockingsRepository: db.getRepository(MiBlocking),
		userProfilesRepository: db.getRepository(MiUserProfile), followingsRepository: db.getRepository(MiFollowing) });
	const search = Object.assign(Object.create(GridspaceSearchService.prototype), { db, queries, noteTime: searchNoteTimeSql('aidx') });
	const shared = { db, meta, utility: { isBlockedHost: () => false }, modules: { get: () => search } };
	const source = Object.assign(Object.create(GridspacePlacementService.prototype), shared, {
		config: { url: home, multiNote: { enabled: false }, gridspace: { enabled: true } }, peer: { origin: home, peerOrigin: away },
		viewerActor: async (uri: string) => { expect(uri).toBe(away + '/users/' + viewer); return { id: peerViewer }; },
	}) as GridspacePlacementService;
	const call = vi.fn((_route: string, input: Parameters<typeof source['originLookup']>[0]) => source['originLookup'](input));
	const destination = Object.assign(Object.create(GridspacePlacementService.prototype), shared, {
		config: { url: away, multiNote: { enabled: false }, gridspace: { enabled: true } }, peer: { origin: away, peerOrigin: home },
		capabilities: async () => ({ supported: true, originLookup: true, enabled: false }), call,
	}) as GridspacePlacementService;
	const pack = () => destination.pack([mirror, ordinaryMirror], { id: viewer });
	const initial = await pack();
	expect(initial.get(mirror)?.map(p => [p.channelId, p.origin, p.canonicalUri])).toEqual([[one, home, rootUri], [two, home, rootUri]]);
	expect(initial.rootNoteIds).toEqual(new Set([mirror]));
	expect(initial.has(ordinaryMirror)).toBe(false);
	expect(call).toHaveBeenCalledTimes(1);
	expect(call).toHaveBeenCalledWith('origin-lookup', { noteIds: expect.arrayContaining([root, normal]), viewerActorUri: away + '/users/' + viewer });

	await db.query('INSERT INTO blocking VALUES ($1,$2)', [owner, peerViewer]);
	expect((await pack()).get(mirror)?.map(c => c.channelId)).toEqual([two]);
	await db.query('DELETE FROM blocking WHERE "blockerId" = $1', [owner]);
	await db.query('INSERT INTO muting VALUES ($1,$2,NULL)', [viewer, ownerReplica]);
	expect((await pack()).get(mirror)?.map(c => c.channelId)).toEqual([two]);
	await db.query("UPDATE note_channel_placement SET state = 'removed' WHERE \"channelId\" = $1", [two]);
	const empty = await pack();
	expect(empty.get(mirror)).toEqual([]);
	expect(empty.rootNoteIds?.has(mirror)).toBe(true);
	await db.query('INSERT INTO blocking VALUES ($1,$2)', [author, peerViewer]);
	expect((await pack()).rootNoteIds?.has(mirror)).toBe(false);
	await db.query('DELETE FROM blocking WHERE "blockerId" = $1', [author]);
	call.mockRejectedValueOnce(new Error('offline'));
	const offline = await pack();
	expect(offline.unavailableNoteIds).toEqual(new Set([mirror, ordinaryMirror]));
	expect(offline.rootNoteIds?.size ?? 0).toBe(0);
	expect(offline.has(mirror)).toBe(false);

	const channel = { channelId: two, name: 'Second', color: '#445566', placementId: randomUUID(), ownerUri: null };
	for (const channels of [
		[{ ...channel, placementId: 'invalid' }],
		[{ ...channel, ownerUri: away + '/users/' + owner }],
		[{ ...channel, ownerUri: home + '/users/' + owner + '/extra' }],
		[channel, { ...channel, name: 'Conflicting', color: '#000000' }],
	]) {
		call.mockResolvedValueOnce({ roots: [{ noteId: root, channels }] });
		const invalid = await pack();
		expect(invalid.unavailableNoteIds).toEqual(new Set([mirror, ordinaryMirror]));
		expect(invalid.rootNoteIds?.size ?? 0).toBe(0);
		expect(invalid.has(mirror)).toBe(false);
	}
});

test('publishing the same source note to six channels consumes one receiver posting allowance', async () => {
	const canonicalUri = peerOrigin + '/notes/six';
	const preview = { text: 'content' };
	const identity = { canonicalUri, actorId: 'user', sourceRevision: 1, includeDefault: false, hash: previewHash(preview), sortAt: new Date().toISOString() };
	const limit = vi.fn().mockResolvedValue(null);
	const receiver = Object.assign(Object.create(GridspacePlacementService.prototype), { db, peer: { origin, peerOrigin },
		config: { url: origin, multiNote: { enabled: true }, gridspace: { timelineEnabled: true } },
		resolveActor: async () => ({ id: 'actor' }), checkChannel: async () => ({}), checkPreview: () => {}, call: async () => identity,
		roles: { getUserPolicies: async () => ({ rateLimitFactor: 1 }) }, modules: { get: () => ({ limit }) }, changed: async () => {},
	}) as GridspacePlacementService;
	await Promise.all(Array.from({ length: 6 }, (_, i) => receiver['receivePlace']({ ...identity, preview, channelId: 'target' + i }, false)));
	expect(limit).toHaveBeenCalledTimes(1);
	expect(await db.getRepository(MiGridspacePlacement).countBy({ canonicalUri, state: 'active' })).toBe(6);
});

test('the worker parks transient failures after five attempts and never reactivates a permanent rejection', async () => {
	const canonicalUri = origin + '/notes/exhausted';
	const row = await db.getRepository(MiGridspacePlacementTarget).save({ canonicalUri, channelId: 'retryChannel', sourceRevision: 1,
		noteId: 'exhausted', peerOrigin, authorId: 'author', sortAt: new Date(), name: 'channel', color: '#112233', includeDefault: false,
		state: 'pending', targetRevision: 0, placementId: null, retryAt: new Date(0), version: randomUUID(), attempts: 4 });
	const worker = Object.assign(Object.create(GridspacePlacementService.prototype), { db, peer: { origin, peerOrigin }, config: { url: origin },
		deliver: () => { throw new Error('offline'); }, call: async () => ({ ok: true }) }) as GridspacePlacementService;
	await worker.flush();
	expect(await db.getRepository(MiGridspacePlacementTarget).findOneByOrFail({ id: row.id })).toMatchObject({ state: 'failed', retryAt: null, permanentFailure: false, attempts: 5 });
	await db.getRepository(MiGridspacePlacementTarget).update(row.id, { permanentFailure: true });
	await service['receiveStatus']({ canonicalUri, channelId: row.channelId, sourceRevision: 1, targetRevision: 5, state: 'active', placementId: randomUUID() });
	expect(await db.getRepository(MiGridspacePlacementTarget).findOneByOrFail({ id: row.id })).toMatchObject({ state: 'failed', retryAt: null, permanentFailure: true });
});
