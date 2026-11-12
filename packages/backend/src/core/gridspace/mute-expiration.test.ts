/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { MutingsRepository, MiMuting } from '@/models/_.js';
import type { IdService } from '@/core/IdService.js';
import type { CacheService } from '@/core/CacheService.js';
import { UserMutingService } from '@/core/UserMutingService.js';

test('expiry cleanup rechecks expiry at deletion; explicit unmute remains unconditional', async () => {
	const repository = mockDeep<MutingsRepository>();
	const cache = mockDeep<CacheService>();
	const service = new UserMutingService(repository, mockDeep<IdService>(), cache);
	const loadedBeforeExtension = [{ id: 'mute', muterId: 'user', expiresAt: new Date(1) }] as MiMuting[];
	await service.unmute(loadedBeforeExtension, true);
	expect(repository.delete).toHaveBeenLastCalledWith({ id: expect.anything(), expiresAt: expect.objectContaining({ _type: 'lessThan', _value: expect.any(Date) }) });
	await service.unmute(loadedBeforeExtension);
	expect(repository.delete).toHaveBeenLastCalledWith({ id: expect.anything() });
	expect(cache.userMutingsCache.refresh).toHaveBeenCalledWith('user');
});
