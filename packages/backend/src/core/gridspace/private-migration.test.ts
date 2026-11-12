/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { DataSource } from 'typeorm';
import { loadConfig } from '@/config.js';

test('private-read migration preserves existing links without granting consent, and rolls back', async () => {
	const config = loadConfig();
	const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db });
	await db.initialize();
	const runner = db.createQueryRunner();
	await runner.connect();
	await runner.startTransaction();
	try {
		// Temporary tables shadow any real tables on this connection only.
		await runner.query('CREATE TEMP TABLE gridspace_link (id text PRIMARY KEY)');
		await runner.query('CREATE TEMP TABLE gridspace_auth_session (id text PRIMARY KEY)');
		await runner.query("INSERT INTO gridspace_link VALUES ('existing-link')");
		await runner.query("INSERT INTO gridspace_auth_session VALUES ('existing-session')");
		const module = await import(pathToFileURL(resolve('migration/1794457466799-GridspacePrivateRead.js')).href);
		const migration = new module.GridspacePrivateRead1794457466799();
		await migration.up(runner);
		expect(await runner.query('SELECT * FROM gridspace_link')).toEqual([{ id: 'existing-link', privateTokenCipher: null, privateRevocationCipher: null, privateTokenHash: null }]);
		expect(await runner.query('SELECT * FROM gridspace_auth_session')).toEqual([{ id: 'existing-session', purpose: 'link' }]);
		await migration.down(runner);
		expect(await runner.query('SELECT * FROM gridspace_link')).toEqual([{ id: 'existing-link' }]);
		expect(await runner.query('SELECT * FROM gridspace_auth_session')).toEqual([{ id: 'existing-session' }]);
		await migration.up(runner);
		expect((await runner.query('SELECT "privateTokenCipher" FROM gridspace_link'))[0].privateTokenCipher).toBeNull();
	} finally {
		await runner.rollbackTransaction();
		await runner.release();
		await db.destroy();
	}
});

test('mutual-read migration preserves directional consent and revokes paired consent on rollback', async () => {
	const config = loadConfig();
	const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db });
	await db.initialize();
	const runner = db.createQueryRunner();
	await runner.connect();
	await runner.startTransaction();
	try {
		await runner.query('CREATE TEMP TABLE gridspace_link (id text PRIMARY KEY, "privateTokenHash" text, "privateTokenCipher" text)');
		await runner.query('CREATE TEMP TABLE gridspace_auth_session (id text PRIMARY KEY, purpose varchar(16))');
		await runner.query("INSERT INTO gridspace_link VALUES ('directional', 'hash', 'cipher'), ('paired', 'hash', 'cipher')");
		await runner.query("INSERT INTO gridspace_auth_session VALUES ('old', 'private'), ('new', 'private-mutual')");
		const module = await import(pathToFileURL(resolve('migration/1794458897215-GridspaceMutualRead.js')).href);
		const migration = new module.GridspaceMutualRead1794458897215();
		await migration.up(runner);
		expect((await runner.query('SELECT "privateMutualGrantId", "privateMutualReady", "privateRevision" FROM gridspace_link WHERE id=\'directional\''))[0]).toEqual({ privateMutualGrantId: null, privateMutualReady: false, privateRevision: 0 });
		await runner.query('UPDATE gridspace_link SET "privateMutualGrantId"=\'00000000-0000-4000-8000-000000000001\', "privateMutualReady"=true WHERE id=\'paired\'');
		await migration.down(runner);
		expect(await runner.query('SELECT * FROM gridspace_link ORDER BY id')).toEqual([
			{ id: 'directional', privateTokenHash: 'hash', privateTokenCipher: 'cipher' },
			{ id: 'paired', privateTokenHash: null, privateTokenCipher: null },
		]);
		expect(await runner.query('SELECT * FROM gridspace_auth_session')).toEqual([{ id: 'old', purpose: 'private' }]);
		await migration.up(runner);
	} finally {
		await runner.rollbackTransaction();
		await runner.release();
		await db.destroy();
	}
});
