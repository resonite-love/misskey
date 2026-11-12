/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource, EntityManager } from 'typeorm';
import type { Config } from '@/config.js';
import type { MiUser } from '@/models/User.js';
import { MiGridspaceImportItem, MiGridspaceLink } from '@/models/Gridspace.js';
import type { IdService } from '@/core/IdService.js';
import { GridspaceAdminService } from './GridspaceAdminService.js';
import type { GridspaceFollowGuardService } from './GridspaceFollowGuardService.js';
import { adminReason } from './admin-protocol.js';

afterEach(() => vi.unstubAllEnvs());
const admin = { id: 'admin' } as MiUser;
const jobId = '83685e56-88d2-491c-a260-7ba97d8fdf44';

function fixture(enabled = true) {
	vi.stubEnv('GRIDSPACE_ADMIN_TEST_KEY', Buffer.alloc(32, 1).toString('base64'));
	const config = { url: 'https://g.example', gridspace: { enabled, communityId: 'test', peerUrl: 'https://r.example', keyId: 'test', secretEnv: 'GRIDSPACE_ADMIN_TEST_KEY' } } as Config;
	const db = mockDeep<DataSource>(); const manager = mockDeep<EntityManager>();
	db.transaction.mockImplementation((async (action: (m: EntityManager) => unknown) => action(manager)) as never);
	const guard = mockDeep<GridspaceFollowGuardService>();
	guard.run.mockImplementation(async (_, action) => action()); guard.runMany.mockImplementation(async (_, action) => action());
	const ids = mockDeep<IdService>(); ids.gen.mockReturnValue('audit-id');
	const item = { findOneBy: vi.fn(async () => ({ id: jobId, linkId: jobId })), update: vi.fn(async () => ({ affected: 1 })) };
	const links = { findOneBy: vi.fn(async () => ({ id: jobId, localUserId: 'user' })), existsBy: vi.fn(async () => true) };
	const repo = (entity: unknown) => (entity === MiGridspaceImportItem ? item : entity === MiGridspaceLink ? links : undefined) as never;
	db.getRepository.mockImplementation(repo); manager.getRepository.mockImplementation(repo);
	return { service: new GridspaceAdminService(config, db, guard, ids), db, manager, guard, item, links };
}

describe('GridSpace administrative retry', () => {
	test('disabled bridge never schedules work', async () => {
		const f = fixture(false);
		expect(await f.service.retry(admin, { kind: 'import', id: jobId, generation: 1 })).toBe(false);
		expect(f.db.transaction).not.toHaveBeenCalled();
	});
	test('rejects malformed identifiers without querying the database', async () => {
		const f = fixture();
		expect(await f.service.retry(admin, { kind: 'import', id: '-'.repeat(36), generation: 1 })).toBe(false);
		expect(await f.service.retry(admin, { kind: 'expansion', id: 'a:b:c' })).toBe(false);
		expect(f.db.getRepository).not.toHaveBeenCalled();
	});
	test('requires the viewed active link generation', async () => {
		const f = fixture(); f.links.existsBy.mockResolvedValue(false);
		expect(await f.service.retry(admin, { kind: 'import', id: jobId, generation: 1 })).toBe(false);
		expect(f.links.existsBy).toHaveBeenCalledWith(expect.objectContaining({ generation: 1, state: 'active', initiator: true, peerOrigin: 'https://r.example' }));
		expect(f.item.update).not.toHaveBeenCalled(); expect(f.manager.query).not.toHaveBeenCalled();
	});
	test('updates only failed imports and audits in the same transaction', async () => {
		const f = fixture();
		expect(await f.service.retry(admin, { kind: 'import', id: jobId, generation: 1 })).toBe(true);
		expect(f.guard.run).toHaveBeenCalledWith('user', expect.any(Function));
		expect(f.item.update).toHaveBeenCalledWith({ id: jobId, state: 'failed' }, { state: 'pending', reason: null });
		expect(f.manager.query).toHaveBeenCalledWith(expect.stringContaining('moderation_log'), ['audit-id', 'admin', 'retryGridspaceJob', JSON.stringify({ kind: 'import', jobId })]);
	});
	test('completed or cancelled work is not retried or logged as retried', async () => {
		const f = fixture(); f.item.update.mockResolvedValue({ affected: 0 });
		expect(await f.service.retry(admin, { kind: 'import', id: jobId, generation: 1 })).toBe(false);
		expect(f.manager.query).not.toHaveBeenCalled();
	});
	test('requires both current links before scheduling an expansion', async () => {
		const f = fixture(); f.links.existsBy.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		expect(await f.service.retry(admin, { kind: 'expansion', id: 'follower:target' })).toBe(false);
		expect(f.guard.runMany).toHaveBeenCalledWith(['follower', 'target'], expect.any(Function));
		expect(f.manager.query).not.toHaveBeenCalled();
	});
	test('never passes arbitrary failure text through the administrative DTO', () => {
		expect(adminReason('FOLLOW_FAILED')).toBe('FOLLOW_FAILED');
		expect(adminReason('secret:abc')).toBe('UNKNOWN');
		expect(adminReason(null)).toBeNull();
	});
});
