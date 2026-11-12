/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DataSource } from 'typeorm';
import { loadConfig } from '@/config.js';
import { IdService } from '@/core/IdService.js';
import { shouldHideNoteByTime } from '@/misc/should-hide-note-by-time.js';
import { searchNoteTimeSql } from './search-visibility.js';

describe('search visibility timestamps in PostgreSQL', () => {
	const config = loadConfig();
	const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db });
	beforeAll(async () => { await db.initialize(); });
	afterAll(async () => { await db.destroy(); });
	for (const method of ['aid', 'aidx', 'meid', 'meidg', 'objectid', 'ulid']) {
		test(`${method} matches IdService and absolute/relative privacy boundaries`, async () => {
			const ids = new IdService({ ...config, id: method });
			for (const date of [Date.UTC(2020, 0, 1), Date.UTC(2026, 10, 12, 1, 2, 3, 456)]) {
				const id = ids.gen(date);
				const timestamp = ids.parse(id).date.getTime();
				const sql = searchNoteTimeSql(method);
				const rows = await db.query(`SELECT ${sql} AS time FROM (SELECT $1::text AS id) note`, [id]);
				expect(Number(rows[0].time)).toBe(timestamp);
				const now = Date.now();
				for (const threshold of [0, -1, -86400, Math.floor(timestamp / 1000) - 1, Math.ceil(timestamp / 1000) + 1]) {
					const actual = await db.query(`SELECT ${sql} <= CASE WHEN $2::bigint > 0 THEN $2::bigint * 1000 ELSE $3::bigint + $2::bigint * 1000 END AS hidden FROM (SELECT $1::text AS id) note`, [id, threshold, now]);
					expect(actual[0].hidden).toBe(shouldHideNoteByTime(threshold, new Date(timestamp)));
				}
			}
		});
	}
});
