/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiGridspaceLink } from '@/models/Gridspace.js';
import { MiUser } from '@/models/User.js';

@Injectable()
export class GridspaceIdentityService {
	constructor(@Inject(DI.db) private db: DataSource, @Inject(DI.config) private config: Config) {}

	/** Read current state: unlinking takes effect for existing streaming connections too. */
	public async linkedUserId(localUserId: string): Promise<string | null> {
		if (!this.config.gridspace?.enabled) return null;
		const link = await this.db.getRepository(MiGridspaceLink).findOneBy({ localUserId, state: 'active' });
		if (!link) return null;
		const user = await this.db.getRepository(MiUser).findOneBy({ uri: `${link.peerOrigin}/users/${link.peerUserId}` });
		return user?.id ?? null;
	}
}
