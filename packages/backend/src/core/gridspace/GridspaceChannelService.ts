/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import { MiChannel } from '@/models/Channel.js';
import { MiChannelFollowing } from '@/models/ChannelFollowing.js';
import { MiChannelFavorite } from '@/models/ChannelFavorite.js';
import { MiNote } from '@/models/Note.js';
import { MiUser } from '@/models/User.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { ChannelEntityService } from '@/core/entities/ChannelEntityService.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { sqlLikeEscape } from '@/misc/sql-like-escape.js';
import { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import { GridspaceLinkError, GridspaceLinkService, type GridspacePeerLinkRequest } from './GridspaceLinkService.js';
import type { ChannelOptions, ChannelPeerRequest, ChannelUpdate, ChannelUpdatePeerRequest } from './channel-protocol.js';

@Injectable()
export class GridspaceChannelService {
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.config) private config: Config,
		private links: GridspaceLinkService,
		private channels: ChannelEntityService,
		private auth: GridspaceChannelAuthService,
		private noteDelete: NoteDeleteService,
		private ids: IdService,
		private events: GlobalEventService,
	) {}

	public async peerList(input: ChannelPeerRequest) {
		this.auth.assertSource();
		const link = input.channelActorId ? { localUserId: (await this.auth.source(input.channelActorId)).id, initiator: false } : await this.links.authorizePrivate(input);
		if (link.initiator) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const query = this.db.getRepository(MiChannel).createQueryBuilder('channel');
		if (input.channelId) query.where('channel.id = :channelId', { channelId: input.channelId });
		else {
			query.where(input.list === 'favorites' || input.list === 'following' ? '1 = 1' : 'channel.isArchived = false');
			query.andWhere(`NOT EXISTS (SELECT 1 FROM channel_muting m WHERE m."userId" = :viewer AND m."channelId" = channel.id
				AND (m."expiresAt" IS NULL OR m."expiresAt" > CURRENT_TIMESTAMP))`, { viewer: link.localUserId });
			if (input.query?.trim()) query.andWhere(input.queryType === 'nameOnly' ? 'channel.name ILIKE :query' : '(channel.name ILIKE :query OR channel.description ILIKE :query)', { query: `%${sqlLikeEscape(input.query.trim())}%` });
			if (input.followed || input.list === 'following') query.andWhere('EXISTS (SELECT 1 FROM channel_following f WHERE f."followerId" = :viewer AND f."followeeId" = channel.id)', { viewer: link.localUserId });
			if (input.list === 'favorites') query.andWhere('EXISTS (SELECT 1 FROM channel_favorite f WHERE f."userId" = :viewer AND f."channelId" = channel.id)', { viewer: link.localUserId });
			if (input.list === 'owned') query.andWhere('channel.userId = :viewer', { viewer: link.localUserId });
			if (input.list === 'featured') query.andWhere('channel.lastNotedAt IS NOT NULL');
			if (input.before) query.andWhere('channel.id < :before', { before: input.before });
		}
		const limit = input.channelId ? 1 : input.limit ?? 12;
		const rows = await query.orderBy(input.list === 'featured' ? 'channel.lastNotedAt' : 'channel.id', 'DESC').addOrderBy('channel.id', 'DESC').take(limit + 1).getMany();
		const channels = await Promise.all(rows.slice(0, limit).map(async row => {
			const packed = await this.channels.pack(row, { id: link.localUserId });
			return { id: row.id, name: row.name, description: row.description, bannerUrl: packed.bannerUrl, color: row.color,
				isArchived: row.isArchived, isSensitive: row.isSensitive, isFollowing: packed.isFollowing === true, notesCount: row.notesCount,
				isFavorited: packed.isFavorited === true, isOwned: row.userId === link.localUserId, usersCount: row.usersCount, createdAt: packed.createdAt, lastNotedAt: packed.lastNotedAt };
		}));
		if (input.channelActorId) await this.auth.source(input.channelActorId); else await this.links.authorizePrivate(input);
		return { origin: this.config.url, channels, next: input.list !== 'featured' && rows.length > limit ? channels.at(-1)!.id : null };
	}

	public async list(viewer: MiLocalUser, input: ChannelOptions) {
		const context = await this.auth.destination(viewer);
		const result = await this.links.json<Awaited<ReturnType<GridspaceChannelService['peerList']>>>('/gridspace/v1/private/channels', { ...input, ...context.credential });
		if (result.origin !== context.peerOrigin || !Array.isArray(result.channels) || result.channels.length > 20) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		await context.check();
		return result;
	}

	public async peerDelete(input: GridspacePeerLinkRequest & { noteId: string; channelId: string }) {
		this.auth.assertSource();
		const guest = input.channelActorId ? await this.auth.source(input.channelActorId) : null;
		const link = guest ? null : await this.links.authorizePrivate(input);
		if (link && (link.initiator || !await this.links.hasChannelScope(input))) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const user = guest ?? await this.db.getRepository(MiUser).findOneByOrFail({ id: link!.localUserId });
		const note = await this.db.getRepository(MiNote).findOneBy({ id: input.noteId, channelId: input.channelId });
		if (!note) return { deleted: true };
		if (note.userId !== user.id) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		await this.noteDelete.delete(user, note, false, undefined, async manager => {
			if (input.channelActorId) await this.auth.source(input.channelActorId, manager);
			else await this.links.lockReplyAuthorization(input, manager, 'write:gridspace-channel');
		});
		return { deleted: true };
	}

	public async peerUpdate(input: ChannelUpdatePeerRequest) {
		this.auth.assertSource();
		if (!['follow', 'unfollow', 'favorite', 'unfavorite'].includes(input.action)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const guest = input.channelActorId ? await this.auth.source(input.channelActorId) : null;
		const link = guest ? null : await this.links.authorizePrivate(input);
		if (link && link.initiator) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const userId = guest?.id ?? link!.localUserId;
		const result = await this.db.transaction(async manager => {
			if (input.channelActorId) {
				if ((await this.auth.source(input.channelActorId, manager)).id !== userId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			} else await this.links.lockReplyAuthorization(input, manager, 'write:gridspace-channel');
			if (!await manager.getRepository(MiChannel).existsBy({ id: input.channelId })) throw new GridspaceLinkError('CHANNEL_UNAVAILABLE');
			const followings = manager.getRepository(MiChannelFollowing);
			const favorites = manager.getRepository(MiChannelFavorite);
			const followKey = { followerId: userId, followeeId: input.channelId };
			const favoriteKey = { userId, channelId: input.channelId };
			if (input.action === 'follow') await followings.createQueryBuilder().insert().values({ id: this.ids.gen(), ...followKey }).orIgnore().execute();
			else if (input.action === 'unfollow') await followings.delete(followKey);
			else if (input.action === 'favorite') await favorites.createQueryBuilder().insert().values({ id: this.ids.gen(), ...favoriteKey }).orIgnore().execute();
			else await favorites.delete(favoriteKey);
			return { isFollowing: await followings.existsBy(followKey), isFavorited: await favorites.existsBy(favoriteKey) };
		});
		// Use the same cache invalidation events as ordinary channel following,
		// after the authorized transaction has committed successfully.
		if (input.action === 'follow' || input.action === 'unfollow') this.events.publishInternalEvent(input.action === 'follow' ? 'followChannel' : 'unfollowChannel', { userId, channelId: input.channelId });
		return result;
	}

	public async update(viewer: MiLocalUser, input: ChannelUpdate) {
		const context = await this.auth.destination(viewer);
		const result = await this.links.json<{ isFollowing: boolean; isFavorited: boolean }>('/gridspace/v1/private/channel-update', { ...input, ...context.credential });
		await context.check();
		return result;
	}

	public async delete(viewer: MiLocalUser, input: { noteId: string; channelId: string; asCurrentAccount?: boolean }) {
		const context = await this.auth.destination(viewer, input.asCurrentAccount === true);
		const result = await this.links.json<{ deleted: boolean }>('/gridspace/v1/private/channel-delete', { noteId: input.noteId, channelId: input.channelId, ...context.credential });
		await context.check();
		return result;
	}
}
