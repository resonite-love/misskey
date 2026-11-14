/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource, EntityManager } from 'typeorm';
import type { Config } from '@/config.js';
import type { IdService } from '@/core/IdService.js';
import type { MiLocalUser } from '@/models/User.js';
import Preferences from '@/server/api/endpoints/auto-translation/preferences.js';

function fixture(client = true) {
	const records = new Map<string, { id: string; value: { enabled: boolean } }>();
	const tx = mockDeep<EntityManager>();
	const insert = vi.fn(async (record) => { records.set(record.userId, record); });
	const update = vi.fn(async (id, patch) => { Object.assign([...records.values()].find(r => r.id === id)!, patch); });
	let selectedUser: string;
	const query = { where: vi.fn((_sql, params) => { selectedUser = params.userId; return query; }), andWhere: vi.fn(() => query), getOne: async () => records.get(selectedUser) ?? null };
	tx.getRepository.mockReturnValue({ createQueryBuilder: () => query, insert, update } as never);
	const db = mockDeep<DataSource>();
	let queue: Promise<unknown> = Promise.resolve();
	db.transaction.mockImplementation(((run: (tx: EntityManager) => Promise<unknown>) => {
		const result = queue.then(() => run(tx)); queue = result.catch(() => {}); return result;
	}) as DataSource['transaction']);
	const ids = mockDeep<IdService>(); let id = 0; ids.gen.mockImplementation(() => `record-${++id}`);
	const endpoint = new Preferences(db, { gridspace: { channelRole: client ? 'client' : 'source' } } as Config, ids);
	return { records, insert, update, tx, db, call: (enabled?: boolean, userId = 'alice') => endpoint.exec(enabled === undefined ? {} : { enabled }, { id: userId } as MiLocalUser, null) };
}

describe('one-time account auto-translation defaults', () => {
	test('initializes ON exactly once, separately for each account', async () => {
		const f = fixture();
		expect(await f.call()).toEqual({ managed: true, enabled: true, initialized: true });
		expect(await f.call()).toEqual({ managed: true, enabled: true, initialized: false });
		expect(await f.call(undefined, 'bob')).toEqual({ managed: true, enabled: true, initialized: true });
		expect(f.insert).toHaveBeenCalledTimes(2);
	});
	test('never resets an explicit OFF when read again or initialized concurrently', async () => {
		const f = fixture();
		await f.call(); await f.call(false);
		expect(await Promise.all([f.call(), f.call()])).toEqual([
			{ managed: true, enabled: false, initialized: false }, { managed: true, enabled: false, initialized: false },
		]);
		expect(f.insert).toHaveBeenCalledOnce();
		expect(f.tx.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', ['auto-translation-default-on-v1:alice']);
	});
	test('accepts an explicit first OFF and a later ON', async () => {
		const f = fixture();
		expect(await f.call(false)).toMatchObject({ initialized: true, enabled: false });
		expect(await f.call(true)).toMatchObject({ initialized: false, enabled: true });
	});
	test('leaves the source server untouched', async () => {
		const f = fixture(false);
		expect(await f.call()).toEqual({ managed: false, enabled: false, initialized: false });
		expect(f.db.transaction).not.toHaveBeenCalled();
	});
	test('does not overwrite malformed stored preferences with ON', async () => {
		const f = fixture();
		f.records.set('alice', { id: 'bad', value: { enabled: null } } as never);
		await expect(f.call()).rejects.toThrow('Invalid auto-translation preference');
		expect(f.insert).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
	});
});
