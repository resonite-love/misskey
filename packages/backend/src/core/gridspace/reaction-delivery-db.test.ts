/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { mockDeep } from 'vitest-mock-extended';
import { loadConfig } from '@/config.js';
import type { Config } from '@/config.js';
import { MiNote } from '@/models/Note.js';
import { MiGridspaceReactionDelivery } from '@/models/Gridspace.js';
import { GridspaceReactionDeliveryService } from './GridspaceReactionDeliveryService.js';
import { requestGridspacePeer } from './peer-client.js';

vi.mock('./peer-client.js', () => ({ requestGridspacePeer: vi.fn() }));
const config = loadConfig();
const schema = `reaction_test_${randomBytes(8).toString('hex')}`;
const db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db,
	schema, extra: { options: `-c search_path=${schema}` }, entities: [MiGridspaceReactionDelivery] });
const note = { id: 'note', userHost: null, uri: null, channelId: null } as MiNote;
let service: GridspaceReactionDeliveryService;
let migration: { up: (runner: unknown) => Promise<void>; down: (runner: unknown) => Promise<void> };

beforeAll(async () => {
	expect(config.db.db).toBe('test-misskey');
	await db.initialize(); await db.query(`CREATE SCHEMA "${schema}"`);
	const module = await import(pathToFileURL(resolve('migration/1794484393403-GridspaceReactionDelivery.js')).href);
	migration = new module.GridspaceReactionDelivery1794484393403();
	await migration.up(db); await migration.down(db); await migration.up(db);
	await db.query('CREATE TABLE writes (id text PRIMARY KEY)');
	vi.stubEnv('REACTION_TEST_KEY', Buffer.alloc(32, 1).toString('base64'));
	const cfg = { ...config, url: 'https://g.example', gridspace: { enabled: true, communityId: 'test', peerUrl: 'https://r.example', keyId: 'v1', secretEnv: 'REACTION_TEST_KEY' } } as Config;
	service = new GridspaceReactionDeliveryService(db, cfg, mockDeep());
});
afterAll(async () => {
	vi.restoreAllMocks(); vi.unstubAllEnvs();
	if (db.isInitialized) { await db.query(`DROP SCHEMA "${schema}" CASCADE`); await db.destroy(); }
});

test('a failed outbox write rolls back the reaction mutation; schema matches the entity', async () => {
	await db.query('ALTER TABLE gridspace_reaction_delivery ADD CONSTRAINT reject_fixture CHECK ("noteId" <> \'rejected\')');
	await expect(service.mutate({ ...note, id: 'rejected' }, manager => manager.query("INSERT INTO writes VALUES ('rejected')"))).rejects.toThrow();
	expect(await db.query('SELECT * FROM writes')).toEqual([]);
	await db.query('ALTER TABLE gridspace_reaction_delivery DROP CONSTRAINT reject_fixture');
	await service.mutate(note, manager => manager.query("INSERT INTO writes VALUES ('success')"));
	expect(await db.query('SELECT * FROM writes')).toEqual([{ id: 'success' }]);
	expect(await db.getRepository(MiGridspaceReactionDelivery).count()).toBe(1);
	const diff = await db.driver.createSchemaBuilder().log();
	expect(diff.upQueries).toEqual([]);
});

test('two independent workers do not send concurrently and an in-flight mutation survives acknowledgement', async () => {
	const repo = db.getRepository.bind(db);
	vi.spyOn(db, 'getRepository').mockImplementation(((entity: unknown) => entity === MiNote ? { findBy: async () => [note] } : repo(entity as never)) as never);
	let release!: () => void; let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	vi.mocked(requestGridspacePeer).mockImplementation(async () => { entered(); await gate; return { ok: true }; });
	const first = service.flush(); await started;
	const cfg = { ...config, url: 'https://g.example', gridspace: { enabled: true, communityId: 'test', peerUrl: 'https://r.example', keyId: 'v1', secretEnv: 'REACTION_TEST_KEY' } } as Config;
	await new GridspaceReactionDeliveryService(db, cfg, mockDeep()).flush();
	expect(requestGridspacePeer).toHaveBeenCalledTimes(1);
	await service.mutate(note, async () => undefined);
	release(); await first;
	expect(await repo(MiGridspaceReactionDelivery).count()).toBe(1);
	await service.flush();
	expect(await repo(MiGridspaceReactionDelivery).count()).toBe(0);
});
