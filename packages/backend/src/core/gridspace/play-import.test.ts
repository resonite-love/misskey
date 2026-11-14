/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Config } from '@/config.js';
import type { DataSource, EntityManager } from 'typeorm';
import { MiFlash } from '@/models/Flash.js';
import { MiRegistryItem } from '@/models/RegistryItem.js';
import { MiGridspaceLink } from '@/models/Gridspace.js';
import type { MiLocalUser } from '@/models/User.js';
import type { IdService } from '@/core/IdService.js';
import type { RegistryApiService } from '@/core/RegistryApiService.js';
import { GridspaceLinkService, GridspaceLinkError } from './GridspaceLinkService.js';
import type { GridspaceFollowGuardService } from './GridspaceFollowGuardService.js';
import { gridspaceHash } from './link-crypto.js';
import { parseLinkedPlay, parseLinkedPlayIndex, type LinkedPlay } from './play-import-protocol.js';
import PlayImport from '@/server/api/endpoints/gridspace/play-import.js';

const play = (id = 'source1'): LinkedPlay => ({ id, title: 'My Play', summary: 'Description', script: 'Ui:render([])', permissions: ['write:notes'], visibility: 'private' });

function fixture(size = 3) {
	const source = Array.from({ length: size }, (_, i) => play(`source${i}`));
	const binding = { linkId: 'link', generation: 1, credentialHash: gridspaceHash('cipher'), peerOrigin: 'https://r.example', peerUserId: 'old' };
	const links = mockDeep<GridspaceLinkService>();
	links.checkSettingsAuthorization.mockImplementation(async () => ({ ...binding }));
	links.plays.mockImplementation(async (_user, id) => ({ ...binding, items: id ? [] : source.map(({ id, title }) => ({ id, title })), play: id ? source.find(item => item.id === id) ?? null : null }));
	const guard = mockDeep<GridspaceFollowGuardService>(); guard.runProfile.mockImplementation(async (_id, action) => action());
	const registry = mockDeep<RegistryApiService>(); let saved: any;
	registry.getItem.mockImplementation(async () => saved ? { id: 'receipt', value: structuredClone(saved) } as never : null);
	registry.set.mockImplementation(async (_user, _domain, _scope, _key, value) => { saved = structuredClone(value); });
	const rows = new Map<string, any>();
	const manager = mockDeep<EntityManager>();
	const local = { id: 'link', generation: 1, peerUserId: 'old', peerOrigin: 'https://r.example', initiator: true, tokenCipher: 'cipher' };
	manager.findOne.mockImplementation((async (entity: unknown) => entity === MiRegistryItem ? { id: 'receipt', value: structuredClone(saved) } : entity === MiGridspaceLink ? local : null) as never);
	manager.existsBy.mockResolvedValue(true);
	manager.insert.mockImplementation((async (entity: unknown, value: any) => { if (entity === MiFlash) rows.set(value.id, structuredClone(value)); return {}; }) as never);
	let failReceipt = false; let loseAck = false;
	manager.update.mockImplementation((async (_entity: unknown, _where: unknown, value: any) => { if (failReceipt) { failReceipt = false; throw new Error('write failed'); } saved = structuredClone(value.value); return { affected: 1 }; }) as never);
	const db = mockDeep<DataSource>();
	db.transaction.mockImplementation((async (fn: (manager: EntityManager) => Promise<unknown>) => {
		const oldRows = structuredClone(rows), oldSaved = structuredClone(saved);
		let result;
		try { result = await fn(manager); } catch (error) { rows.clear(); for (const [id, row] of oldRows) rows.set(id, row); saved = oldSaved; throw error; }
		if (loseAck) { loseAck = false; throw new Error('ack lost'); }
		return result;
	}) as never);
	const ids = mockDeep<IdService>(); let serial = 0; ids.gen.mockImplementation(() => `new${serial++}`);
	const endpoint = new PlayImport(links, guard, registry, ids, db, { gridspace: { channelRole: 'client' } } as Config);
	return { source, links, local, rows, call: (action: 'start' | 'step' | 'retry' | 'status' = 'start') => endpoint.exec({ action }, { id: 'me' } as MiLocalUser, null),
		failReceipt: () => { failReceipt = true; }, loseAck: () => { loseAck = true; } };
}

describe('independent Play imports', () => {
	test('copies at most two per step with new ownership, original code/privacy and no likes', async () => {
		const f = fixture();
		expect(await f.call()).toMatchObject({ done: 2, pending: 1 });
		expect(await f.call('step')).toMatchObject({ complete: true, done: 3 });
		expect(f.rows.size).toBe(3);
		expect([...f.rows.values()][0]).toMatchObject({ userId: 'me', script: 'Ui:render([])', permissions: ['write:notes'], visibility: 'private', likedCount: 0 });
		expect(f.rows.has('source0')).toBe(false);
	});
	test('does not overwrite edited copies or recreate deleted copies on retry', async () => {
		const f = fixture(2); await f.call();
		f.rows.get('new0').title = 'Edited here'; f.rows.delete('new1');
		f.source[0].title = 'Edited at source';
		expect(await f.call('retry')).toMatchObject({ complete: true });
		await f.call();
		expect(f.rows.size).toBe(1); expect(f.rows.get('new0').title).toBe('Edited here');
	});
	test('rolls back the copy with its receipt and can retry after a failed write', async () => {
		const f = fixture(1); f.failReceipt();
		expect(await f.call()).toMatchObject({ failed: 1, done: 0 }); expect(f.rows.size).toBe(0);
		expect(await f.call('retry')).toMatchObject({ complete: true, done: 1 }); expect(f.rows.size).toBe(1);
	});
	test('does not duplicate a committed copy after acknowledgement loss', async () => {
		const f = fixture(1); f.loseAck();
		expect(await f.call()).toMatchObject({ complete: true, done: 1 });
		await f.call('retry'); expect(f.rows.size).toBe(1);
	});
	test('checks source authorization and the local binding before writing', async () => {
		const f = fixture(1); f.local.tokenCipher = 'changed';
		await expect(f.call()).rejects.toMatchObject({ code: 'GRIDSPACE_PLAY_IMPORT_UNAVAILABLE' }); expect(f.rows.size).toBe(0);
		const revoked = fixture(1); revoked.links.plays.mockRejectedValue(new GridspaceLinkError('AUTHORIZATION_REVOKED'));
		await expect(revoked.call()).rejects.toMatchObject({ code: 'GRIDSPACE_PLAY_IMPORT_UNAVAILABLE' }); expect(revoked.rows.size).toBe(0);
	});
	test('records a deleted source as failed while continuing other copies', async () => {
		const f = fixture(2);
		f.links.plays.mockImplementation(async (_user, id) => {
			if (id === 'source0') throw new GridspaceLinkError('PLAY_UNAVAILABLE');
			return { linkId: 'link', generation: 1, credentialHash: gridspaceHash('cipher'), peerOrigin: 'https://r.example', peerUserId: 'old',
				items: id ? [] : f.source.map(({ id, title }) => ({ id, title })), play: id ? f.source[1] : null };
		});
		expect(await f.call()).toMatchObject({ done: 1, failed: 1, pending: 0 });
		expect(f.rows.size).toBe(1);
	});
});

test('Play payloads exclude ownership/state fields and reject mismatched or oversized data', () => {
	expect(parseLinkedPlay({ ...play(), userId: 'old', likedCount: 100, storage: 'private' })).toEqual(play());
	for (const value of [{ ...play(), script: 'x'.repeat(65537) }, { ...play(), visibility: 'followers' }, { ...play(), permissions: [42] }]) expect(() => parseLinkedPlay(value)).toThrow();
	expect(() => parseLinkedPlayIndex([{ id: 'same', title: 'A' }, { id: 'same', title: 'B' }])).toThrow();
});
