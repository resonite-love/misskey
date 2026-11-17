/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import * as Redis from 'ioredis';
import { AntennaService } from '@/core/AntennaService.js';
import { FanoutTimelineService } from '@/core/FanoutTimelineService.js';
import type { IdService } from '@/core/IdService.js';
import type { AntennasRepository, UserListMembershipsRepository } from '@/models/_.js';
import type { MiAntenna } from '@/models/Antenna.js';
import type { MiNote } from '@/models/Note.js';
import type { CacheService } from '@/core/CacheService.js';
import type { UtilityService } from '@/core/UtilityService.js';
import type { GlobalEventService } from '@/core/GlobalEventService.js';
import type { Config } from '@/config.js';

const note = { id: 'note' } as MiNote;
const user = { id: 'author', username: 'author', host: null, isBot: false };
const antennas = [{ id: 'a', userId: 'owner' }, { id: 'b', userId: 'owner' }, { id: 'c', userId: 'other' }] as MiAntenna[];

function fixture(old: boolean, enabled = true) {
	const redis = mockDeep<Redis.Redis>();
	const pipeline = mockDeep<Redis.ChainableCommander>();
	redis.pipeline.mockReturnValue(pipeline);
	const ids = mockDeep<IdService>();
	ids.parse.mockReturnValue({ date: new Date(Date.now() - (old ? 600000 : 0)) });
	const fanout = new FanoutTimelineService(redis, ids);
	const repository = mockDeep<AntennasRepository>();
	const insert = vi.fn(async () => ({}));
	repository.manager.getRepository.mockReturnValue({ insert } as never);
	const service = new AntennaService(redis, mockDeep<Redis.Redis>(), repository, mockDeep<UserListMembershipsRepository>(), mockDeep<CacheService>(), mockDeep<UtilityService>(), mockDeep<GlobalEventService>(), fanout, { gridspace: { enabled } } as Config);
	vi.spyOn(service, 'getAntennas').mockResolvedValue(antennas);
	vi.spyOn(service, 'checkHitAntenna').mockResolvedValue(true);
	return { service, redis, pipeline, insert };
}

afterEach(() => vi.restoreAllMocks());

describe('antenna membership completion events', () => {
	test('a new-note event is recorded only after pipeline completion, once per owner', async () => {
		const f = fixture(false); let complete!: () => void;
		f.pipeline.exec.mockImplementation(() => new Promise(resolve => { complete = () => resolve([[null, 1]]); }));
		const delivered = f.service.addNoteToAntennas(note, user);
		await vi.waitFor(() => expect(f.pipeline.exec).toHaveBeenCalled());
		expect(f.insert).not.toHaveBeenCalled(); complete();
		expect(await delivered).toEqual(antennas);
		expect(f.insert).toHaveBeenCalledWith([
			{ kind: 'antenna', affectedUserId: 'owner', noteId: null, canonicalUri: null },
			{ kind: 'antenna', affectedUserId: 'other', noteId: null, canonicalUri: null },
		]);
	});
	test('an old-note direct push is awaited even though the pipeline is empty', async () => {
		const f = fixture(true); let complete!: () => void;
		f.pipeline.exec.mockResolvedValue([]);
		f.redis.lindex.mockResolvedValue(null);
		const pending = new Promise<number>(resolve => { complete = () => resolve(1); });
		f.redis.lpush.mockReturnValue(pending);
		const delivered = f.service.addNoteToAntennas(note, user);
		await vi.waitFor(() => expect(f.redis.lpush).toHaveBeenCalledTimes(3));
		expect(f.insert).not.toHaveBeenCalled(); complete();
		await delivered;
		expect(f.insert).toHaveBeenCalledTimes(1);
	});
	test.each([null, [[new Error('redis command failed'), null]]])('failed or aborted pipelines cannot claim delivery', async result => {
		const f = fixture(false); f.pipeline.exec.mockResolvedValue(result as never);
		await expect(f.service.addNoteToAntennas(note, user)).rejects.toThrow();
		expect(f.insert).not.toHaveBeenCalled();
	});
	test('a rejected old-note push cannot claim delivery', async () => {
		const f = fixture(true); f.pipeline.exec.mockResolvedValue([]); f.redis.lindex.mockResolvedValue(null); f.redis.lpush.mockRejectedValue(new Error('redis unavailable'));
		await expect(f.service.addNoteToAntennas(note, user)).rejects.toThrow('redis unavailable');
		expect(f.insert).not.toHaveBeenCalled();
	});
	test('ordinary installations do not write GridSpace events', async () => {
		const f = fixture(false, false); f.pipeline.exec.mockResolvedValue([[null, 1]]);
		await f.service.addNoteToAntennas(note, user);
		expect(f.insert).not.toHaveBeenCalled();
	});
});
