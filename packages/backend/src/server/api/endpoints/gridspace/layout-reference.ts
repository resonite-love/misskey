/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { MiUserList } from '@/models/UserList.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { RegistryApiService } from '@/core/RegistryApiService.js';
import { GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspaceSharedDriveService } from '@/core/gridspace/GridspaceSharedDriveService.js';
import { GridspaceManagedResourceService } from '@/core/gridspace/GridspaceManagedResourceService.js';
import { GridspaceChannelService } from '@/core/gridspace/GridspaceChannelService.js';
import { gridspaceHash } from '@/core/gridspace/link-crypto.js';
import { settingsDomain } from '@/core/gridspace/settings-protocol.js';

export const meta = {
	tags: ['account'], requireCredential: true, secure: true, prohibitMoved: true,
	limit: { duration: 60000, max: 120 },
	errors: { unavailable: { message: 'The layout reference is unavailable.', code: 'GRIDSPACE_LAYOUT_UNAVAILABLE', id: 'b56ab1db-3938-4afc-84c2-ab5b99401092' } },
	res: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string', optional: true } }, optional: false, nullable: false },
} as const;
export const paramDef = { type: 'object', properties: { kind: { type: 'string', enum: ['folder', 'file', 'list', 'antenna', 'clip', 'channel'] }, id: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' } }, required: ['kind', 'id'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private links: GridspaceLinkService, private drive: GridspaceSharedDriveService, private managed: GridspaceManagedResourceService,
		private channels: GridspaceChannelService, private registry: RegistryApiService, @Inject(DI.db) private db: DataSource) {
		super(meta, paramDef, async (ps, me) => {
			try {
				const binding = await links.checkSettingsAuthorization(me);
				let result: { id: string; name?: string };
				if (ps.kind === 'folder') result = await drive.referenceFolder(me, ps.id);
				else if (ps.kind === 'file') {
					const file = await drive.referenceFile(me, ps.id);
					if (!file) throw new Error('Unavailable file');
					result = file;
				} else if (ps.kind === 'list') {
					const receipt = (await registry.getItem(me.id, settingsDomain, ['gridspace', 'listImport'], gridspaceHash(`${binding.peerOrigin}:${binding.peerUserId}`)))?.value as { lists?: { source: { id: string }; targetId: string; state: string }[] } | undefined;
					const copy = receipt?.lists?.find(item => item.source.id === ps.id && item.state === 'done');
					const list = copy && await db.getRepository(MiUserList).findOneBy({ id: copy.targetId, userId: me.id });
					if (!list) throw new Error('Unavailable list');
					result = list;
				} else if (ps.kind === 'channel') {
					const channel = (await channels.list(me, { channelId: ps.id, limit: 1 })).channels[0];
					if (!channel) throw new Error('Unavailable channel');
					result = { id: `gridspace:channel:${channel.id}`, name: channel.name };
				} else {
					const item = (await managed.request(me, { kind: ps.kind, action: ps.kind === 'clip' ? 'reference' : 'show', id: ps.id })).item;
					if (!item) throw new Error('Unavailable resource');
					result = { id: String(item.id), name: String(item.name) };
				}
				const current = await links.checkSettingsAuthorization(me);
				if (JSON.stringify(current) !== JSON.stringify(binding)) throw new Error('Changed link');
				return { id: result.id, name: result.name };
			} catch { throw new ApiError(meta.errors.unavailable); }
		});
	}
}
