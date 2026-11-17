/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, test } from 'vitest';
import { loadConfig } from '@/config.js';
import { GridspaceTimelineIndex1794875013623 } from '../../../../migration/1794875013623-gridspace-timeline-index.js';
import { GridspaceTimelinePolicyChanges1794925728206 } from '../../../../migration/1794925728206-GridspaceTimelinePolicyChanges.js';

test('policy triggers ignore unchanged privacy and usage metadata but retain real invalidations and rollback', async () => {
	const config = loadConfig().db;
	const db = new Client({ host: config.host, port: config.port, user: config.user, password: config.pass, database: config.db });
	await db.connect();
	try {
		await db.query('BEGIN');
		const schema = `timeline_policy_${randomUUID().replaceAll('-', '')}`;
		await db.query(`CREATE SCHEMA ${schema}`);
		await db.query(`SET LOCAL search_path TO ${schema}, public`);
		await db.query('CREATE TABLE gridspace_timeline_outbox (kind text, "affectedUserId" text)');
		await db.query('CREATE TABLE "user" (id text, "lastFetchedAt" timestamptz, "isSuspended" boolean, "isDeleted" boolean, "requireSigninToViewContents" boolean, "makeNotesHiddenBefore" integer, "makeNotesFollowersOnlyBefore" integer)');
		await db.query('CREATE TABLE role (id text, "lastUsedAt" timestamptz, "updatedAt" timestamptz, policies jsonb)');
		await db.query('CREATE TABLE meta (id text, "blockedHosts" jsonb)');
		await db.query("INSERT INTO \"user\" VALUES ('actor',now(),false,false,false,null,null)");
		await db.query("INSERT INTO role VALUES ('role',now(),now(),'{}')");
		await db.query("INSERT INTO meta VALUES ('meta','[]')");
		const statements: string[] = [];
		await new GridspaceTimelineIndex1794875013623().up({ query: async (sql: string) => { statements.push(sql); } });
		for (const prefix of ['CREATE FUNCTION gridspace_timeline_audience_event', 'CREATE TRIGGER "gridspace_timeline_author_policy"', 'CREATE TRIGGER "gridspace_timeline_role_policy"', 'CREATE TRIGGER "gridspace_timeline_blocked_hosts"']) {
			await db.query(statements.find(sql => sql.startsWith(prefix))!);
		}
		const profile = 'UPDATE "user" SET "lastFetchedAt"=now(), "requireSigninToViewContents"=false, "makeNotesHiddenBefore"=null, "makeNotesFollowersOnlyBefore"=null';
		await db.query(profile);
		expect((await db.query('SELECT * FROM gridspace_timeline_outbox')).rows).toEqual([{ kind: 'reset', affectedUserId: null }]);
		await db.query('TRUNCATE gridspace_timeline_outbox');
		const migration = new GridspaceTimelinePolicyChanges1794925728206();
		const runner = { query: (sql: string) => db.query(sql) };
		await migration.up(runner);
		await db.query(profile);
		await db.query('UPDATE role SET "lastUsedAt"=now(), "updatedAt"=now()');
		await db.query("UPDATE meta SET \"blockedHosts\"='[]'");
		expect((await db.query('SELECT * FROM gridspace_timeline_outbox')).rows).toEqual([]);
		for (const sql of [
			'UPDATE "user" SET "requireSigninToViewContents"=true',
			'UPDATE "user" SET "isSuspended"=true',
			'UPDATE "user" SET "makeNotesHiddenBefore"=-3600',
			`UPDATE role SET policies='{"canSearchNotes":false}'`,
			`UPDATE meta SET "blockedHosts"='["blocked.example"]'`,
		]) {
			await db.query(sql);
			expect((await db.query('SELECT * FROM gridspace_timeline_outbox')).rows).toEqual([{ kind: 'reset', affectedUserId: null }]);
			await db.query('TRUNCATE gridspace_timeline_outbox');
		}
		await migration.down(runner);
		await db.query('UPDATE role SET "lastUsedAt"=now()');
		expect((await db.query('SELECT * FROM gridspace_timeline_outbox')).rows).toEqual([{ kind: 'reset', affectedUserId: null }]);
	} finally {
		await db.query('ROLLBACK');
		await db.end();
	}
});
