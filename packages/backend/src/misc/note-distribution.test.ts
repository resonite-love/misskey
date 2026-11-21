/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { DataSource, type QueryRunner } from 'typeorm';
import { loadConfig } from '@/config.js';
import { MiGridspaceTimelineState, MiGridspaceTimelineChange } from '@/models/GridspaceTimeline.js';
import { TimelineReferenceService } from '@/core/gridspace/timeline/TimelineReferenceService.js';
import { includesDefault, noteListingCondition, type NoteListing } from './note-distribution.js';

const { db: config } = loadConfig();
const db = new DataSource({ type: 'postgres', host: config.host, port: config.port, username: config.user, password: config.pass, database: config.db, entities: [MiGridspaceTimelineState, MiGridspaceTimelineChange] });
let runner: QueryRunner;

beforeAll(async () => {
	await db.initialize();
	runner = db.createQueryRunner();
	await runner.connect();
	await runner.query(`
		CREATE TEMP TABLE note (id text, uri text, "fileIds" text[] DEFAULT ARRAY[]::text[], "includeDefault" boolean, "multiNoteKind" text, "channelId" text, "userId" text, "userHost" text, visibility text, "gridspaceShared" boolean, "localOnly" boolean);
		CREATE TEMP TABLE note_channel_placement ("noteId" text, "channelId" text, state text);
		CREATE TEMP TABLE gridspace_channel_placement ("channelId" text, "canonicalUri" text, state text, "includeDefault" boolean, id uuid DEFAULT gen_random_uuid());
		CREATE TEMP TABLE channel_placement_pin ("channelId" text, "canonicalUri" text, rank integer);
		CREATE TEMP TABLE gridspace_timeline_state (key text PRIMARY KEY, generation integer DEFAULT 1, "nextSequence" bigint DEFAULT 0, "trimmedThrough" bigint DEFAULT 0);
		CREATE TEMP TABLE gridspace_timeline_change (sequence bigint PRIMARY KEY, kind text, "noteId" text, "canonicalUri" text, "channelId" text, "channelOrigin" text);
		CREATE TEMP TABLE channel (id text, "isSensitive" boolean);
		CREATE TEMP TABLE channel_following ("followeeId" text, "followerId" text);
		CREATE TEMP TABLE channel_muting ("channelId" text, "userId" text, "expiresAt" timestamptz);
		CREATE TEMP TABLE following ("followeeId" text, "followerId" text);
		INSERT INTO channel VALUES ('a', false), ('b', false);
		INSERT INTO channel_following VALUES ('a', 'viewer'), ('b', 'viewer');
		INSERT INTO channel_muting VALUES ('b', 'viewer', null);
		INSERT INTO following VALUES ('followed', 'viewer');
		INSERT INTO note (id, "includeDefault", "multiNoteKind", "channelId", "userId", visibility) VALUES
			('both', true, 'root', null, 'followed', 'public'),
			('dedicated', false, 'root', null, 'other', 'public'),
			('legacy', null, null, 'a', 'other', 'public'),
			('muted', false, 'root', null, 'viewer', 'public'),
			('old', null, null, null, 'followed', 'public'),
			('placed', true, 'root', null, 'other', 'public'),
			('removed', false, null, 'a', 'viewer', 'public'),
			('reply', false, 'conversation-reply', null, 'viewer', 'public');
		INSERT INTO note_channel_placement VALUES ('both','a','active'), ('both','b','active'),
			('dedicated','a','active'), ('dedicated','b','active'), ('muted','b','active'), ('removed','a','removed'), ('placed','a','active');
	`);
});

afterAll(async () => {
	await runner?.release();
	if (db.isInitialized) await db.destroy();
});

async function notes(list: NoteListing) {
	const rows = await runner.manager.createQueryBuilder().select('note.id', 'id').from('note', 'note')
		.where(...noteListingCondition(list)).orderBy('note.id', 'ASC').getRawMany<{ id: string }>();
	return rows.map(row => row.id);
}

test('keeps ordinary, channel, home and profile routes separate, including legacy and removed placements', async () => {
	expect(await notes({ kind: 'default' })).toEqual(['both', 'old', 'placed']);
	expect(await notes({ kind: 'channel', channelId: 'a' })).toEqual(['both', 'dedicated', 'legacy', 'placed']);
	expect(await notes({ kind: 'home', viewerId: 'viewer', linkedUserId: null })).toEqual(['both', 'dedicated', 'legacy', 'old', 'placed']);
	expect(await notes({ kind: 'profile', viewerId: 'viewer' })).toEqual(['both', 'dedicated', 'legacy', 'old', 'placed']);
	await runner.query("UPDATE note_channel_placement SET state = 'removed' WHERE \"channelId\" = 'a'");
	expect(await notes({ kind: 'home', viewerId: 'viewer', linkedUserId: null })).toEqual(['both', 'legacy', 'old']);
	expect(await notes({ kind: 'channel', channelId: 'b' })).toEqual(['both', 'dedicated', 'muted']);
});

test('packed notes without new fields retain the old single-channel fallback', () => {
	expect(includesDefault({ channelId: null })).toBe(true);
	expect(includesDefault({ channelId: 'a' })).toBe(false);
	expect(includesDefault({ channelId: null, includeDefault: false })).toBe(false);
	expect(includesDefault({ channelId: null, includeDefault: true, multiNoteKind: 'conversation-reply' })).toBe(false);
});

test('sensitive channel placement keeps the existing profile discovery policy and the independent ordinary route', async () => {
	await runner.query("INSERT INTO channel VALUES ('sensitive', true)");
	await runner.query(`INSERT INTO note (id, "includeDefault", "multiNoteKind", "userId", visibility) VALUES
		('sensitiveOnly', false, 'root', 'author', 'public'), ('sensitiveBoth', true, 'root', 'author', 'public'),
		('sensitiveMixed', false, 'root', 'author', 'public')`);
	await runner.query(`INSERT INTO note_channel_placement VALUES
		('sensitiveOnly', 'sensitive', 'active'), ('sensitiveBoth', 'sensitive', 'active'),
		('sensitiveMixed', 'sensitive', 'active'), ('sensitiveMixed', 'a', 'active')`);
	const listed = async (list: NoteListing) => (await notes(list)).filter(id => id.startsWith('sensitive'));
	expect(await listed({ kind: 'channel', channelId: 'sensitive' })).toEqual(['sensitiveBoth', 'sensitiveMixed', 'sensitiveOnly']);
	expect(await listed({ kind: 'profile', viewerId: 'author' })).toEqual(['sensitiveBoth', 'sensitiveMixed', 'sensitiveOnly']);
	expect(await listed({ kind: 'profile', viewerId: 'viewer' })).toEqual(['sensitiveBoth', 'sensitiveMixed']);
	expect(await listed({ kind: 'default' })).toEqual(['sensitiveBoth']);
});

test('the legacy channel lists only a verified ordinary mirror for a live URI placement', async () => {
	const uri = 'https://peer.example/notes/one';
	const listed = () => notes({ kind: 'channel', channelId: 'remote-target' });
	await runner.query("INSERT INTO gridspace_channel_placement VALUES ('remote-target', $1, 'active', true)", [uri]);
	expect(await listed()).toEqual([]);
	const insert = (id: string, value: string, shared: boolean) => runner.query(
		'INSERT INTO note (id, uri, "includeDefault", "userHost", "gridspaceShared", visibility) VALUES ($1, $2, true, $3, $4, $5)',
		[id, value, 'peer.example', shared, 'public']);
	await insert('alias', uri + '/activity', false);
	expect(await listed()).toEqual([]);
	await runner.query('UPDATE note SET "gridspaceShared" = true WHERE id = $1', ['alias']);
	expect(await listed()).toEqual(['alias']);
	await insert('canonical', uri, true);
	expect(await listed()).toEqual(['canonical']);
	await runner.query('UPDATE gridspace_channel_placement SET "includeDefault" = false');
	expect(await listed()).toEqual([]);
	await runner.query("UPDATE gridspace_channel_placement SET state = 'removed', \"includeDefault\" = true");
	expect(await listed()).toEqual([]);
});

test('projects a placed ordinary mirror in either arrival order without rerunning ordinary note delivery', async () => {
	const cachePlacedMirror = vi.fn().mockResolvedValue(undefined);
	const publishPlacedChannelMirror = vi.fn().mockResolvedValue(undefined);
	const config = { url: 'https://local.example', gridspace: { enabled: true }, perChannelMaxNoteCacheCount: 40 };
	const service = new TimelineReferenceService({ transaction: runner.manager.transaction.bind(runner.manager) } as never, config as never,
		{} as never, { publishPlacedChannelMirror } as never, undefined, undefined, { cachePlacedMirror } as never,
		{ enableFanoutTimeline: true, perUserHomeTimelineCacheMax: 80 } as never);
	const place = (uri: string, channel: string) => runner.query(
		"INSERT INTO gridspace_channel_placement VALUES ($1, $2, 'active', true)", [channel, uri]);
	const mirror = (id: string, uri: string) => runner.query(
		'INSERT INTO note (id, uri, "includeDefault", "userHost", "gridspaceShared", visibility) VALUES ($1, $2, true, $3, true, $4)', [id, uri, 'peer.example', 'public']);
	const first = 'https://peer.example/notes/first';
	const second = 'https://peer.example/notes/second';
	await place(first, 'one');
	await mirror('second', second);
	await runner.query("INSERT INTO gridspace_timeline_change VALUES (1,'place-add',null,$1,'one',$2), (2,'insert','second',$3,null,null)", [first, config.url, second]);
	await service.projectPlacedMirrors();
	expect(publishPlacedChannelMirror).not.toHaveBeenCalled();
	await mirror('first', first);
	await place(second, 'two');
	await runner.query("INSERT INTO gridspace_timeline_change VALUES (3,'insert','first',$1,null,null), (4,'place-add',null,$2,'two',$3)", [first, second, config.url]);
	await service.projectPlacedMirrors();
	await service.projectPlacedMirrors();
	expect(cachePlacedMirror.mock.calls.map(args => args.slice(0, 2))).toEqual([['first', 'one'], ['second', 'two']]);
	expect(publishPlacedChannelMirror.mock.calls.map(args => args.slice(0, 2))).toEqual([['one', 'first'], ['two', 'second']]);
});
