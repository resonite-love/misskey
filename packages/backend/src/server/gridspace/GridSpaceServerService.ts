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
import { GridspaceReplyService } from '@/core/gridspace/GridspaceReplyService.js';
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
		private roles: RoleService,
		private limiter: RateLimiterService,
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
	}

	@bindThis
	public createServer(fastify: FastifyInstance, _options: FastifyPluginOptions, done: (err?: Error) => void): void {
		registerGridspacePeer(fastify, this.peer, async (key, ttlMs) => {
			return await this.redis.set(key, '1', 'PX', ttlMs, 'NX') === 'OK';
		}, (name, body) => this.links.peerAction(name, body), (name, noteId) => name === 'read' ? this.notes.read(noteId) : this.notes.sync(noteId), input => this.history.peerHistory(input), input => this.search.peerSearch(input),
		(name, input) => name === 'notes' ? this.privateNotes.peerNotes(input) : name === 'file' ? this.privateNotes.peerFile(input) : this.links.peerPrivateGrant(name, input),
		input => this.replies.peerReply(input, async userId => {
			const factor = (await this.roles.getUserPolicies(userId)).rateLimitFactor;
			if (factor > 0 && await this.limiter.limit({ key: 'notes/create', duration: 3600000, max: 300 }, userId, factor)) throw new GridspaceLinkError('RATE_LIMITED');
		}));
		done();
	}
}
