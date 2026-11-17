/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { DataSource } from 'typeorm';
import { loadConfig } from '@/config.js';
import { entities } from '@/postgres.js';
import { QueryService } from '@/core/QueryService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import type { MiMeta } from '@/models/Meta.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import { GridspaceSearchService } from './GridspaceSearchService.js';

const config = loadConfig();
const schema = `actor_acl_${randomUUID().replaceAll('-', '')}`;
const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db,
	schema, extra: { options: `-c search_path=${schema},public` }, entities });
const viewer = { id: 'viewer' } as MiLocalUser;
let service: GridspacePrivateService;

beforeAll(async () => {
	await db.initialize(); await db.query(`CREATE SCHEMA "${schema}"`);
	await db.query('CREATE TABLE "user" (id varchar PRIMARY KEY, uri text, host text, "isDeleted" boolean DEFAULT false, "isSuspended" boolean DEFAULT false)');
	await db.query('CREATE TABLE user_profile ("userId" varchar PRIMARY KEY, "mutedInstances" jsonb)');
	await db.query('CREATE TABLE blocking ("blockerId" varchar, "blockeeId" varchar)');
	await db.query('CREATE TABLE muting ("muterId" varchar, "muteeId" varchar)');
	await db.query(`INSERT INTO "user" (id, uri, host, "isDeleted", "isSuspended") VALUES
		('local', NULL, NULL, false, false), ('allowed', 'https://remote.test/users/allowed', 'remote.test', false, false),
		('blocked', 'https://remote.test/users/blocked', 'remote.test', false, false),
		('blocksViewer', 'https://remote.test/users/blocksViewer', 'remote.test', false, false),
		('muted', 'https://remote.test/users/muted', 'remote.test', false, false),
		('deleted', 'https://remote.test/users/deleted', 'remote.test', true, false),
		('suspended', 'https://remote.test/users/suspended', 'remote.test', false, true)`);
	await db.query(`INSERT INTO blocking VALUES ('viewer','blocked'), ('blocksViewer','viewer')`);
	await db.query(`INSERT INTO muting VALUES ('viewer','muted')`);
	await db.query(`INSERT INTO user_profile VALUES ('viewer', '["muted.test"]')`);
	const meta = { blockedHosts: ['blocked.test'] } as MiMeta;
	const repo = (name: string) => db.getRepository(`Mi${name}`);
	const queries = new QueryService(repo('UserProfile'), repo('Following'), repo('ChannelFollowing'), repo('Blocking'), repo('NoteThreadMuting'), repo('Muting'), repo('RenoteMuting'), meta, {} as never);
	const search = Object.assign(Object.create(GridspaceSearchService.prototype), { db, queries, meta });
	const userQuery = search.userQuery.bind(search);
	search.userQuery = reader => userQuery(reader).select('user.id');
	// Only columns used by these checks are needed in the isolated schema.
	const narrowDb = { getRepository: (entity: unknown) => entity === MiUserProfile
		? { findOneBy: async ({ userId }: { userId: string }) => (await db.query('SELECT "mutedInstances" FROM user_profile WHERE "userId"=$1', [userId]))[0] }
		: entity === MiUser ? { find: repo('User').find.bind(repo('User')), findOneBy: (where: object) => repo('User').findOne({ select: { id: true }, where }), createQueryBuilder: repo('User').createQueryBuilder.bind(repo('User')) } : db.getRepository(entity as never) };
	service = Object.assign(Object.create(GridspacePrivateService.prototype), { db: narrowDb, search, meta, utility: new UtilityService(config, meta), peer: { origin: 'https://local.test' } });
});

afterAll(async () => { if (db.isInitialized) { await db.query(`DROP SCHEMA "${schema}" CASCADE`); await db.destroy(); } });

test('batch checks match individual checks for current host, user, mute and two-way block rules', async () => {
	const actors = ['allowed', 'blocked', 'blocksViewer', 'muted', 'deleted', 'suspended', 'unknown'].map(id => ({ uri: `https://remote.test/users/${id}`, host: 'remote.test' }));
	actors.push({ uri: 'https://local.test/users/local', host: 'local.test' }, { uri: 'https://blocked.test/users/unknown', host: 'blocked.test' }, { uri: 'https://muted.test/users/unknown', host: 'muted.test' });
	const checker = await service.localActorChecker(viewer, [...actors, ...actors]);
	const actual = await Promise.all(actors.map(checker));
	expect(actual).toEqual(await Promise.all(actors.map(actor => service.localActorAllows(viewer, actor))));
	expect(actual).toEqual([true, false, false, false, false, false, true, true, false, false]);
	expect(await checker({ uri: 'https://remote.test/users/not-in-batch', host: 'remote.test' })).toBe(false);
});

test('a new request observes a new mute and unmute instead of reusing the old decision', async () => {
	const actor = { uri: 'https://remote.test/users/allowed', host: 'remote.test' };
	expect(await (await service.localActorChecker(viewer, [actor]))(actor)).toBe(true);
	await db.query(`INSERT INTO muting VALUES ('viewer','allowed')`);
	expect(await (await service.localActorChecker(viewer, [actor]))(actor)).toBe(false);
	await db.query(`DELETE FROM muting WHERE "muteeId"='allowed'`);
	expect(await (await service.localActorChecker(viewer, [actor]))(actor)).toBe(true);
});
