/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { DataSource } from 'typeorm';
import { loadConfig } from '@/config.js';

const config = loadConfig();
const schema = `drive_url_index_${randomUUID().replaceAll('-', '')}`;
const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user,
	password: config.db.pass, database: config.db.db, schema, extra: { options: `-c search_path=${schema},public`, max: 1 } });

beforeAll(async () => {
	await db.initialize();
	await db.query(`CREATE SCHEMA "${schema}"`);
	await db.query('CREATE TABLE drive_file (url varchar(1024), md5 varchar(32))');
	await db.query("INSERT INTO drive_file SELECT 'https://example.test/' || n, md5(n::text) FROM generate_series(1,10000) n");
});

afterAll(async () => {
	if (db.isInitialized) { await db.query(`DROP SCHEMA "${schema}" CASCADE`); await db.destroy(); }
});

test('concurrent URL hash index preserves exact matches, supports long URLs and rolls back/reapplies', async () => {
	const previous = process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY;
	process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY = '1';
	try {
		const { DriveFileUrlHashIndex1795434589863: Migration } = await import('../../../migration/1795434589863-DriveFileUrlHashIndex.js');
		const migration = new Migration();
		expect(migration.transaction).toBe(false);
		const runner = db.createQueryRunner();
		try {
			await migration.up(runner);
			await migration.up(runner);
			const url = 'https://example.test/' + '猫'.repeat(1000);
			await runner.query('INSERT INTO drive_file VALUES ($1, $2), ($1, $3)', [url, 'one', 'two']);
			const matches = () => runner.query('SELECT md5 FROM drive_file WHERE url = ANY($1::varchar[]) ORDER BY md5', [[url, 'missing']]);
			expect(await matches()).toEqual([{ md5: 'one' }, { md5: 'two' }]);
			await runner.query('SET enable_seqscan=off');
			const plan = await runner.query('EXPLAIN (FORMAT JSON) SELECT md5 FROM drive_file WHERE url = ANY($1::varchar[])', [[url]]);
			expect(JSON.stringify(plan)).toContain('IDX_DRIVE_FILE_URL_HASH');
			await runner.query('RESET enable_seqscan');
			await migration.down(runner);
			expect(await matches()).toEqual([{ md5: 'one' }, { md5: 'two' }]);
			await migration.up(runner);
			expect(await matches()).toEqual([{ md5: 'one' }, { md5: 'two' }]);
		} finally { await runner.release(); }
	} finally {
		if (previous == null) delete process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY;
		else process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY = previous;
	}
});
