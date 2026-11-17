/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { loadConfig } from '@/config.js';
import { TimelineReferenceService } from './TimelineReferenceService.js';
import { MiGridspaceTimelineOutbox, MiGridspaceTimelineChange, MiGridspaceTimelineState } from '@/models/GridspaceTimeline.js';
import { GridspaceTimelineInvalidation1794882992056 } from '../../../../migration/1794882992056-GridspaceTimelineInvalidation.js';

const config = loadConfig();
const schema = `timeline_notify_${randomUUID().replaceAll('-', '')}`;
const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user,
	password: config.db.pass, database: config.db.db, schema, entities: [MiGridspaceTimelineOutbox, MiGridspaceTimelineChange, MiGridspaceTimelineState], extra: { options: `-c search_path=${schema},public` } });
const listener = new pg.Client({ host: config.db.host, port: config.db.port, user: config.db.user,
	password: config.db.pass, database: config.db.db });
const migration = new GridspaceTimelineInvalidation1794882992056();
const notifications: string[] = [];

beforeAll(async () => {
	await db.initialize(); await db.query(`CREATE SCHEMA "${schema}"`);
	await db.query('CREATE TABLE gridspace_timeline_outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "canonicalUri" varchar(1024), "noteId" varchar(32), kind varchar(16) NOT NULL, "affectedUserId" varchar(32), "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp())');
	await db.query('CREATE TABLE gridspace_timeline_change (sequence bigint PRIMARY KEY, "canonicalUri" varchar(1024), "noteId" varchar(32), kind varchar(16), "affectedUserId" varchar(32), "createdAt" timestamptz)');
	await db.query('CREATE TABLE gridspace_timeline_state (key varchar(32) PRIMARY KEY, generation integer NOT NULL DEFAULT 1, "nextSequence" bigint NOT NULL DEFAULT 0, "trimmedThrough" bigint NOT NULL DEFAULT 0)');
	await db.query("INSERT INTO gridspace_timeline_state (key) VALUES ('changes')");
	await db.query('CREATE TABLE access_token ("userId" text, permission text[])');
	await db.query(`CREATE FUNCTION gridspace_timeline_audience_event() RETURNS trigger LANGUAGE plpgsql AS $body$
	BEGIN INSERT INTO gridspace_timeline_outbox (kind) VALUES ('reset'); RETURN NULL; END $body$`);
	await migration.up({ query: db.query.bind(db) });
	await listener.connect();
	listener.on('notification', message => { notifications.push(message.payload ?? ''); });
	await listener.query('LISTEN gridspace_timeline_changed');
});

afterAll(async () => {
	await listener.end();
	if (!db.isInitialized) return;
	await migration.down({ query: db.query.bind(db) });
	await db.query(`DROP SCHEMA "${schema}" CASCADE`); await db.destroy();
});

test('policy wakeups contain no data and only arrive after a successful commit', async () => {
	const transaction = db.createQueryRunner(); await transaction.connect();
	try {
		await transaction.startTransaction();
		await transaction.query("INSERT INTO gridspace_timeline_outbox (kind) VALUES ('reset')");
		await new Promise(resolve => setTimeout(resolve, 40));
		expect(notifications).toEqual([]);
		await transaction.rollbackTransaction();
		await new Promise(resolve => setTimeout(resolve, 40));
		expect(notifications).toEqual([]);
		await transaction.startTransaction();
		await transaction.query("INSERT INTO gridspace_timeline_outbox (kind) VALUES ('reset')");
		await transaction.commitTransaction();
		await vi.waitFor(() => expect(notifications).toEqual(['']));
	} finally { await transaction.release(); }
});

test('revoking OAuth read permission wakes the same policy channel', async () => {
	await db.query("INSERT INTO access_token VALUES ('viewer', ARRAY['read:notes'])");
	const before = notifications.length;
	await db.query("UPDATE access_token SET permission = '{}' WHERE \"userId\" = 'viewer'");
	await vi.waitFor(() => expect(notifications.length).toBe(before + 1));
});

test('a committed policy change wakes the server listener and reaches local and peer streams', async () => {
	await db.query('TRUNCATE gridspace_timeline_outbox');
	const publishInternalEvent = vi.fn(); const notifyChanges = vi.fn(); const invalidate = vi.fn();
	const service = new TimelineReferenceService(db, { ...config, db: { ...config.db, extra: { options: `-c search_path=${schema},public` } } }, {} as never,
		{ publishInternalEvent } as never, { invalidate } as never, { notifyChanges } as never);
	try {
		await service['listen']();
		await db.query("INSERT INTO gridspace_timeline_outbox (kind) VALUES ('reset')");
		await vi.waitFor(() => expect(notifyChanges).toHaveBeenCalledOnce());
		expect(publishInternalEvent).toHaveBeenLastCalledWith('gridspaceTimelineChanged', { sequence: expect.stringMatching(/^\d+$/) });
		expect(invalidate).toHaveBeenCalledOnce();
		await db.query("INSERT INTO gridspace_timeline_outbox (kind) VALUES ('insert')");
		await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
		expect(notifyChanges).toHaveBeenCalledOnce();
	} finally { await service.onApplicationShutdown(); }
});

test('a policy change after a full batch is drained without waiting for another database wakeup', async () => {
	await db.query('TRUNCATE gridspace_timeline_outbox');
	const notifyChanges = vi.fn();
	const service = new TimelineReferenceService(db, { ...config, db: { ...config.db, extra: { options: `-c search_path=${schema},public` } } }, {} as never,
		{ publishInternalEvent: vi.fn() } as never, { invalidate: vi.fn() } as never, { notifyChanges } as never);
	try {
		await service['listen']();
		await db.transaction(async manager => {
			await manager.query("INSERT INTO gridspace_timeline_outbox (kind, \"createdAt\") SELECT 'insert', now() - interval '1 second' FROM generate_series(1, 1000)");
			await manager.query("INSERT INTO gridspace_timeline_outbox (kind) VALUES ('reset')");
		});
		await vi.waitFor(() => expect(notifyChanges).toHaveBeenCalledOnce());
		const [{ count }] = await db.query('SELECT count(*) AS count FROM gridspace_timeline_outbox');
		expect(Number(count)).toBe(0);
	} finally { await service.onApplicationShutdown(); }
});
