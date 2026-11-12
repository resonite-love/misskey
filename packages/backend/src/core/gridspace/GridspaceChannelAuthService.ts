/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, IsNull, type EntityManager } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiUser, type MiLocalUser, type MiRemoteUser } from '@/models/User.js';
import { MiGridspaceLink } from '@/models/Gridspace.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import { gridspaceHash } from './link-crypto.js';

@Injectable()
export class GridspaceChannelAuthService {
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.config) private config: Config,
		private links: GridspaceLinkService,
		private people: ApPersonService,
	) {}

	public get isClient() { return this.config.gridspace?.enabled === true && this.config.gridspace.channelRole === 'client'; }
	public assertSource() {
		if (!this.config.gridspace?.enabled || this.config.gridspace.channelRole !== 'source') throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
	}

	public async destination(viewer: MiLocalUser, ownIdentity = false) {
		if (!this.isClient || !await this.db.getRepository(MiUser).existsBy({ id: viewer.id, host: IsNull(), isSuspended: false, isDeleted: false })) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const peerOrigin = new URL(this.config.gridspace!.peerUrl).origin;
		const link = ownIdentity ? null : await this.db.getRepository(MiGridspaceLink).findOneBy({ localUserId: viewer.id, peerOrigin, state: 'active' });
		if (link && !link.initiator) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const credential = link ? this.links.privateCredential(link) : { channelActorId: viewer.id };
		const key = link ? `${link.id}:${link.generation}:${gridspaceHash(link.privateTokenCipher ?? '')}` : `actor:${viewer.id}`;
		return { credential, key, peerOrigin, peerUserId: link?.peerUserId ?? '', check: async () => {
			if ((await this.destination(viewer, ownIdentity)).key !== key) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			if (link) await this.links.checkPrivateUnchanged(link);
		} };
	}

	/** Only called after HMAC authentication on the channel-scoped peer routes.
	 * actorId is the authenticated client's local ID, never an arbitrary actor URI. */
	public async source(actorId: string, manager?: EntityManager): Promise<MiRemoteUser> {
		this.assertSource();
		if (!/^[a-zA-Z0-9]{1,32}$/.test(actorId)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const origin = new URL(this.config.gridspace!.peerUrl).origin;
		const uri = `${origin}/users/${actorId}`;
		const repository = (manager ?? this.db.manager).getRepository(MiUser);
		let user = await repository.findOne({ where: { uri, host: new URL(origin).host }, ...(manager ? { lock: { mode: 'pessimistic_read' as const } } : {}) });
		if (!user && !manager) user = await this.people.resolvePerson(uri);
		if (!user || user.uri !== uri || user.host !== new URL(origin).host || user.isSuspended || user.isDeleted || user.movedToUri) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		return user as MiRemoteUser;
	}
}
