/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Run with two disposable, local PostgreSQL databases named codex_emoji_sync_*.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DataSource } from 'typeorm';
import { entities } from '../src/postgres.js';
import { MiEmoji } from '../src/models/Emoji.js';
import { MiDriveFile } from '../src/models/DriveFile.js';
import { MiGridspaceEmojiSync } from '../src/models/GridspaceEmojiSync.js';
import { GridspaceEmojiSyncService } from '../src/core/gridspace/GridspaceEmojiSyncService.js';
import { GridspaceLinkError } from '../src/core/gridspace/GridspaceLinkService.js';
import { GridspaceEmojiSync1794980483917 as Migration } from '../migration/1794980483917-GridspaceEmojiSync.js';

let sequence = 0, checks = 0;
const nextId = () => `emoji${++sequence}`;
const bytes = new Map<string, Buffer>();
const md5 = (data: Buffer) => createHash('md5').update(data).digest('hex');

function database(variable: string) {
	const url = new URL(process.env[variable]!);
	assert(['localhost', '127.0.0.1'].includes(url.hostname) && /^\/codex_emoji_sync_/.test(url.pathname), 'Disposable local databases required');
	return new DataSource({ type: 'postgres', url: url.href, entities });
}

const dbA = database('EMOJI_TEST_DSN_A'), dbB = database('EMOJI_TEST_DSN_B');
const originA = 'https://a.test', originB = 'https://b.test';
let peerA: GridspaceEmojiSyncService, peerB: GridspaceEmojiSyncService;
let intercept: ((input: any) => Promise<void>) | undefined;
let transfers = 0, imports = 0;

function service(db: DataSource, origin: string, peer: string) {
	const drive = { addFile: async ({ path }: { path: string }) => {
		imports++;
		return addImage(db, origin, await readFile(path));
	} };
	return new GridspaceEmojiSyncService(
		{ url: origin, gridspace: { enabled: true, peerUrl: peer } } as never, db,
		{ json: async (_path: string, input: any) => {
			if (input.action === 'apply') { transfers++; if (intercept) await intercept(input); }
			return JSON.parse(JSON.stringify(await (origin === originA ? peerB : peerA).peer(input)));
		} } as never, drive as never, { localEmojisCache: { refresh() {} } } as never,
		{ packDetailed: async (value: string | MiEmoji) => typeof value === 'string' ? db.getRepository(MiEmoji).findOneByOrFail({ id: value }) : value } as never,
		{ publishBroadcastStream() {} } as never, { gen: nextId } as never,
		{ downloadUrl: async (url: string, path: string) => { const data = bytes.get(url); if (!data) throw Error('image missing'); await writeFile(path, data); return { filename: 'emoji.png' }; } } as never,
		{ getFileInfo: async (path: string) => ({ type: { mime: 'image/png' }, md5: md5(await readFile(path)) }) } as never,
	);
}

async function addImage(db: DataSource, origin: string, data: Buffer) {
	const id = nextId(), url = `${origin}/image/${id}.png`;
	bytes.set(url, data);
	const file = db.getRepository(MiDriveFile).create({ id, url, md5: md5(data), type: 'image/png', size: data.length, name: 'emoji.png', storedInternal: false });
	return db.getRepository(MiDriveFile).save(file);
}

async function addEmoji(db: DataSource, origin: string, name: string, image = name) {
	const file = await addImage(db, origin, Buffer.from(image));
	return db.getRepository(MiEmoji).save({ id: nextId(), name, updatedAt: new Date(), category: null, aliases: [], license: null, originalUrl: file.url, publicUrl: file.url, type: 'image/png', host: null, localOnly: false, isSensitive: false, roleIdsThatCanBeUsedThisEmojiAsReaction: [] });
}

async function update(db: DataSource, name: string, change: Partial<MiEmoji>) {
	await db.getRepository(MiEmoji).update({ name }, { ...change, updatedAt: new Date() });
	await (db === dbA ? peerA : peerB).manifest(true);
}

async function get(db: DataSource, name: string) { return db.getRepository(MiEmoji).findOneByOrFail({ name }); }

function check() { checks++; }

try {
	await dbA.initialize(); await dbB.initialize();
	await dbA.synchronize(true); await dbB.synchronize(true);
	const runner = dbA.createQueryRunner(); await runner.connect();
	await new Migration().down(runner); await new Migration().up(runner); await runner.release();
	const schema = await dbA.driver.createSchemaBuilder().log();
	assert.deepEqual(schema.upQueries.map(query => query.query), [], 'migration must match entity metadata'); check();
	peerA = service(dbA, originA, originB); peerB = service(dbB, originB, originA);
	await addEmoji(dbA, originA, 'common'); await addEmoji(dbB, originB, 'common');
	await addEmoji(dbA, originA, 'from_a'); await addEmoji(dbB, originB, 'from_b');
	await peerA.run();
	assert.equal((await get(dbB, 'from_a')).name, 'from_a'); assert.equal((await get(dbA, 'from_b')).name, 'from_b'); check();
	assert.equal((await peerA.admin({ action: 'status' })).counts.synced, 3); check();
	const noEcho = transfers;
	const beforeRows = await dbA.getRepository(MiGridspaceEmojiSync).find({ order: { id: 'ASC' } });
	await peerA.run(); assert.equal(transfers, noEcho);
	const afterRows = await dbA.getRepository(MiGridspaceEmojiSync).find({ order: { id: 'ASC' } });
	assert.deepEqual(afterRows.map(row => row.updatedAt), beforeRows.map(row => row.updatedAt), 'unchanged JSONB rows must not be rewritten'); check();
	for (const isSensitive of [true, false, true]) { await update(dbA, 'common', { isSensitive }); await peerA.run(); assert.equal((await get(dbB, 'common')).isSensitive, isSensitive); } check();
	await update(dbB, 'common', { category: 'reverse' }); await peerA.run(); assert.equal((await get(dbA, 'common')).category, 'reverse'); check();
	await update(dbA, 'common', { aliases: ['a'] }); await update(dbB, 'common', { aliases: ['b'] }); await peerA.run();
	const item = (await peerA.admin({ action: 'status' })).items.find(row => row.a?.name === 'common')!;
	assert.equal(item.state, 'conflict'); check();
	await peerA.admin({ action: 'preferA', id: item.id, expectedA: item.a?.hash ?? null, expectedB: item.b?.hash ?? null });
	assert.deepEqual((await get(dbB, 'common')).aliases, ['a']); check();
	await update(dbA, 'common', { aliases: ['stale'] }); await peerA.run();
	await assert.rejects(peerA.admin({ action: 'preferB', id: item.id, expectedA: item.a?.hash ?? null, expectedB: item.b?.hash ?? null })); check();
	const lost = await addEmoji(dbA, originA, 'lost');
	intercept = async input => { if (input.emoji.name === 'lost') { await peerB.peer(input); throw new GridspaceLinkError('PEER_UNAVAILABLE'); } };
	await peerA.run(); intercept = undefined;
	peerA = service(dbA, originA, originB); await peerA.run();
	const lostRows = await dbA.getRepository(MiGridspaceEmojiSync).findBy({ aId: lost.id });
	assert.equal(lostRows.length, 1); assert.equal(lostRows[0].state, 'synced'); check();
	await dbA.getRepository(MiEmoji).delete({ name: 'lost' }); await addEmoji(dbA, originA, 'lost'); await peerA.run();
	assert.equal((await peerA.admin({ action: 'status' })).counts.conflict, 2);
	const unchanged = transfers; await peerA.run(); assert.equal(transfers, unchanged); check();
	await update(dbA, 'from_a', { category: 'race' });
	intercept = async input => { if (input.emoji.name === 'from_a') { intercept = undefined; await update(dbB, 'from_a', { category: 'native-wins' }); } };
	await peerA.run(); assert.equal((await get(dbB, 'from_a')).category, 'native-wins'); check();
	const beforeImports = imports;
	const bad = await addEmoji(dbA, originA, 'bad_image'); bytes.set(bad.originalUrl, Buffer.from('changed after snapshot'));
	await peerA.run(); assert.equal(imports, beforeImports); check();
	await addEmoji(dbA, originA, 'not_starved'); await peerA.run(); assert.equal((await get(dbB, 'not_starved')).name, 'not_starved'); check();
	const secondWorker = service(dbA, originA, originB);
	assert.ok((await secondWorker.admin({ action: 'status' })).checkedAt); check();
	await assert.rejects(peerA.peer({ action: 'apply', operationId: 'a'.repeat(64), targetId: null, expected: null, emoji: (await peerA.manifest()).emojis![0] })); check();
	console.log(JSON.stringify({ checks, transfers, imports, result: 'PASS' }));
} finally {
	if (dbA.isInitialized) await dbA.destroy(); if (dbB.isInitialized) await dbB.destroy();
}
