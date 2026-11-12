/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { UsersRepository } from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { RelayService } from '@/core/RelayService.js';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { bindThis } from '@/decorators.js';
import type { Config } from '@/config.js';
import { QueueService } from '@/core/QueueService.js';
import { resolveGridspaceConfig, type GridspacePeerConfig } from '@/core/gridspace/peer-protocol.js';

@Injectable()
export class AccountUpdateService {
	private peer: GridspacePeerConfig | null;

	constructor(
		@Inject(DI.config) private config: Config,
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private userEntityService: UserEntityService,
		private apRendererService: ApRendererService,
		private apDeliverManagerService: ApDeliverManagerService,
		private relayService: RelayService,
		private queueService: QueueService,
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
	}

	@bindThis
	public async publishToFollowers(userId: MiUser['id']) {
		const user = await this.usersRepository.findOneBy({ id: userId });
		if (user == null) throw new Error('user not found');

		// フォロワーがリモートユーザーかつ投稿者がローカルユーザーならUpdateを配信
		if (this.userEntityService.isLocalUser(user)) {
			const content = this.apRendererService.addContext(this.apRendererService.renderUpdate(await this.apRendererService.renderPerson(user), user));
			this.apDeliverManagerService.deliverToFollowers(user, content);
			this.relayService.deliverToRelays(user, content);
			// The fixed peer can cache community notes even when nobody there follows the author.
			// Use the normal durable AP queue so later privacy changes reach those cached actors too.
			if (this.peer) await this.queueService.deliver(user, content, this.peer.peerOrigin + '/inbox', true);
		}
	}
}
