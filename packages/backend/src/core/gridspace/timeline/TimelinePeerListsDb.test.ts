/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { DataSource } from 'typeorm';
import { loadConfig } from '@/config.js';
import { entities } from '@/postgres.js';
import { MiNote } from '@/models/Note.js';
import { MiNoteFavorite } from '@/models/NoteFavorite.js';
import { MiUser } from '@/models/User.js';
import { IdService } from '@/core/IdService.js';
import { GridspacePrivateService } from '../GridspacePrivateService.js';
import { GridspaceSearchService } from '../GridspaceSearchService.js';
import { GridspaceTimelineListSourceService } from './GridspaceTimelineListSourceService.js';
import { TimelinePublicListSource } from './TimelinePublicListSource.js';
import { readSearchRows } from './search-page.js';
import type { PrivatePeerRequest } from '../private-protocol.js';
import type { MiLocalUser } from '@/models/User.js';

const config = loadConfig();
const schema = `peer_lists_${randomUUID().replaceAll('-', '')}`;
const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db,
	schema, extra: { options: `-c search_path=${schema},public` }, entities });
const ids = new IdService({ ...config, id: 'aidx' });
const idCache = new Map<number, string>();
const id = (n: number) => { if (!idCache.has(n)) idCache.set(n, ids.gen(1700000000000 + n * 1000)); return idCache.get(n)!; };
let service: GridspacePrivateService;
let localService: GridspaceTimelineListSourceService;

beforeAll(async () => {
	await db.initialize(); await db.query(`CREATE SCHEMA "${schema}"`);
	await db.query('CREATE TABLE note (id varchar(32) PRIMARY KEY, uri text, "userId" varchar(32), visibility text, "channelId" varchar(32), mentions varchar(32)[] NOT NULL DEFAULT \'{}\', "visibleUserIds" varchar(32)[] NOT NULL DEFAULT \'{}\')');
	await db.query('CREATE INDEX note_channel_id ON note ("channelId", id) WHERE "channelId" IS NOT NULL');
	await db.query('ALTER TABLE note ADD COLUMN text text, ADD COLUMN cw text');
	await db.query('CREATE INDEX note_mentions ON note USING gin (mentions)');
	await db.query('CREATE INDEX note_recipients ON note USING gin ("visibleUserIds")');
	await db.query('CREATE TABLE note_favorite (id varchar(32) PRIMARY KEY, "userId" varchar(32), "noteId" varchar(32))');
	await db.query('CREATE TABLE clip (id varchar(32) PRIMARY KEY, "userId" varchar(32), "isPublic" boolean)');
	await db.query('CREATE TABLE clip_note (id varchar(32) PRIMARY KEY, "clipId" varchar(32), "noteId" varchar(32))');
	await db.query('CREATE TABLE "user" (id varchar(32), uri text, host text, "makeNotesHiddenBefore" integer, "makeNotesFollowersOnlyBefore" integer, "isDeleted" boolean NOT NULL DEFAULT false, "isSuspended" boolean NOT NULL DEFAULT false)');
	await db.query("INSERT INTO \"user\" (id) VALUES ('author'), ('otherAuthor'), ('oldViewer')");
	for (let n = 1; n <= 60; n++) {
		await db.query('INSERT INTO note (id, "userId", visibility) VALUES ($1, $2, $3)', [id(n), 'author', n % 2 ? 'public' : 'followers']);
		await db.query('INSERT INTO clip_note VALUES ($1, $2, $3)', [id(n + 100), 'clip', id(n)]);
	}
	await db.query('INSERT INTO note (id, "userId", visibility, "channelId") VALUES ($1, \'otherAuthor\', \'public\', \'targetChannel\'), ($2, \'otherAuthor\', \'followers\', \'targetChannel\')', [id(101), id(102)]);
	await db.query('INSERT INTO note (id, "userId", visibility, mentions, "visibleUserIds") VALUES ($1, \'otherAuthor\', \'specified\', ARRAY[\'oldViewer\'], \'{}\'), ($2, \'otherAuthor\', \'public\', ARRAY[\'oldViewer\'], \'{}\'), ($3, \'otherAuthor\', \'specified\', \'{}\', ARRAY[\'oldViewer\']), ($4, \'otherAuthor\', \'specified\', ARRAY[\'someoneElse\'], ARRAY[\'someoneElse\'])', [id(103), id(104), id(105), id(106)]);
	await db.query('INSERT INTO note (id, "userId", visibility, "channelId", mentions, "visibleUserIds") SELECT id, \'otherAuthor\', \'specified\', \'otherChannel\', ARRAY[\'someoneElse\'], ARRAY[\'someoneElse\'] FROM unnest($1::varchar[]) AS id', [Array.from({ length: 600 }, (_, n) => id(1000 + n))]);
	await db.query("INSERT INTO clip VALUES ('clip', 'oldViewer', true)");
	await db.query('INSERT INTO note_favorite VALUES ($1, $2, $3), ($4, $2, $5)', [id(90), 'oldViewer', id(1), id(80), id(60)]);
	const noteQuery = () => db.getRepository(MiNote).createQueryBuilder('note').innerJoinAndSelect('note.user', 'user')
		.select(['note.id', 'note.uri', 'note.userId', 'note.visibility', 'note.channelId', 'user.id', 'user.uri', 'user.makeNotesHiddenBefore', 'user.makeNotesFollowersOnlyBefore']);
	const boundedSearch = Object.assign(Object.create(GridspaceSearchService.prototype), { db }) as GridspaceSearchService;
	service = Object.assign(Object.create(GridspacePrivateService.prototype), {
		db, ids, peer: { origin: 'https://source.test', peerOrigin: 'https://reader.test' },
		authorizeRead: async () => ({ localUserId: 'oldViewer', initiator: false }),
		listQuery: async (_viewer: string, input: PrivatePeerRequest) => {
			const query = noteQuery();
			const mode = input.contextMode ?? input.mode;
			if (mode === 'favorites') query.innerJoinAndMapOne('note.gridspaceCollection', MiNoteFavorite, 'collection', 'collection.noteId = note.id AND collection.userId = :viewer', { viewer: 'oldViewer' });
			if (mode === 'clip') query.innerJoin('clip_note', 'member', 'member."noteId" = note.id AND member."clipId" = :clip', { clip: input.clipId });
			if (mode === 'channel') query.andWhere('note.channelId = :channel', { channel: input.channelId });
			if (mode === 'mentions' || mode === 'direct') {
				query.andWhere('(:recipient::varchar[] <@ note.mentions OR :recipient::varchar[] <@ note.visibleUserIds)', { recipient: ['oldViewer'] });
				if (mode === 'direct') query.andWhere('note.visibility = \'specified\'');
			}
			return query;
		},
		publicLists: { buildQuery: async () => noteQuery().andWhere("note.visibility = 'public'") },
		search: boundedSearch,
		roles: { getUserPolicies: async () => ({ canSearchNotes: true }) },
		timelineReferences: { currentPosition: async () => '10', status: async () => ({ generation: 1 }) },
	}) as GridspacePrivateService;
	localService = Object.assign(Object.create(GridspaceTimelineListSourceService.prototype), {
		db, ids, peer: null, origin: 'https://source.test',
		queries: { generateMutedNoteThreadQuery: () => {} },
		search: { noteQuery, read: boundedSearch.read.bind(boundedSearch) },
	}) as GridspaceTimelineListSourceService;
});

afterAll(async () => {
	if (db.isInitialized) { await db.query(`DROP SCHEMA "${schema}" CASCADE`); await db.destroy(); }
});

test('real query oldest clip advances two pages with a fixed ceiling, including anchor40', async () => {
	const input: PrivatePeerRequest = { mode: 'clip', clipId: 'clip', order: 'oldest', accessToken: 'token' };
	const first = await service.peerListTimeline(input);
	expect(first.references.map(ref => ref.noteId)).toEqual(Array.from({ length: 50 }, (_, n) => id(n + 1)));
	const second = await service.peerListTimeline({ ...input, timelineBefore: first.next!, timelineUpper: first.upper! });
	expect(second.references.map(ref => ref.noteId)).toEqual(Array.from({ length: 10 }, (_, n) => id(n + 51)));
	const anchored = await service.peerListTimeline({ ...input, timelineFromAt: 1700000040000 });
	expect(anchored.references[0].noteId).toBe(id(40));
});

test('real query favorites uses save timestamps even when note ages are reversed', async () => {
	const result = await service.peerListTimeline({ mode: 'favorites', accessToken: 'token' });
	expect(result.references.map(ref => [ref.noteId, ref.sourceId])).toEqual([[id(1), id(90)], [id(60), id(80)]]);
});

test('real query public-only profile does not emit private source notes without a credential', async () => {
	const result = await service.peerListTimeline({ mode: 'profile', timelineViewerId: 'viewer', targetUris: ['https://source.test/users/author'] });
	expect(result.references).toHaveLength(30);
	expect(result.references.every(ref => ref.public)).toBe(true);
	const privateIds = new Set(Array.from({ length: 30 }, (_, n) => id((n + 1) * 2)));
	expect(result.references.some(ref => privateIds.has(ref.noteId))).toBe(false);
});

test('real query channel finds its older notes on the first page below 600 unrelated newer notes', async () => {
	const result = await service.peerListTimeline({ mode: 'channel', channelId: 'targetChannel', accessToken: 'token' });
	expect(result.references.map(ref => ref.noteId)).toEqual([id(102), id(101)]);
	expect(result.next).toBeNull();
});

test('real query recipient indexes reach mentions and direct notes below unrelated newer notes', async () => {
	const mentions = await service.peerListTimeline({ mode: 'mentions', accessToken: 'token' });
	expect(mentions.references.map(ref => ref.noteId)).toEqual([id(105), id(104), id(103)]);
	expect(mentions.next).toBeNull();
	const direct = await service.peerListTimeline({ mode: 'direct', accessToken: 'token' });
	expect(direct.references.map(ref => ref.noteId)).toEqual([id(105), id(103)]);
	expect(direct.next).toBeNull();
});

test('real local recipient pages reach older mentions and direct notes without empty global windows', async () => {
	const viewer = { id: 'oldViewer', isDeleted: false, isSuspended: false } as MiLocalUser;
	for (const kind of ['mentions', 'direct'] as const) {
		const expected = (kind === 'mentions' ? [105, 104, 103] : [105, 103]).map(id);
		const page = await localService.readPage(viewer, { kind }, { limit: 50 });
		expect(page.references.map(ref => ref.noteId)).toEqual(expected);
		expect(page.ended).toBe(true);
		expect(page.next).toBeNull();
		expect((await localService.read(viewer, { kind }, { limit: 50 })).map(ref => ref.noteId)).toEqual(expected);
	}
});

test('search pages matches beyond 4096 unrelated rows and rechecks public/private visibility', async () => {
	await db.query('INSERT INTO note (id, "userId", visibility, text) SELECT id, \'author\', \'public\', \'unrelated\' FROM unnest($1::varchar[]) AS id', [Array.from({ length: 10000 }, (_, n) => id(20000 + n))]);
	await db.query('UPDATE note SET text = \'sparse match\' WHERE id = $1', [id(1)]);
	await db.query('UPDATE note SET cw = \'sparse match\' WHERE id = $1', [id(2)]);
	const makeQuery = () => db.getRepository(MiNote).createQueryBuilder('note').select(['note.id', 'note.uri'])
		.where("(note.text ILIKE :q OR note.cw ILIKE :q) AND note.visibility = 'public'", { q: '%sparse%' });
	const searchSource = Object.assign(Object.create(GridspaceTimelineListSourceService.prototype), {
		db, ids, peer: null, origin: 'https://source.test', buildQuery: makeQuery,
		search: Object.assign(Object.create(GridspaceSearchService.prototype), { db }),
	}) as GridspaceTimelineListSourceService;
	const read = () => searchSource.readPage({ id: 'viewer' } as MiLocalUser, { kind: 'search', query: 'sparse' }, { limit: 50 });
	const first = await read();
	expect(first.references.map(ref => ref.noteId)).toEqual([id(1)]);
	expect(first.ended).toBe(true);
	expect(first.next).toBeNull();
	const publicSource = Object.assign(Object.create(TimelinePublicListSource.prototype), { buildQuery: makeQuery, search: searchSource['search'], ids, config: { url: 'https://source.test' } });
	const publicPage = await publicSource.readPage({ kind: 'search', query: 'sparse' }, { limit: 50 });
	expect(publicPage.references.map(ref => ref.noteId)).toEqual([id(1)]);
	expect(publicPage.next).toBeNull();
	const peer = Object.assign(Object.create(GridspacePrivateService.prototype), service, {
		publicLists: { buildQuery: makeQuery },
		listQuery: async () => db.getRepository(MiNote).createQueryBuilder('note').where("(note.text ILIKE :q OR note.cw ILIKE :q) AND note.visibility = 'followers'", { q: '%sparse%' }),
	});
	const peerPage = await peer.peerListTimeline({ mode: 'search', query: 'sparse', timelineViewerId: 'viewer', accessToken: 'token' });
	expect(peerPage.references.map(ref => [ref.noteId, ref.public ?? false])).toEqual([[id(2), false], [id(1), true]]);
	expect(peerPage.next).toBeNull();
	await db.query('UPDATE note SET visibility = \'followers\' WHERE id = $1', [id(1)]);
	expect((await read()).references).toEqual([]);
	await db.query('UPDATE note SET visibility = \'public\', text = NULL WHERE id = $1', [id(1)]);
	await db.query('UPDATE note SET cw = NULL WHERE id = $1', [id(2)]);
});

test('matching public/private search rows page once in origin order without gaps or hidden matches', async () => {
	for (let n = 1; n <= 120; n++) {
		await db.query('INSERT INTO note (id, "userId", visibility, text) VALUES ($1, \'author\', $2, \'multipage\')', [id(40000 + n), n % 2 ? 'public' : 'followers']);
	}
	await db.query('INSERT INTO note (id, "userId", visibility, text) VALUES ($1, \'author\', \'specified\', \'multipage\')', [id(60000)]);
	const query = (visibility: string) => db.getRepository(MiNote).createQueryBuilder('note')
		.where('note.text = :query AND note.visibility = :visibility', { query: 'multipage', q: '%multipage%', visibility });
	const peer = Object.assign(Object.create(GridspacePrivateService.prototype), service, {
		publicLists: { buildQuery: async () => query('public') }, listQuery: async () => query('followers'),
	});
	const input: PrivatePeerRequest = { mode: 'search', query: 'multipage', timelineViewerId: 'viewer', accessToken: 'token' };
	const first = await peer.peerListTimeline(input);
	const second = await peer.peerListTimeline({ ...input, timelineBefore: first.next!, timelineUpper: first.upper! });
	const third = await peer.peerListTimeline({ ...input, timelineBefore: second.next!, timelineUpper: first.upper! });
	expect([first.references.length, second.references.length, third.references.length]).toEqual([50, 50, 20]);
	expect(third.next).toBeNull();
	const refs = [...first.references, ...second.references, ...third.references];
	expect(refs.map(ref => ref.noteId)).toEqual(Array.from({ length: 120 }, (_, n) => id(40120 - n)));
	expect(refs.filter(ref => ref.public).length).toBe(60);
});

test('linked-author search retains time and cursor bounds in both author queries', async () => {
	for (let n = 1; n <= 8; n++) {
		await db.query('INSERT INTO note (id, "userId", visibility, text) VALUES ($1, $2, \'public\', \'authors\')', [id(70000 + n), n % 2 ? 'author' : 'otherAuthor']);
	}
	await db.query('INSERT INTO note (id, "userId", visibility, text) VALUES ($1, \'oldViewer\', \'public\', \'authors\')', [id(70005) + 'a']);
	const query = db.getRepository(MiNote).createQueryBuilder('note').where('note.text = :term AND note.userId IN (:...authors)', { term: 'authors', authors: ['author', 'otherAuthor'] });
	const search = Object.assign(Object.create(GridspaceSearchService.prototype), { db }) as GridspaceSearchService;
	const ref = (n: number) => ({ sortAt: String(ids.parse(id(n)).date.getTime()), noteId: id(n), canonicalUri: `https://source.test/notes/${id(n)}` });
	const rows = await readSearchRows(search, query, ids, {
		before: ref(70007), upper: ref(70006),
		fromAt: ids.parse(id(70003)).date.getTime(), untilAt: ids.parse(id(70005)).date.getTime(), limit: 2,
	}, ['author', 'otherAuthor']);
	expect(rows.map(note => note.id)).toEqual([70005, 70004, 70003].map(id));
});

test('a single resolved author constrains search and an unresolved author returns no matches', async () => {
	const query = db.getRepository(MiNote).createQueryBuilder('note').where("note.visibility = 'public' AND note.id IN (:...ids)", { ids: [id(1), id(2), id(101)] });
	const search = Object.assign(Object.create(GridspaceSearchService.prototype), { db }) as GridspaceSearchService;
	const read = async (authors?: string[]) => (await readSearchRows(search, query, ids, { limit: 10 }, authors)).map(note => note.id);
	expect(await read(['author'])).toEqual([id(1)]);
	expect(await read([])).toEqual([]);
	expect(await read()).toEqual([id(101), id(1)]);
});

test('search emits its text-filter boundary after query cloning without changing the caller', async () => {
	const query = db.getRepository(MiNote).createQueryBuilder('note').innerJoin('note.user', 'user')
		.where('note.text ILIKE :q AND note.visibility = :visibility', { q: '%unrelated%', visibility: 'public' });
	const before = query.getQuery();
	const search = Object.assign(Object.create(GridspaceSearchService.prototype), { db }) as GridspaceSearchService;
	let executed = '';
	const rows = await readSearchRows({ read: async page => {
		const clone = page.clone();
		executed = clone.getQuery();
		return search.read(clone);
	}, readAuthorPage: search.readAuthorPage.bind(search) }, query, ids, { limit: 20 });
	expect(rows).toHaveLength(21);
	expect(executed).toContain('OFFSET 0');
	expect(executed).toContain('INNER JOIN');
	expect(query.getQuery()).toBe(before);
	expect(before).not.toContain('OFFSET 0');
});
