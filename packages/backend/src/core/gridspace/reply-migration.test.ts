/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { DataSource } from 'typeorm';
import { loadConfig } from '@/config.js';

test('reply receipt migration roundtrip revokes write tokens before discarding replay protection', async () => {
	const config = loadConfig();
	const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db });
	await db.initialize();
	const runner = db.createQueryRunner();
	await runner.connect();
	await runner.startTransaction();
	try {
		await runner.query('CREATE TEMP TABLE "user" (id varchar(32) PRIMARY KEY)');
		await runner.query('SET LOCAL search_path TO pg_temp');
		await runner.query('CREATE TABLE access_token (id text, permission varchar[])');
		await runner.query('CREATE TABLE gridspace_auth_session (purpose varchar(16))');
		await runner.query("INSERT INTO access_token VALUES ('reader', ARRAY['read:gridspace-private']), ('writer', ARRAY['read:gridspace-private','write:gridspace-reply'])");
		await runner.query("INSERT INTO gridspace_auth_session VALUES ('private'), ('private-reply')");
		const module = await import(pathToFileURL(resolve('migration/1794466348204-GridspaceReplyReceipt.js')).href);
		const migration = new module.GridspaceReplyReceipt1794466348204();
		await migration.up(runner);
		await runner.query("INSERT INTO \"user\" VALUES ('old')");
		await runner.query("INSERT INTO gridspace_reply_receipt VALUES ('old','00000000-0000-4000-8000-000000000001','hash','deleted-note')");
		expect((await runner.query('SELECT * FROM gridspace_reply_receipt')).length).toBe(1);
		await migration.down(runner);
		expect(await runner.query('SELECT id FROM access_token')).toEqual([{ id: 'reader' }]);
		expect(await runner.query('SELECT purpose FROM gridspace_auth_session')).toEqual([{ purpose: 'private' }]);
		await migration.up(runner);
		expect(await runner.query('SELECT * FROM gridspace_reply_receipt')).toEqual([]);
	} finally {
		await runner.rollbackTransaction();
		await runner.release();
		await db.destroy();
	}
});
