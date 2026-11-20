/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { FanoutTimelineEndpointService } from '@/core/FanoutTimelineEndpointService.js';
import type { CacheService } from '@/core/CacheService.js';
import type { FanoutTimelineService } from '@/core/FanoutTimelineService.js';
import type { ChannelMutingService } from '@/core/ChannelMutingService.js';
import type { UtilityService } from '@/core/UtilityService.js';
import type { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import type { MiMeta } from '@/models/Meta.js';
import type { MiNote } from '@/models/Note.js';
import type { NotesRepository } from '@/models/_.js';

test.each(['exclude', 'mute'] as const)('cached reference-only renotes respect %s filters', async mode => {
	const note = { id: 'note', userId: 'author', user: { isSuspended: false }, gridspaceQuote: 'https://g.example/gridspace/private?noteId=n&channelId=c', text: null, cw: null, replyId: null, renoteId: null, fileIds: [], hasPoll: false } as MiNote;
	const query = { where: vi.fn().mockReturnThis(), innerJoinAndSelect: vi.fn().mockReturnThis(), leftJoinAndSelect: vi.fn().mockReturnThis(), getMany: vi.fn(async () => [note]) };
	const cache = mockDeep<CacheService>();
	cache.userMutingsCache.fetch.mockResolvedValue(new Set());
	cache.userBlockedCache.fetch.mockResolvedValue(new Set());
	cache.renoteMutingsCache.fetch.mockResolvedValue(new Set(mode === 'mute' ? ['author'] : []));
	cache.userProfileCache.fetch.mockResolvedValue({ mutedInstances: [] } as never);
	const channels = mockDeep<ChannelMutingService>(); channels.mutingChannelsCache.fetch.mockResolvedValue(new Set());
	const fanout = mockDeep<FanoutTimelineService>(); fanout.getMulti.mockResolvedValue([['note']]);
	const utility = mockDeep<UtilityService>(); utility.isBlockedHost.mockReturnValue(false);
	const service = new FanoutTimelineEndpointService({ createQueryBuilder: () => query } as unknown as NotesRepository,
		{ blockedHosts: [], ugcVisibilityForVisitor: 'all' } as unknown as MiMeta, {} as NoteEntityService, cache, fanout, utility, channels);
	const options = { me: { id: 'viewer' }, untilId: null, sinceId: null, limit: 20, allowPartial: true, useDbFallback: false, redisTimelines: [], excludePureRenotes: mode === 'exclude', dbFallback: async () => [] };
	expect(await service.getMiNotes(options)).toEqual([]);
	note.text = 'A comment';
	expect(await service.getMiNotes(options)).toEqual([note]);
});
