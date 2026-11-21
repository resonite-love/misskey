/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';

export type FanoutTimelineName = (
	// home timeline
	| `homeTimeline:${string}`
	| `homeTimelineWithFiles:${string}` // only notes with files are included
	// local timeline
	| `localTimeline` // replies are not included
	| `localTimelineWithFiles` // only non-reply notes with files are included
	| `localTimelineWithReplies` // only replies are included
	| `localTimelineWithReplyTo:${string}` // Only replies to specific local user are included. Parameter is reply user id.

	// antenna
	| `antennaTimeline:${string}`

	// user timeline
	| `userTimeline:${string}` // replies are not included
	| `userTimelineWithFiles:${string}` // only non-reply notes with files are included
	| `userTimelineWithReplies:${string}` // only replies are included
	| `userTimelineWithChannel:${string}` // only channel notes are included, replies are included

	// user list timelines
	| `userListTimeline:${string}`
	| `userListTimelineWithFiles:${string}` // only notes with files are included

	// channel timelines
	| `channelTimeline:${string}` // replies are included

	// role timelines
	| `roleTimeline:${string}` // any notes are included

	// vmimi relay timelines
	| 'vmimiRelayTimeline' // replies are not included
	| 'vmimiRelayTimelineWithFiles' // only non-reply notes with files are included
	| 'vmimiRelayTimelineWithReplies' // only replies are included
	| `vmimiRelayTimelineWithReplyTo:${string}` // Only replies to specific local user are included. Parameter is reply user id.
);

@Injectable()
export class FanoutTimelineService {
	constructor(
		@Inject(DI.redisForTimelines)
		private redisForTimelines: Redis.Redis,

		private idService: IdService,
	) {
	}

	@bindThis
	public push(tl: FanoutTimelineName, id: string, maxlen: number, pipeline: Redis.ChainableCommander) {
		// リモートから遅れて届いた(もしくは後から追加された)投稿日時が古い投稿が追加されるとページネーション時に問題を引き起こすため、
		// 3分以内に投稿されたものでない場合、Redisにある最古のIDより新しい場合のみ追加する
		if (this.idService.parse(id).date.getTime() > Date.now() - 1000 * 60 * 3) {
			pipeline.lpush('list:' + tl, id);
			if (Math.random() < 0.1) { // 10%の確率でトリム
				pipeline.ltrim('list:' + tl, 0, maxlen - 1);
			}
			return undefined;
		} else {
			// 末尾のIDを取得
			return this.redisForTimelines.lindex('list:' + tl, -1).then(async lastId => {
				if (lastId == null || (this.idService.parse(id).date.getTime() > this.idService.parse(lastId).date.getTime())) {
					await this.redisForTimelines.lpush('list:' + tl, id);
				}
			});
		}
	}

	/** A committed dispatch can run again after a process stops between Redis and PostgreSQL. */
	@bindThis
	public pushOnce(tl: FanoutTimelineName, id: string, maxlen: number, pipeline: Redis.ChainableCommander) {
		pipeline.eval(`if redis.call('LPOS', KEYS[1], ARGV[1]) then return 0 end
			local tail = redis.call('LINDEX', KEYS[1], -1)
			if tail and ARGV[3] == '0' and tail > ARGV[1] then return 0 end
			redis.call('LPUSH', KEYS[1], ARGV[1])
			redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[2]) - 1)
			return 1`, 1, 'list:' + tl, id, Math.max(1, Math.floor(maxlen)), this.idService.parse(id).date.getTime() > Date.now() - 180000 ? '1' : '0');
	}

	/** A peer placement may become active after its ordinary mirror was already delivered. */
	public async cachePlacedMirror(noteId: string, channelId: string, maxlen: number, followers: string[], homeMax: number, withFiles: boolean) {
		const batch = this.redisForTimelines.pipeline();
		this.pushOnce(`channelTimeline:${channelId}`, noteId, maxlen, batch);
		for (const viewerId of followers) {
			this.pushOnce(`homeTimeline:${viewerId}`, noteId, homeMax, batch);
			if (withFiles) this.pushOnce(`homeTimelineWithFiles:${viewerId}`, noteId, homeMax / 2, batch);
		}
		const result = await batch.exec();
		if (!result || result.some(([error]) => error)) throw new Error('Could not cache placed mirror');
	}

	@bindThis
	public get(name: FanoutTimelineName, untilId?: string | null, sinceId?: string | null) {
		if (untilId && sinceId) {
			return this.redisForTimelines.lrange('list:' + name, 0, -1)
				.then(ids => ids.filter(id => id < untilId && id > sinceId).sort((a, b) => a > b ? -1 : 1));
		} else if (untilId) {
			return this.redisForTimelines.lrange('list:' + name, 0, -1)
				.then(ids => ids.filter(id => id < untilId).sort((a, b) => a > b ? -1 : 1));
		} else if (sinceId) {
			return this.redisForTimelines.lrange('list:' + name, 0, -1)
				.then(ids => ids.filter(id => id > sinceId).sort((a, b) => a < b ? -1 : 1));
		} else {
			return this.redisForTimelines.lrange('list:' + name, 0, -1)
				.then(ids => ids.sort((a, b) => a > b ? -1 : 1));
		}
	}

	@bindThis
	public getMulti(name: FanoutTimelineName[], untilId?: string | null, sinceId?: string | null): Promise<string[][]> {
		const pipeline = this.redisForTimelines.pipeline();
		for (const n of name) {
			pipeline.lrange('list:' + n, 0, -1);
		}
		return pipeline.exec().then(res => {
			if (res == null) return [];
			const tls = res.map(r => r[1] as string[]);
			return tls.map(ids =>
				(untilId && sinceId)
					? ids.filter(id => id < untilId && id > sinceId).sort((a, b) => a > b ? -1 : 1)
					: untilId
						? ids.filter(id => id < untilId).sort((a, b) => a > b ? -1 : 1)
						: sinceId
							? ids.filter(id => id > sinceId).sort((a, b) => a < b ? -1 : 1)
							: ids.sort((a, b) => a > b ? -1 : 1),
			);
		});
	}

	@bindThis
	public purge(name: FanoutTimelineName) {
		return this.redisForTimelines.del('list:' + name);
	}

	@bindThis
	public remove(name: FanoutTimelineName, id: string) {
		return this.redisForTimelines.lrem('list:' + name, 1, id);
	}
}
