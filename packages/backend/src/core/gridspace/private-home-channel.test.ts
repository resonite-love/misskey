/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { DataSource, EntitySchema } from 'typeorm';
import { loadConfig } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import type { PrivatePeerRequest, PrivateWireNote } from './private-protocol.js';

const config = loadConfig();
const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db,
	entities: [new EntitySchema({ name: 'HomeNote', tableName: 'home_note', columns: {
		id: { type: String, primary: true }, userId: { type: String }, channelId: { type: String, nullable: true }, visibility: { type: String },
	} })],
});
beforeAll(async () => { await db.initialize(); });
afterAll(async () => { await db.destroy(); });

test('home includes followed channels without following the author, and removes them on unfollow', async () => {
	const runner = db.createQueryRunner();
	await runner.connect(); await runner.startTransaction();
	try {
		await runner.query('CREATE TEMP TABLE home_note (id text PRIMARY KEY, "userId" text, "channelId" text, visibility text) ON COMMIT DROP');
		await runner.query('CREATE TEMP TABLE home_author (id text PRIMARY KEY, "makeNotesFollowersOnlyBefore" integer) ON COMMIT DROP');
		await runner.query('CREATE TEMP TABLE channel_following ("followerId" text, "followeeId" text) ON COMMIT DROP');
		await runner.query("INSERT INTO home_author VALUES ('stranger', null)");
		await runner.query("INSERT INTO channel_following VALUES ('viewer', 'subscribed')");
		await runner.query(`INSERT INTO home_note VALUES
			('channel', 'stranger', 'subscribed', 'public'), ('other', 'stranger', 'unfollowed', 'public'),
			('public', 'stranger', null, 'public'), ('private', 'stranger', null, 'followers')`);
		const service = Object.assign(Object.create(GridspacePrivateService.prototype), {
			noteTime: '0', peer: { peerOrigin: 'https://g.example' },
			queries: { generateMutedNoteThreadQuery: vi.fn() },
			search: { noteQuery: () => db.createQueryBuilder('HomeNote', 'note', runner)
				.innerJoin('home_author', 'user', '"user".id = note.userId').setParameter('nowMs', Date.now()) },
		}) as GridspacePrivateService;
		const read = async (input: Partial<PrivatePeerRequest> = {}) => (await service['query']('viewer', { mode: 'home', ...input }).getMany()).map(note => note.id).sort();
		expect(await read()).toEqual(['channel', 'private']);
		expect(await read({ channelActorId: 'guest' })).toEqual(['channel']);
		expect(await read({ withChannelNotes: false })).toEqual(['private']);
		expect(await read({ mode: 'validate', contextMode: 'home', channelActorId: 'guest' })).toEqual(['channel']);
		await runner.query('DELETE FROM channel_following');
		expect(await read()).toEqual(['private']);
		expect(await read({ channelActorId: 'guest' })).toEqual([]);
	} finally { await runner.rollbackTransaction(); await runner.release(); }
});

test('guest identity permits home validation, but never grants general private-note access', async () => {
	const source = vi.fn(async () => ({ id: 'guest-on-source' }));
	const service = Object.assign(Object.create(GridspacePrivateService.prototype), { channelAuth: { assertSource: vi.fn(), source } }) as GridspacePrivateService;
	for (const input of [{ mode: 'home' }, { mode: 'validate', contextMode: 'home' }]) {
		expect(await service['authorizeRead']({ ...input, channelActorId: 'guest' } as PrivatePeerRequest)).toMatchObject({ localUserId: 'guest-on-source' });
	}
	for (const input of [{ mode: 'show', noteId: 'secret' }, { mode: 'search', query: 'secret' }, { mode: 'home', targetUris: ['https://r.example/users/other'] }]) {
		await expect(service['authorizeRead']({ ...input, channelActorId: 'guest' } as PrivatePeerRequest)).rejects.toThrow();
	}
});

test('home channel notes retain destination mute checks without requiring an author follow', async () => {
	const service = Object.assign(Object.create(GridspacePrivateService.prototype), { collectionClient: true }) as GridspacePrivateService;
	const viewer = { id: 'viewer' } as MiLocalUser;
	const note = { channelId: 'subscribed', filterActors: [{ uri: 'https://r.example/users/stranger' }] } as PrivateWireNote;
	expect(await service.localAllows(viewer, note, true, 'old', async () => true)).toBe(true);
	expect(await service.localAllows(viewer, note, true, 'old', async () => false)).toBe(false);
	Object.assign(service, { collectionClient: false });
	expect(await service.localAllows(viewer, note, true, 'old', async () => true)).toBe(false);
});
