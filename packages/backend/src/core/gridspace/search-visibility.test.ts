/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { DataSource, EntitySchema } from 'typeorm';
import { loadConfig } from '@/config.js';
import { IdService } from '@/core/IdService.js';
import type { MiNote } from '@/models/Note.js';
import { shouldHideNoteByTime } from '@/misc/should-hide-note-by-time.js';
import { filterNoteVisibility, noteNewerThanPolicySql, searchNoteTimeSql } from './search-visibility.js';

const now = Date.UTC(2026, 10, 12, 12);
const boundary = now - 3600000;
const config = loadConfig();
const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db,
	entities: [
		new EntitySchema({ name: 'PolicyNote', tableName: 'policy_note', columns: {
			id: { type: String, primary: true }, userId: { type: String }, visibility: { type: String }, replyUserId: { type: String, nullable: true }, mentions: { type: String, array: true },
		} }),
		new EntitySchema({ name: 'PolicyUser', tableName: 'policy_user', columns: {
			id: { type: String, primary: true }, requireSigninToViewContents: { type: Boolean }, makeNotesHiddenBefore: { type: Number, nullable: true }, makeNotesFollowersOnlyBefore: { type: Number, nullable: true },
		} }),
	],
});
beforeAll(async () => { await db.initialize(); });
afterAll(async () => { await db.destroy(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('production visibility SQL in PostgreSQL', () => {
	for (const method of ['aid', 'aidx', 'meid', 'meidg', 'objectid', 'ulid']) {
		test(`${method}: null, zero, absolute/relative cutoffs and exact boundary`, async () => {
			vi.spyOn(Date, 'now').mockReturnValue(now);
			const ids = new IdService({ ...config, id: method });
			const offsets = method === 'objectid' ? [-1000, 0, 1000] : [-1000, -1, 0, 1, 1000];
			for (const date of [...offsets.map(offset => boundary + offset), now]) {
				const id = ids.gen(date);
				const time = searchNoteTimeSql(method);
				expect(Number((await db.query(`SELECT ${time} AS time FROM (SELECT $1::text AS id) note`, [id]))[0].time)).toBe(date);
				for (const field of ['makeNotesHiddenBefore', 'makeNotesFollowersOnlyBefore'] as const) {
					for (const threshold of [null, 0, -3600, boundary / 1000]) {
						const predicate = noteNewerThanPolicySql(time, field).replaceAll(':nowMs', '$3');
						const rows = await db.query(`SELECT ${predicate} AS visible FROM (SELECT $1::text AS id) note, (SELECT $2::integer AS "${field}") "user", (SELECT $3::bigint AS clock) fixture`, [id, threshold, now]);
						expect(rows[0].visible, `${method}/${field}/${threshold}/${date}`).toBe(!shouldHideNoteByTime(threshold, new Date(date)));
					}
				}
			}
		});
	}

	test('actual query helper: source/destination, anonymous, unknown authenticated, owner, follower and outsider', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(now);
		const runner = db.createQueryRunner();
		await runner.connect();
		await runner.startTransaction();
		try {
			// Connection-local tables shadow no data outside this transaction; rollback drops all fixtures.
			await runner.query('CREATE TEMP TABLE policy_user (id text PRIMARY KEY, "requireSigninToViewContents" boolean, "makeNotesHiddenBefore" integer, "makeNotesFollowersOnlyBefore" integer) ON COMMIT DROP');
			await runner.query('CREATE TEMP TABLE policy_note (id text PRIMARY KEY, "userId" text, visibility text, "replyUserId" text, mentions text[]) ON COMMIT DROP');
			await runner.query('CREATE TEMP TABLE following ("followerId" text, "followeeId" text) ON COMMIT DROP');
			await runner.query(`INSERT INTO policy_user VALUES ('author', false, null, null)`);
			await runner.query(`INSERT INTO following VALUES ('follower', 'author')`);
			const ids = new IdService({ ...config, id: 'aidx' });
			const old = ids.gen(boundary - 1000); const edge = ids.gen(boundary); const fresh = ids.gen(boundary + 1000);
			for (const id of [old, edge, fresh]) await runner.query(`INSERT INTO policy_note VALUES ($1, 'author', 'public', null, '{}')`, [id]);
			const read = async (viewerId: string | null, source: boolean, authenticated = viewerId != null) => {
				const query = db.createQueryBuilder<MiNote>('PolicyNote', 'note', runner).select('note.id', 'id')
					.innerJoin('PolicyUser', 'user', 'user.id = note.userId').setQueryRunner(runner);
				filterNoteVisibility(query, searchNoteTimeSql('aidx'), viewerId ? { id: viewerId } : null, source, authenticated);
				return (await query.orderBy('note.id').getRawMany<{ id: string }>()).map(row => row.id);
			};
			for (const source of [false, true]) {
				for (const viewer of [null, 'author', 'follower', 'outsider']) expect(await read(viewer, source)).toEqual([old, edge, fresh]);
			}
			await runner.query('UPDATE policy_user SET "requireSigninToViewContents"=true');
			for (const source of [false, true]) {
				expect(await read(null, source)).toEqual([]);
				expect(await read(null, source, true)).toEqual([old, edge, fresh]);
				for (const viewer of ['author', 'follower', 'outsider']) expect(await read(viewer, source)).toEqual([old, edge, fresh]);
			}
			await runner.query('UPDATE policy_user SET "requireSigninToViewContents"=false');
			for (const field of ['makeNotesHiddenBefore', 'makeNotesFollowersOnlyBefore']) {
				for (const threshold of [-3600, boundary / 1000]) {
					await runner.query(`UPDATE policy_user SET "${field}"=$1`, [threshold]);
					for (const viewer of [null, 'author', 'follower', 'outsider']) {
						expect(await read(viewer, true)).toEqual([fresh]);
						const allowed = viewer === 'author' || field === 'makeNotesFollowersOnlyBefore' && viewer === 'follower';
						expect(await read(viewer, false)).toEqual(allowed ? [old, edge, fresh] : [fresh]);
					}
				}
				await runner.query(`UPDATE policy_user SET "${field}"=null`);
				expect(await read(null, true)).toEqual([old, edge, fresh]);
			}
		} finally {
			await runner.rollbackTransaction();
			await runner.release();
		}
	});
});
