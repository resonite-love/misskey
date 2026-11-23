/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { mockDeep } from 'vitest-mock-extended';
import type { ModuleRef } from '@nestjs/core';
import { loadConfig } from '@/config.js';
import { entities } from '@/postgres.js';
import type { MiLocalUser } from '@/models/User.js';
import { IdService } from '@/core/IdService.js';
import type { RoleService } from '@/core/RoleService.js';
import type { GlobalEventService } from '@/core/GlobalEventService.js';
import { GridspaceClipReferenceService } from './GridspaceClipReferenceService.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import { TimelineLocalSource } from './timeline/TimelineLocalSource.js';
import type { TimelineReference } from './timeline/timeline-protocol.js';
import { managedInputProperties, managedPeerSchema } from './managed-resource-protocol.js';

const config = loadConfig();
const schema = 'clip_refs_' + randomUUID().replaceAll('-', '');
const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db,
	schema, extra: { options: `-c search_path=${schema},public` }, entities });
const ids = new IdService({ ...config, id: 'aidx' });
const noteId = ids.gen(1700000000000), uri = 'https://g.example/notes/' + noteId;
const viewer = { id: 'owner' } as MiLocalUser;
const modules = mockDeep<ModuleRef>(), links = mockDeep<GridspaceLinkService>(), roles = mockDeep<RoleService>(), events = mockDeep<GlobalEventService>();
const reader = mockDeep<GridspacePrivateService>(), local = mockDeep<TimelineLocalSource>();
const service = new GridspaceClipReferenceService(db, { ...config, id: 'aidx', url: 'https://r.example', gridspace: { enabled: true, peerUrl: 'https://g.example' } } as never, modules, links, ids, roles, events);
const authorize = vi.fn(async () => {});

test('membership locators are available only on the signed internal API', () => {
	expect(managedInputProperties.action.enum).not.toContain('note-references');
	expect(managedPeerSchema.properties.action.enum).toContain('note-references');
});

beforeAll(async () => {
	await db.initialize();
	await db.query(`CREATE SCHEMA "${schema}"`);
	await db.query('CREATE TABLE clip (id varchar(32) PRIMARY KEY, "userId" varchar(32), "isPublic" boolean, "lastClippedAt" timestamptz)');
	await db.query('CREATE TABLE note (id varchar(32) PRIMARY KEY, uri varchar(512))');
	await db.query('CREATE TABLE clip_note (id varchar(32) PRIMARY KEY, "clipId" varchar(32), "noteId" varchar(32))');
	await db.query('CREATE TABLE gridspace_clip_reference (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, "clipId" varchar(32) REFERENCES clip(id) ON DELETE CASCADE, "canonicalUri" varchar(512) COLLATE "C", "noteId" varchar(32), "sortAt" timestamptz, UNIQUE("clipId", "canonicalUri"))');
});
afterAll(async () => { if (db.isInitialized) { await db.query(`DROP SCHEMA "${schema}" CASCADE`); await db.destroy(); } });
beforeEach(async () => {
	await db.query('TRUNCATE clip CASCADE'); await db.query('TRUNCATE clip_note, note');
	await db.query('INSERT INTO clip (id,"userId","isPublic") VALUES ($1,$2,false)', ['clip', viewer.id]);
	vi.resetAllMocks();
	modules.get.mockImplementation(((type: unknown) => type === GridspacePrivateService ? reader : type === TimelineLocalSource ? local : undefined) as never);
	reader.notes.mockResolvedValue({ notes: [{ id: noteId, uri }], validForMs: 45000 } as never);
	roles.getUserPolicies.mockResolvedValue({ noteEachClipsLimit: 2 } as never);
});

test('stores only a reference, counts duplicate membership, and removes after the original disappears', async () => {
	expect(await service.change(viewer, 'clip', uri, true, authorize)).toBeUndefined();
	expect((await db.query('SELECT * FROM gridspace_clip_reference'))[0]).toMatchObject({ clipId: 'clip', canonicalUri: uri, noteId });
	expect(await db.query('SELECT * FROM note')).toHaveLength(0);
	expect(await service.change(viewer, 'clip', uri, true, authorize)).toBe('already-added');
	reader.notes.mockRejectedValue(new Error('deleted'));
	await service.change(viewer, 'clip', uri, false, authorize);
	expect(await db.query('SELECT * FROM gridspace_clip_reference')).toHaveLength(0);
});

test('rejects inaccessible notes, foreign clips, and authorization revoked before commit', async () => {
	reader.notes.mockResolvedValueOnce({ notes: [] } as never);
	await expect(service.change(viewer, 'clip', uri, true, authorize)).rejects.toThrow();
	await expect(service.change({ id: 'other' } as MiLocalUser, 'clip', uri, true, authorize)).rejects.toThrow();
	await expect(service.change(viewer, 'clip', uri, true, async () => { throw new Error('revoked'); })).rejects.toThrow('revoked');
	expect(await db.query('SELECT * FROM gridspace_clip_reference')).toHaveLength(0);
});

test('includes native memberships in limits and duplicate checks', async () => {
	await db.query('INSERT INTO note VALUES ($1,$2)', ['native', uri]);
	await db.query('INSERT INTO clip_note VALUES ($1,$2,$3)', ['membership', 'clip', 'native']);
	expect(await service.change(viewer, 'clip', uri, true, authorize)).toBe('already-added');
	await db.query('UPDATE note SET uri=NULL');
	roles.getUserPolicies.mockResolvedValue({ noteEachClipsLimit: 1 } as never);
	expect(await service.change(viewer, 'clip', uri, true, authorize)).toBe('too-many');
});

test.each(['newest', 'oldest'] as const)('pages references with equal timestamps in %s order without gaps', async order => {
	const sameTime = [ids.gen(1700000000100), ids.gen(1700000000100), ids.gen(1700000000100)].sort();
	for (const id of sameTime) await db.query('INSERT INTO gridspace_clip_reference ("clipId","canonicalUri","noteId","sortAt") VALUES ($1,$2,$3,$4)', ['clip', 'https://g.example/notes/' + id, id, new Date(1700000000100)]);
	const first = await service.peerPage(viewer, 'clip', { external: true, limit: 2, order });
	const next = await service.peerPage(viewer, 'clip', { external: true, limit: 2, order, before: first.next! });
	expect([...first.references, ...next.references].map(ref => ref.noteId)).toEqual(order === 'oldest' ? sameTime : [...sameTime].reverse());
	await expect(service.peerPage({ id: 'other' } as MiLocalUser, 'clip', { external: true, limit: 2 })).rejects.toThrow();
});

test('time anchors include the saved note in either direction', async () => {
	await service.change(viewer, 'clip', uri, true, authorize);
	expect((await service.peerPage(viewer, 'clip', { external: true, limit: 2, untilAt: 1700000000000 })).references).toHaveLength(1);
	expect((await service.peerPage(viewer, 'clip', { external: true, limit: 2, order: 'oldest', fromAt: 1700000000000 })).references).toHaveLength(1);
});

test('hydrates original data with a lease, then removes revoked membership before returning', async () => {
	await service.change(viewer, 'clip', uri, true, authorize);
	const reference = { noteId, canonicalUri: uri, sortAt: '1700000000000000', source: 'peer', normalized: true, generation: 1 } as TimelineReference;
	const options = { kind: 'clip', clipId: 'clip', clipOrigin: 'https://r.example' } as const;
	reader.notes.mockResolvedValue({ notes: [{ id: noteId, uri, text: 'original', cw: null, files: [] }], validForMs: 5000 } as never);
	const result = await service.hydrate(viewer, options, [reference]);
	expect(result[0].payload.text).toBe('original'); expect(result[0].validForMs).toBeLessThanOrEqual(5000);
	reader.notes.mockImplementationOnce(async () => {
		await db.query('DELETE FROM gridspace_clip_reference');
		return { notes: [{ id: noteId, uri }], validForMs: 5000 } as never;
	});
	expect(await service.hydrate(viewer, options, [reference])).toEqual([]);
});
