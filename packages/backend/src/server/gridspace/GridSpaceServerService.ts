/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { resolveGridspaceConfig } from '@/core/gridspace/peer-protocol.js';
import { registerGridspacePeer } from './peer-server.js';
import { GridspaceNoteService } from '@/core/gridspace/GridspaceNoteService.js';
import { GridspaceLinkError, GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspaceHistoryService } from '@/core/gridspace/GridspaceHistoryService.js';
import { GridspaceSearchService } from '@/core/gridspace/GridspaceSearchService.js';
import { GridspacePrivateService } from '@/core/gridspace/GridspacePrivateService.js';
import { GridspaceNotificationService } from '@/core/gridspace/GridspaceNotificationService.js';
import { GridspaceActionService } from '@/core/gridspace/GridspaceActionService.js';
import { GridspaceReactionService } from '@/core/gridspace/GridspaceReactionService.js';
import { GridspaceReactionDeliveryService } from '@/core/gridspace/GridspaceReactionDeliveryService.js';
import { GridspaceReplyService } from '@/core/gridspace/GridspaceReplyService.js';
import { GridspaceChannelService } from '@/core/gridspace/GridspaceChannelService.js';
import { GridspaceContentService } from '@/core/gridspace/GridspaceContentService.js';
import { GridspaceDriveService } from '@/core/gridspace/GridspaceDriveService.js';
import { RoleService } from '@/core/RoleService.js';
import { RateLimiterService } from '@/server/api/RateLimiterService.js';
import type { Config } from '@/config.js';
import type { GridspacePeerConfig } from '@/core/gridspace/peer-protocol.js';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

@Injectable()
export class GridSpaceServerService {
	private readonly peer: GridspacePeerConfig | null;

	constructor(
		@Inject(DI.config) config: Config,
		@Inject(DI.redis) private redis: Redis.Redis,
		private links: GridspaceLinkService,
		private notes: GridspaceNoteService,
		private history: GridspaceHistoryService,
		private search: GridspaceSearchService,
		private privateNotes: GridspacePrivateService,
		private replies: GridspaceReplyService,
		private channels: GridspaceChannelService,
		private actions: GridspaceActionService,
		private reactions: GridspaceReactionService,
		private reactionDelivery: GridspaceReactionDeliveryService,
		private notifications: GridspaceNotificationService,
		private roles: RoleService,
		private limiter: RateLimiterService,
		private drive: GridspaceDriveService,
		private content: GridspaceContentService,
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
	}

	private async limitAction(userId: string, key: string, max: number) {
		const factor = (await this.roles.getUserPolicies(userId)).rateLimitFactor;
		if (factor > 0 && await this.limiter.limit({ key, duration: 60000, max }, userId, factor)) throw new GridspaceLinkError('RATE_LIMITED');
	}

	@bindThis
	public createServer(fastify: FastifyInstance, _options: FastifyPluginOptions, done: (err?: Error) => void): void {
		registerGridspacePeer(fastify, this.peer, async (key, ttlMs) => {
			return await this.redis.set(key, '1', 'PX', ttlMs, 'NX') === 'OK';
		}, (name, body) => this.links.peerAction(name, body), (name, noteId) => name === 'read' ? this.notes.read(noteId) : this.notes.sync(noteId), input => this.history.peerHistory(input), input => this.search.peerSearch(input),
		(name, input) => name === 'collections' ? this.privateNotes.peerCollections(input) : name === 'notes' ? this.privateNotes.peerNotes(input) : name === 'file' ? this.privateNotes.peerFile(input) : this.links.peerPrivateGrant(name, input),
		input => this.replies.peerReply(input, async userId => {
			const factor = (await this.roles.getUserPolicies(userId)).rateLimitFactor;
			if (factor > 0 && await this.limiter.limit({ key: 'notes/create', duration: 3600000, max: 300 }, userId, factor)) throw new GridspaceLinkError('RATE_LIMITED');
		}), (action, input) => this.notifications.peer(action, input),
		input => this.actions.peerAction(input, userId => this.limitAction(userId, 'gridspace/action', 60)),
		input => this.actions.peerUpload(input, userId => this.limitAction(userId, 'drive/files/create', 20)),
		input => this.reactions.peerRead(input), input => this.reactionDelivery.receive(input), noteIds => this.notes.readMany(noteIds), input => this.channels.peerList(input), input => this.channels.peerDelete(input), input => this.drive.peer(input), input => this.content.peer(input));
		done();
	}
}
