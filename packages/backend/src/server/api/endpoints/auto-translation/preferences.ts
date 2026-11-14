/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { IdService } from '@/core/IdService.js';
import { MiRegistryItem } from '@/models/RegistryItem.js';
import { Endpoint } from '@/server/api/endpoint-base.js';

export const meta = {
	tags: ['account'], requireCredential: true, secure: true, kind: 'write:account',
	limit: { duration: 60000, max: 60 },
	description: 'Initialize GridSpace auto-translation once per account, or save the user choice.',
	res: {
		type: 'object', optional: false, nullable: false,
		properties: {
			managed: { type: 'boolean', optional: false, nullable: false },
			enabled: { type: 'boolean', optional: false, nullable: false },
			initialized: { type: 'boolean', optional: false, nullable: false },
		},
	},
} as const;
export const paramDef = {
	type: 'object', properties: { enabled: { type: 'boolean' } }, required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.db) db: DataSource,
		@Inject(DI.config) config: Config,
		idService: IdService,
	) {
		super(meta, paramDef, async (ps, me) => {
			// The source server retains its existing user preferences.
			if (config.gridspace?.channelRole !== 'client') return { managed: false, enabled: false, initialized: false };
			return db.transaction(async tx => {
				// registry_item has no uniqueness constraint. Serialize initialization and writes.
				await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`auto-translation-default-on-v1:${me.id}`]);
				const repo = tx.getRepository(MiRegistryItem);
				const record = await repo.createQueryBuilder('item')
					.where('item.userId = :userId', { userId: me.id })
					.andWhere('item.domain IS NULL')
					.andWhere('item.scope = :scope', { scope: ['client', 'autoTranslation'] })
					.andWhere('item.key = :key', { key: 'defaultOnV1' }).getOne();
				if (record && typeof record.value?.enabled !== 'boolean') throw new Error('Invalid auto-translation preference');
				const initialized = record == null;
				const enabled = ps.enabled ?? record?.value.enabled ?? true;
				if (initialized) {
					await repo.insert({ id: idService.gen(), userId: me.id, domain: null, scope: ['client', 'autoTranslation'], key: 'defaultOnV1', value: { enabled }, updatedAt: new Date() });
				} else if (ps.enabled !== undefined && ps.enabled !== record.value.enabled) {
					await repo.update(record.id, { value: { enabled }, updatedAt: new Date() });
				}
				return { managed: true, enabled, initialized };
			});
		});
	}
}
