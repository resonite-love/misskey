/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { DataSource } from 'typeorm';
import { loadConfig } from '@/config.js';
import { IdService } from '@/core/IdService.js';
import type { GlobalEventService } from '@/core/GlobalEventService.js';
import { TimelineReferenceService } from '@/core/gridspace/timeline/TimelineReferenceService.js';
import { MiGridspaceTimelineChange, MiGridspaceTimelineOutbox, MiGridspaceTimelineState } from '@/models/GridspaceTimeline.js';
import { recordPlacementChange } from '@/core/gridspace/timeline/placement-change.js';
import { MultiNotePlacement1795200720406 } from '../../migration/1795200720406-multi-note-placement.js';
import { GridspaceTimelineIndex1794875013623 } from '../../migration/1794875013623-gridspace-timeline-index.js';

describe('TimelineReferenceService committed changes', () => {
	const config = loadConfig();
	const schema = `timeline_${randomUUID().replaceAll('-', '')}`;
	let db: DataSource;
	let service: TimelineReferenceService;

	beforeAll(async () => {
		db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port,
			username: config.db.user, password: config.db.pass, database: config.db.db, schema,
			extra: { options: `-c search_path=${schema},public` },
			entities: [MiGridspaceTimelineOutbox, MiGridspaceTimelineChange, MiGridspaceTimelineState] });
		await db.initialize();
		await db.query(`CREATE SCHEMA "${schema}"`);
		await db.query(`CREATE TABLE note (id varchar(32) PRIMARY KEY, uri varchar(512), text text, cw text, visibility text, "visibleUserIds" text[], "fileIds" text[], "userId" varchar(32), "channelId" varchar(32), mentions text[], "replyId" varchar(32), "renoteId" varchar(32))`);
		await db.query(`CREATE TABLE "user" (id varchar(32), "isSuspended" boolean, "isDeleted" boolean, "requireSigninToViewContents" boolean, "makeNotesHiddenBefore" integer, "makeNotesFollowersOnlyBefore" integer)`);
		for (const table of ['role', 'following', 'muting', 'renote_muting', 'blocking', 'channel_following', 'channel_muting', 'user_list_membership', 'role_assignment', 'gridspace_link']) await db.query(`CREATE TABLE "${table}" (id varchar(32))`);
		await db.query(`CREATE TABLE note_thread_muting (id varchar(32), "userId" varchar(32))`);
		await db.query(`CREATE TABLE user_profile ("userId" varchar(32), "mutedInstances" text[])`);
		await db.query(`CREATE TABLE meta ("blockedHosts" text[])`);
		await db.query(`CREATE TABLE channel ("isSensitive" boolean)`);
		await new GridspaceTimelineIndex1794875013623().up({ query: db.query.bind(db) });
		await new MultiNotePlacement1795200720406().up({ query: (sql: string) =>
			sql.includes('gridspace_timeline_') ? db.query(sql) : Promise.resolve() });
		service = new TimelineReferenceService(db, config, new IdService(config), { publishInternalEvent: () => {} } as unknown as GlobalEventService);
	});

	beforeEach(async () => {
		await db.getRepository(MiGridspaceTimelineChange).clear();
		await db.getRepository(MiGridspaceTimelineOutbox).clear();
		await db.getRepository(MiGridspaceTimelineState).clear();
		await db.getRepository(MiGridspaceTimelineState).insert({ key: 'changes' });
	});

	afterAll(async () => {
		if (!db?.isInitialized) return;
		await new GridspaceTimelineIndex1794875013623().down({ query: db.query.bind(db) });
		await db.query(`DROP SCHEMA "${schema}" CASCADE`);
		await db.destroy();
	});

	test('replayed placement events keep their canonical origin, channel and revisions without skipping a sequence', async () => {
		const event = { kind: 'place-remove' as const, channelOrigin: config.url, channelId: 'target', canonicalUri: 'https://other.example/notes/42',
			sourceRevision: 1, targetRevision: 2, eventId: randomUUID() };
		for (let i = 0; i < 2; i++) {
			await db.transaction(manager => recordPlacementChange(manager, event));
			await service.drainChanges();
		}
		const page = await service.changes('0');
		expect(page.events).toHaveLength(1);
		expect(page.events[0]).toMatchObject({ ...event, sourceRevision: '1', targetRevision: '2', noteId: null, sequence: '1' });
		expect(page.resetRequired).toBe(false);
	});
	test('migration matches TypeORM entities', async () => {
		const pending = await db.driver.createSchemaBuilder().log();
		expect(pending.upQueries.map(query => query.query)).toEqual([]);
		expect(pending.downQueries.map(query => query.query)).toEqual([]);
	});

	test('database triggers record direct writes and roll back with the note', async () => {
		await expect(db.transaction(async manager => {
			await manager.query(`INSERT INTO note (id, uri) VALUES ('rollback', 'https://example.com/rollback')`);
			throw new Error('rollback');
		})).rejects.toThrow('rollback');
		expect(await service.currentPosition()).toBe('0');
		await db.query(`INSERT INTO note (id, uri) VALUES ('trigger', 'https://example.com/trigger')`);
		await db.query(`UPDATE note SET text = 'changed' WHERE id = 'trigger'`);
		await db.query(`DELETE FROM note WHERE id = 'trigger'`);
		const events = (await service.changes('0')).events;
		expect(events.map(value => value.kind)).toEqual(['insert', 'update', 'remove']);
		expect(events.every(value => value.canonicalUri === 'https://example.com/trigger')).toBe(true);
	});

	test('thread and policy changes invalidate consumed or skipped candidates', async () => {
		await db.query(`INSERT INTO note_thread_muting (id, "userId") VALUES ('thread', 'viewer')`);
		await db.query(`DELETE FROM note_thread_muting WHERE id = 'thread'`);
		await db.query(`INSERT INTO user_profile ("userId", "mutedInstances") VALUES ('viewer', '{}')`);
		await db.query(`UPDATE user_profile SET "mutedInstances" = '{example.com}' WHERE "userId" = 'viewer'`);
		await db.query(`INSERT INTO meta ("blockedHosts") VALUES ('{}')`);
		await db.query(`UPDATE meta SET "blockedHosts" = '{example.com}'`);
		await db.query(`INSERT INTO channel ("isSensitive") VALUES (false)`);
		await db.query(`UPDATE channel SET "isSensitive" = true`);
		const events = (await service.changes('0')).events;
		expect(events).toHaveLength(5);
		expect(events.every(value => value.kind === 'reset')).toBe(true);
		expect(events.map(value => value.affectedUserId)).toEqual(['viewer', 'viewer', 'viewer', null, null]);
	});

	const event = (noteId: string) => ({ noteId, canonicalUri: `https://example.com/notes/${noteId}`, kind: 'insert', affectedUserId: null });

	test('an older uncommitted outbox row gets a later sequence after committing', async () => {
		const delayed = db.createQueryRunner();
		await delayed.connect();
		await delayed.startTransaction();
		try {
			await delayed.manager.getRepository(MiGridspaceTimelineOutbox).insert({ ...event('delayed'), createdAt: new Date('2000-01-01') });
			await db.getRepository(MiGridspaceTimelineOutbox).insert(event('committed'));
			expect(await service.currentPosition()).toBe('1');
			expect((await service.changes('0')).events.map(value => value.noteId)).toEqual(['committed']);
			await delayed.commitTransaction();
			expect(await service.currentPosition()).toBe('2');
			expect((await service.changes('1')).events.map(value => value.noteId)).toEqual(['delayed']);
		} finally {
			if (delayed.isTransactionActive) await delayed.rollbackTransaction();
			await delayed.release();
		}
	});

	test('concurrent sequencers deliver each event once and preserve a contiguous cursor', async () => {
		await db.getRepository(MiGridspaceTimelineOutbox).insert(Array.from({ length: 101 }, (_, index) => event(String(index))));
		await Promise.all([service.drainChanges(60), service.drainChanges(60)]);
		const first = await service.changes('0', 100);
		expect(first.events).toHaveLength(100);
		expect(first.cursor).toBe('100');
		expect(first.hasMore).toBe(true);
		const second = await service.changes(first.cursor, 100);
		expect(second.events).toHaveLength(1);
		expect(second.cursor).toBe('101');
		expect(new Set([...first.events, ...second.events].map(value => value.noteId)).size).toBe(101);
	});

	test('expired cursors reset even when pruning removed every row', async () => {
		await db.getRepository(MiGridspaceTimelineOutbox).insert(event('old'));
		await service.currentPosition();
		await db.query(`UPDATE "gridspace_timeline_change" SET "createdAt" = now() - interval '25 hours'`);
		await service.pruneChanges();
		expect(await db.getRepository(MiGridspaceTimelineChange).count()).toBe(0);
		expect(await service.changes('0')).toMatchObject({ resetRequired: true, cursor: '1' });
		expect(await service.changes('1')).toMatchObject({ resetRequired: false, cursor: '1' });
	});

	test('rolling back a content change also rolls back its outbox row', async () => {
		await expect(db.transaction(async manager => {
			await manager.getRepository(MiGridspaceTimelineOutbox).insert(event('rollback'));
			throw new Error('rollback');
		})).rejects.toThrow('rollback');
		expect(await service.currentPosition()).toBe('0');
		expect((await service.changes('0')).events).toEqual([]);
	});
});
