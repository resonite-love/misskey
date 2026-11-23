/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { DataSource, type SelectQueryBuilder } from 'typeorm';
import { loadConfig } from '@/config.js';
import type { MiNote } from '@/models/Note.js';
import { GridspaceHistoryService } from './GridspaceHistoryService.js';

const config = loadConfig();
const schema = `history_query_${randomUUID().replaceAll('-', '')}`;
const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user,
	password: config.db.pass, database: config.db.db, schema, extra: { options: `-c search_path=${schema},public`, max: 1 } });
const service = Object.assign(Object.create(GridspaceHistoryService.prototype), { db }) as GridspaceHistoryService;

beforeAll(async () => {
	await db.initialize();
	await db.query(`CREATE SCHEMA "${schema}"`);
	await db.query('CREATE TABLE note (id integer PRIMARY KEY, author text, visible boolean)');
	await db.query("INSERT INTO note VALUES (1, 'a', true), (2, 'a', true), (3, 'a', false), (4, 'b', true), (5, 'a', true)");
});

afterAll(async () => {
	if (db.isInitialized) { await db.query(`DROP SCHEMA "${schema}" CASCADE`); await db.destroy(); }
});

test('history ID reads preserve the visibility predicate, ordering and cursor, without changing pooled settings', async () => {
	const query = db.createQueryBuilder().select('note.id', 'id').from('note', 'note')
		.addSelect("current_setting('enable_bitmapscan')", 'bitmap')
		.where('note.author = :author AND note.visible AND note.id < :before', { author: 'a', before: 5 })
		.orderBy('note.id', 'DESC').limit(1) as SelectQueryBuilder<MiNote>;
	const before = await db.query("SHOW enable_bitmapscan");
	expect(await service['readPageIds'](query)).toEqual([{ id: 2, bitmap: 'off' }]);
	expect(await db.query('SHOW enable_bitmapscan')).toEqual(before);
	expect(await service['readPageIds'](query.clone().setParameter('before', 2))).toEqual([{ id: 1, bitmap: 'off' }]);
});

test('a failed history ID read rolls back and leaves the pooled connection usable', async () => {
	const query = db.createQueryBuilder().select('missing_column', 'id').from('note', 'note') as SelectQueryBuilder<MiNote>;
	const before = await db.query('SHOW enable_bitmapscan');
	await expect(service['readPageIds'](query)).rejects.toThrow();
	expect(await db.query('SHOW enable_bitmapscan')).toEqual(before);
	expect(await db.query('SELECT count(*)::int AS count FROM note')).toEqual([{ count: 5 }]);
});

test('a failed transaction start still releases its runner', async () => {
	const release = vi.fn();
	const runner = { startTransaction: async () => { throw new Error('unavailable'); }, isTransactionActive: false, release };
	const unavailable = Object.assign(Object.create(GridspaceHistoryService.prototype), { db: { createQueryRunner: () => runner } }) as GridspaceHistoryService;
	await expect(unavailable['readPageIds']({} as SelectQueryBuilder<MiNote>)).rejects.toThrow('unavailable');
	expect(release).toHaveBeenCalledOnce();
});
