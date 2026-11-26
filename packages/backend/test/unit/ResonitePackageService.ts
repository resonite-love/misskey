/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { ResonitePackageService } from '@/core/ResonitePackageService.js';
import { inspectResonitePackage } from '@/misc/resonite-package.js';

vi.mock('@/misc/resonite-package.js', () => ({ inspectResonitePackage: vi.fn() }));

test('a temporary read failure is not persisted and a later retry can succeed', async () => {
	const update = { update: vi.fn(), set: vi.fn(), where: vi.fn(), setParameter: vi.fn(), execute: vi.fn() };
	for (const key of ['update', 'set', 'where', 'setParameter'] as const) update[key].mockReturnValue(update);
	const service = new ResonitePackageService({ createQueryBuilder: () => update } as never,
		{ resolvePath: () => '/missing-then-restored.resonitepackage' } as never, {} as never);
	const file = { id: 'file', name: 'Box.resonitepackage', size: 100, storedInternal: true, accessKey: 'key', properties: {} } as never;
	const info = { schemaVersion: 1 as const, name: 'Box', assetCount: 1, assetBytes: 24, unpackedBytes: 100, variantCount: 0, recordCount: 1 };
	vi.mocked(inspectResonitePackage).mockResolvedValueOnce(null).mockResolvedValueOnce(info);
	expect(await service.inspect(file)).toBeNull();
	expect(update.execute).not.toHaveBeenCalled();
	expect(await service.inspect(file)).toEqual(info);
	expect(update.execute).toHaveBeenCalledOnce();
});
