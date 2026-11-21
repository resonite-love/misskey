/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { loadConfig } from '@/config.js';
import { MiNote } from '@/models/Note.js';
import { entities } from '@/postgres.js';
import { NotePlacementService, type PlacementMap, type PackedChannelPlacement } from './NotePlacementService.js';

const config = loadConfig();
const schema = 'reply_chips_' + randomUUID().replaceAll('-', '');
const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db,
	schema, extra: { options: `-c search_path=${schema},public` }, entities });
const origin = 'https://origin.example';
const chip: PackedChannelPlacement = { origin, canonicalUri: origin + '/notes/root', channelId: 'one', name: 'Channel', color: '#112233', state: 'active',
	placementId: randomUUID(), canRemove: true, canRetry: true };
const direct = vi.fn(async (ids: string[]): Promise<PlacementMap> => {
	const map: PlacementMap = new Map(ids.filter(id => id === 'root').map(id => [id, [chip, { ...chip, channelId: 'removed', state: 'removed' }]]));
	map.rootNoteIds = new Set(['root']);
	return map;
});
const search = { noteQuery: (viewer: { id: string } | null) => db.getRepository(MiNote).createQueryBuilder('note')
	.where(':rootReadable = true', { rootReadable: viewer?.id !== 'blocked' }) };
const service = Object.assign(Object.create(NotePlacementService.prototype), { db, config: { url: origin }, moduleRef: { get: () => search }, packDirect: direct }) as NotePlacementService;

beforeAll(async () => {
	await db.initialize();
	await db.query(`CREATE SCHEMA "${schema}"`);
	await db.query(`CREATE TABLE note (id varchar(32) PRIMARY KEY, uri text, "includeDefault" boolean, "multiNoteKind" text, "multiNoteRootId" varchar(32), "threadId" varchar(32))`);
	await db.query(`CREATE TABLE note_channel_placement (id uuid DEFAULT gen_random_uuid(), "noteId" varchar(32), "channelId" varchar(32), state text)`);
	await db.query(`INSERT INTO note VALUES
		('root',NULL,false,'root',NULL,NULL), ('mixed',NULL,true,'root',NULL,NULL),
		('child',NULL,false,'conversation-reply','root','root'), ('nested',NULL,false,'conversation-reply','root','root'),
		('invalid',NULL,false,'conversation-reply','root','other'), ('mixedChild',NULL,false,'conversation-reply','mixed','mixed')`);
	await db.query("INSERT INTO note_channel_placement (\"noteId\",\"channelId\",state) VALUES ('root','one','active'), ('root','two','active'), ('root','removed','removed')");
});

afterAll(async () => {
	if (!db.isInitialized) return;
	await db.query(`DROP SCHEMA "${schema}" CASCADE`);
	await db.destroy();
});

test('existing and nested replies show active inherited chips without root management privileges', async () => {
	const result = await service.pack(['child', 'nested']);
	expect([...result.keys()].sort()).toEqual(['child', 'nested']);
	for (const id of ['child', 'nested']) {
		expect(result.get(id)).toEqual([{ ...chip, canonicalUri: origin + '/notes/' + id, placementId: undefined, canRemove: false, canRetry: false }]);
		expect(result.rootNoteIds?.has(id)).toBe(false);
	}
	expect(chip.canRemove).toBe(true);
	expect(await service.activeLocalChannelIds({ id: 'child', channelId: null, multiNoteKind: 'conversation-reply' })).toEqual(['one', 'two']);
	expect(await service.activeLocalChannelIds({ id: 'invalid', channelId: null, multiNoteKind: 'conversation-reply' })).toEqual([]);
	expect(await service.activeLocalChannelIds({ id: 'mixedChild', channelId: null, multiNoteKind: 'conversation-reply' })).toEqual([]);
});

test('a denied root hides inherited chips and excludes nested replies even when the root is also packed', async () => {
	const viewer = { id: 'blocked' };
	const result = await service.pack(['root', 'nested'], viewer);
	expect(result.get('nested')).toEqual([]);
	const query = db.getRepository(MiNote).createQueryBuilder('note').select('note.id', 'id')
		.where('note.id IN (:...ids)', { ids: ['mixed', 'nested'] });
	service.filterConversationRoot(query, viewer);
	expect(await query.getRawMany()).toEqual([{ id: 'mixed' }]);
});

test('inherits current root policy failures instead of stale or removed chips', async () => {
	direct.mockImplementationOnce(async () => {
		const result: PlacementMap = new Map(); result.unavailableNoteIds = new Set(['root']); return result;
	});
	const result = await service.pack(['child']);
	expect(result.get('child')).toEqual([]);
	expect(result.unavailableNoteIds?.has('child')).toBe(true);
	await db.query("UPDATE note_channel_placement SET state='removed' WHERE \"noteId\"='root'");
	expect(await service.activeLocalChannelIds({ id: 'child', channelId: null, multiNoteKind: 'conversation-reply' })).toEqual([]);
	await db.query("DELETE FROM note WHERE id='root'");
	expect((await service.pack(['child'])).get('child')).toBeUndefined();
});
