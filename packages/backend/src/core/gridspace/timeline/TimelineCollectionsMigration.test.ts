/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { DataSource } from 'typeorm';
import { loadConfig } from '@/config.js';
import { GridspaceTimelineCollections1794876322733 } from '../../../../migration/1794876322733-GridspaceTimelineCollections.js';

const config = loadConfig();
const schema = `collection_events_${randomUUID().replaceAll('-', '')}`;
const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db,
	schema, extra: { options: `-c search_path=${schema},public` } });
const migration = new GridspaceTimelineCollections1794876322733();

beforeAll(async () => {
	await db.initialize(); await db.query(`CREATE SCHEMA "${schema}"`);
	await db.query('CREATE TABLE gridspace_timeline_outbox (kind text, "affectedUserId" text)');
	await db.query(`CREATE FUNCTION gridspace_timeline_audience_event() RETURNS trigger LANGUAGE plpgsql AS $body$
	BEGIN INSERT INTO gridspace_timeline_outbox VALUES ('reset', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ->> TG_ARGV[0] ELSE to_jsonb(NEW) ->> TG_ARGV[0] END); RETURN NULL; END $body$`);
	await db.query('CREATE TABLE note_favorite (id text, "userId" text, "noteId" text)');
	await db.query('CREATE TABLE clip (id text, "userId" text, "isPublic" boolean)');
	await db.query('CREATE TABLE clip_note (id text, "clipId" text, "noteId" text)');
	await db.query(`CREATE TABLE antenna (id text, "userId" text, src text, "userListId" text, keywords text, "excludeKeywords" text, users text, "caseSensitive" boolean, "withReplies" boolean, "withFile" boolean, expression text, "localOnly" boolean, "excludeBots" boolean, "excludeNotesInSensitiveChannel" boolean, "lastUsedAt" timestamp)`);
	await migration.up({ query: db.query.bind(db) });
});

afterAll(async () => {
	if (!db.isInitialized) return;
	await migration.down({ query: db.query.bind(db) });
	await db.query(`DROP SCHEMA "${schema}" CASCADE`); await db.destroy();
});

test('save/remove, clip membership and ACL, and antenna filter changes invalidate lists without last-used polling noise', async () => {
	await db.query("INSERT INTO note_favorite VALUES ('save', 'viewer', 'note')");
	await db.query("DELETE FROM note_favorite WHERE id = 'save'");
	await db.query("INSERT INTO clip VALUES ('clip', 'owner', false)");
	await db.query("INSERT INTO clip_note VALUES ('entry', 'clip', 'note')");
	await db.query("UPDATE clip SET \"isPublic\" = true WHERE id = 'clip'");
	await db.query("INSERT INTO antenna (id, \"userId\", keywords) VALUES ('antenna', 'viewer', 'old')");
	await db.query("UPDATE antenna SET \"lastUsedAt\" = now() WHERE id = 'antenna'");
	await db.query("UPDATE antenna SET keywords = 'new' WHERE id = 'antenna'");
	const events = await db.query('SELECT * FROM gridspace_timeline_outbox');
	expect(events).toHaveLength(6);
	expect(events.map((row: { affectedUserId: string | null }) => row.affectedUserId)).toEqual(['viewer', 'viewer', 'owner', null, 'owner', 'viewer']);
});
