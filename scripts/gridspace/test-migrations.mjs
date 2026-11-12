/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { GridspaceLink1794451421453 } from '../../packages/backend/migration/1794451421453-GridspaceLink.js';
import { GridspaceSessionGeneration1794451529407 } from '../../packages/backend/migration/1794451529407-GridspaceSessionGeneration.js';
import { GridspaceNotes1794452699504 } from '../../packages/backend/migration/1794452699504-GridspaceNotes.js';
import { GridspaceFollowExpansion1794471986795 } from '../../packages/backend/migration/1794471986795-GridspaceFollowExpansion.js';
import { GridspaceFollowDecision1794505839014 } from '../../packages/backend/migration/1794505839014-GridspaceFollowDecision.js';
import { loadSite } from './lab.mjs';

const site = loadSite('.', 0);
const require = createRequire(resolve('packages/backend/package.json'));
const { Client } = require('pg');
const password = readFileSync(resolve('.config/gridspace-lab.env'), 'utf8').match(/^GRIDSPACE_LAB_DB_PASSWORD=(.+)$/m)?.[1].trim();
assert.ok(password);
const connection = { host: site.config.db.host, port: site.config.db.port, user: site.config.db.user, password };
const admin = new Client({ ...connection, database: site.config.db.db });
// This disposable database never contains lab accounts or the running server's tables.
const database = `gridspace_migration_${randomBytes(8).toString('hex')}`;
await admin.connect();
await admin.query(`CREATE DATABASE "${database}"`);
const scratch = new Client({ ...connection, database });
try {
	await scratch.connect();
	await scratch.query('CREATE TABLE "user" (id varchar(32) PRIMARY KEY)');
	await scratch.query('CREATE TABLE "note" (id varchar(32) PRIMARY KEY)');
	const migrations = [new GridspaceLink1794451421453(), new GridspaceSessionGeneration1794451529407(), new GridspaceNotes1794452699504(), new GridspaceFollowExpansion1794471986795(), new GridspaceFollowDecision1794505839014()];
	for (const migration of migrations) await migration.up(scratch);
	for (const migration of [...migrations].reverse()) await migration.down(scratch);
	assert.equal((await scratch.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rowCount, 2);
	for (const migration of migrations) await migration.up(scratch);
	assert.equal((await scratch.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rowCount, 10);
	console.log('GridSpace migrations up/down/up PASS (isolated disposable database)');
} finally {
	await scratch.end();
	assert.match(database, /^gridspace_migration_[a-f0-9]{16}$/);
	await admin.query(`DROP DATABASE "${database}"`);
	await admin.end();
}
