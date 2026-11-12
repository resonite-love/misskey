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
import { GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';
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
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
	}

	@bindThis
	public createServer(fastify: FastifyInstance, _options: FastifyPluginOptions, done: (err?: Error) => void): void {
		registerGridspacePeer(fastify, this.peer, async (key, ttlMs) => {
			return await this.redis.set(key, '1', 'PX', ttlMs, 'NX') === 'OK';
		}, (name, body) => this.links.peerAction(name, body));
		done();
	}
}
