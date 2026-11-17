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
import type { PrivatePeerRequest } from '../private-protocol.js';

const config = loadConfig();
const schema = `peer_lists_${randomUUID().replaceAll('-', '')}`;
const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db,
	schema, extra: { options: `-c search_path=${schema},public` }, entities });
const ids = new IdService({ ...config, id: 'aidx' });
const idCache = new Map<number, string>();
const id = (n: number) => { if (!idCache.has(n)) idCache.set(n, ids.gen(1700000000000 + n * 1000)); return idCache.get(n)!; };
let service: GridspacePrivateService;

beforeAll(async () => {
	await db.initialize(); await db.query(`CREATE SCHEMA "${schema}"`);
	await db.query('CREATE TABLE note (id varchar(32) PRIMARY KEY, uri text, "userId" varchar(32), visibility text, "channelId" varchar(32))');
	await db.query('CREATE TABLE note_favorite (id varchar(32) PRIMARY KEY, "userId" varchar(32), "noteId" varchar(32))');
	await db.query('CREATE TABLE clip (id varchar(32) PRIMARY KEY, "userId" varchar(32), "isPublic" boolean)');
	await db.query('CREATE TABLE clip_note (id varchar(32) PRIMARY KEY, "clipId" varchar(32), "noteId" varchar(32))');
	await db.query('CREATE TABLE "user" (id varchar(32), uri text, host text, "makeNotesHiddenBefore" integer, "makeNotesFollowersOnlyBefore" integer)');
	await db.query("INSERT INTO \"user\" VALUES ('author', NULL, NULL, NULL, NULL)");
	for (let n = 1; n <= 60; n++) {
		await db.query('INSERT INTO note VALUES ($1, NULL, $2, $3, NULL)', [id(n), 'author', n % 2 ? 'public' : 'followers']);
		await db.query('INSERT INTO clip_note VALUES ($1, $2, $3)', [id(n + 100), 'clip', id(n)]);
	}
	await db.query("INSERT INTO clip VALUES ('clip', 'oldViewer', true)");
	await db.query('INSERT INTO note_favorite VALUES ($1, $2, $3), ($4, $2, $5)', [id(90), 'oldViewer', id(1), id(80), id(60)]);
	const noteQuery = () => db.getRepository(MiNote).createQueryBuilder('note').innerJoinAndSelect('note.user', 'user')
		.select(['note.id', 'note.uri', 'note.userId', 'note.visibility', 'note.channelId', 'user.id', 'user.uri', 'user.makeNotesHiddenBefore', 'user.makeNotesFollowersOnlyBefore']);
	service = Object.assign(Object.create(GridspacePrivateService.prototype), {
		db, ids, peer: { origin: 'https://source.test', peerOrigin: 'https://reader.test' },
		authorizeRead: async () => ({ localUserId: 'oldViewer', initiator: false }),
		listQuery: async (_viewer: string, input: PrivatePeerRequest) => {
			const query = noteQuery();
			const mode = input.contextMode ?? input.mode;
			if (mode === 'favorites') query.innerJoinAndMapOne('note.gridspaceCollection', MiNoteFavorite, 'collection', 'collection.noteId = note.id AND collection.userId = :viewer', { viewer: 'oldViewer' });
			if (mode === 'clip') query.innerJoin('clip_note', 'member', 'member."noteId" = note.id AND member."clipId" = :clip', { clip: input.clipId });
			return query;
		},
		publicLists: { buildQuery: async () => noteQuery().andWhere("note.visibility = 'public'") },
		search: { read: (query: { getMany: () => Promise<MiNote[]> }) => query.getMany() },
		roles: { getUserPolicies: async () => ({ canSearchNotes: true }) },
		timelineReferences: { currentPosition: async () => '10', status: async () => ({ generation: 1 }) },
	}) as GridspacePrivateService;
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
