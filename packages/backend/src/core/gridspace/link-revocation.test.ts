/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource } from 'typeorm';
import type { Config } from '@/config.js';
import type { UserFollowingService } from '@/core/UserFollowingService.js';
import type { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import type { IdService } from '@/core/IdService.js';
import type { MiGridspaceLink } from '@/models/Gridspace.js';
import type { GridspaceFollowGuardService } from './GridspaceFollowGuardService.js';
import { GridspaceLinkService } from './GridspaceLinkService.js';

describe('delayed link revocation', () => {
	test.each(['revoked', 'active'] as const)('checks current %s state inside the guard', async state => {
		const db = mockDeep<DataSource>();
		const guard = mockDeep<GridspaceFollowGuardService>();
		guard.run.mockImplementation(async (_id, action) => action());
		const old = { id: 'old-link', localUserId: 'viewer', generation: 1, state: 'active' } as MiGridspaceLink;
		db.getRepository.mockReturnValue({ findOneBy: vi.fn().mockResolvedValue({ ...old, state }) } as never);
		const service = new GridspaceLinkService({ url: 'https://g.example' } as Config, db, mockDeep<UserFollowingService>(), mockDeep<ApPersonService>(), guard, mockDeep<IdService>());
		await service['revokeLocal'](old);
		expect(guard.run).toHaveBeenCalledWith('viewer', expect.any(Function));
		// A repeated old revoke must never enter the transaction that deletes this
		// user's OAuth sessions and tokens, which can now belong to a different link.
		expect(db.transaction).toHaveBeenCalledTimes(state === 'active' ? 1 : 0);
	});
});
