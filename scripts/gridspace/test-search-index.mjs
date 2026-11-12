/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { sqlLikeEscape } from '../../packages/backend/src/misc/sql-like-escape.ts';

// No existing database is accepted: every run owns a disposable loopback-only container.
const require = createRequire(resolve('packages/backend/package.json'));
const { Client } = require('pg');
const name = `gridspace-search-index-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
let client;
try {
	execFileSync('docker', ['run', '--rm', '-d', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', 'groonga/pgroonga:4.0.2-alpine-15'], { stdio: ['ignore', 'pipe', 'pipe'] });
	const binding = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim();
	assert.match(binding, /^127\.0\.0\.1:\d+$/);
	const options = { host: '127.0.0.1', port: Number(binding.split(':')[1]), user: 'postgres', password, database: 'postgres' };
	for (let attempt = 0; attempt < 60; attempt++) {
		const candidate = new Client(options);
		try { await candidate.connect(); client = candidate; break; } catch { await candidate.end().catch(() => {}); await new Promise(done => setTimeout(done, 500)); }
	}
	assert.ok(client, 'Disposable PostgreSQL did not start');
	await client.query('CREATE EXTENSION pgroonga');
	await client.query('CREATE TABLE note (id text PRIMARY KEY, text text, cw varchar(512))');
	await client.query('CREATE INDEX test_note_text ON note USING pgroonga (text)');
	await client.query("INSERT INTO note SELECT i::text, 'unrelated text ' || i, NULL FROM generate_series(1,10000) i");
	await client.query('INSERT INTO note VALUES ($1,$2,$3),($4,$5,$6),($7,$8,$9)', ['body', 'やらかし', null, 'cw', 'other', 'やらかし', 'literal', '100%_Match', null]);
	process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY = '1';
	const { GridspaceCwSearchIndex1794495280418: Migration } = await import('../../packages/backend/migration/1794495280418-GridspaceCwSearchIndex.js');
	const migration = new Migration();
	const runner = { query: async (sql, params) => (await client.query(sql, params)).rows };
	assert.equal(migration.transaction, false);
	await migration.up(runner); await migration.up(runner);
	await client.query('ANALYZE note');
	const sql = 'SELECT id FROM note WHERE (text ILIKE $1 OR (cw IS NOT NULL AND cw::text ILIKE $1))';
	const match = async value => (await client.query(sql, [`%${sqlLikeEscape(value)}%`])).rows.map(row => row.id).sort();
	assert.deepEqual(await match('やらかし'), ['body', 'cw']);
	assert.deepEqual(await match('100%_match'), ['literal']);
	await client.query('SET enable_seqscan = off');
	const plan = JSON.stringify((await client.query('EXPLAIN (FORMAT JSON) ' + sql, ['%やらかし%'])).rows);
	assert.ok(plan.includes('IDX_GRIDSPACE_NOTE_CW_SEARCH') && plan.includes('test_note_text'), 'Both text and CW must support indexed matching');
	await migration.down(runner);
	assert.equal((await client.query(`SELECT to_regclass('"IDX_GRIDSPACE_NOTE_CW_SEARCH"') AS index`)).rows[0].index, null);
	await migration.up(runner);
	assert.deepEqual(await match('やらかし'), ['body', 'cw']);
	console.log('Concurrent CW index, idempotence, rollback/reapply, Unicode and escaped literal matching, indexed text+CW plan PASS');
	await client.query('DROP EXTENSION pgroonga CASCADE');
	await migration.up(runner);
	assert.equal((await client.query(`SELECT to_regclass('"IDX_GRIDSPACE_NOTE_CW_SEARCH"') AS index`)).rows[0].index, null);
	assert.deepEqual(await match('やらかし'), ['body', 'cw']);
	console.log('Optional extension absence preserves plain PostgreSQL search PASS');
} finally {
	await client?.end();
	execFileSync('docker', ['stop', name], { stdio: ['ignore', 'pipe', 'pipe'] });
}
