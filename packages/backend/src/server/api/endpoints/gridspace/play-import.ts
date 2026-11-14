/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiFlash } from '@/models/Flash.js';
import { MiGridspaceLink } from '@/models/Gridspace.js';
import { MiRegistryItem } from '@/models/RegistryItem.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { IdService } from '@/core/IdService.js';
import { RegistryApiService } from '@/core/RegistryApiService.js';
import { GridspaceLinkService, GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspaceFollowGuardService } from '@/core/gridspace/GridspaceFollowGuardService.js';
import { settingsDomain } from '@/core/gridspace/settings-protocol.js';
import { gridspaceHash } from '@/core/gridspace/link-crypto.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';

const count = { type: 'integer', optional: false, nullable: false } as const;
export const meta = {
	tags: ['account', 'flash'], requireCredential: true, secure: true, prohibitMoved: true,
	limit: { duration: 60000, max: 60 },
	errors: { unavailable: { message: 'Linked Play import is unavailable.', code: 'GRIDSPACE_PLAY_IMPORT_UNAVAILABLE', id: '297c34c7-4934-4f05-8487-67bd0675fd5d' } },
	res: { type: 'object', optional: false, nullable: false, properties: {
		started: { type: 'boolean', optional: false, nullable: false }, complete: { type: 'boolean', optional: false, nullable: false },
		total: count, done: count, failed: count, pending: count,
	} },
} as const;
export const paramDef = { type: 'object', properties: { action: { type: 'string', enum: ['status', 'start', 'step', 'retry'], default: 'status' } }, required: [] } as const;
type Binding = Awaited<ReturnType<GridspaceLinkService['checkSettingsAuthorization']>>;
type Job = { binding: Binding; items: { sourceId: string; targetId: string; state: 'pending' | 'done' | 'failed' }[] };
const scope = ['gridspace', 'playImport'];
const sameBinding = (a: Binding, b: Binding) => Object.keys(a).every(key => a[key as keyof Binding] === b[key as keyof Binding]);

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private links: GridspaceLinkService, private guard: GridspaceFollowGuardService, private registry: RegistryApiService, private ids: IdService,
		@Inject(DI.db) private db: DataSource, @Inject(DI.config) private config: Config) {
		super(meta, paramDef, async (ps, me) => {
			try { return await guard.runProfile(me.id, () => this.run(ps.action, me)); } catch (error) { if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code }); throw error; }
		});
	}

	private async run(action: string, me: MiLocalUser) {
		if (this.config.gridspace?.channelRole !== 'client') throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const binding = await this.links.checkSettingsAuthorization(me);
		const key = gridspaceHash(`${binding.peerOrigin}:${binding.peerUserId}`);
		let receipt = await this.registry.getItem(me.id, settingsDomain, scope, key);
		let job = receipt?.value as Job | undefined;
		if (action === 'start') {
			if (!job) {
				const snapshot = await this.links.plays(me);
				if (!sameBinding(binding, snapshot)) throw new GridspaceLinkError('LINK_REVOKED');
				job = { binding, items: snapshot.items.map(item => ({ sourceId: item.id, targetId: this.ids.gen(), state: 'pending' })) };
			} else job.binding = binding;
			await this.registry.set(me.id, settingsDomain, scope, key, job);
			receipt = await this.registry.getItem(me.id, settingsDomain, scope, key);
		}
		if (!job) return { started: false, complete: false, total: 0, done: 0, failed: 0, pending: 0 };
		if (!sameBinding(job.binding, binding) || !receipt) throw new GridspaceLinkError('LINK_REVOKED');
		if (action === 'retry') {
			for (const item of job.items) if (item.state === 'failed') item.state = 'pending';
			await this.registry.set(me.id, settingsDomain, scope, key, job);
		}
		if (action !== 'status') {
			let processed = 0;
			for (const item of job.items) {
				if (item.state !== 'pending') continue;
				if (processed++ >= 2) break;
				try {
					const snapshot = await this.links.plays(me, item.sourceId);
					if (!sameBinding(job.binding, snapshot) || !snapshot.play) throw new GridspaceLinkError('LINK_REVOKED');
					const play = snapshot.play;
					job = await this.db.transaction(async manager => {
						const locked = await manager.findOne(MiRegistryItem, { where: { id: receipt!.id, userId: me.id }, lock: { mode: 'pessimistic_write' } });
						const local = await manager.findOne(MiGridspaceLink, { where: { id: binding.linkId, localUserId: me.id, state: 'active' }, lock: { mode: 'pessimistic_read' } });
						if (!locked || !local || !local.initiator || local.peerOrigin !== binding.peerOrigin || local.generation !== binding.generation || local.peerUserId !== binding.peerUserId || !local.tokenCipher || gridspaceHash(local.tokenCipher) !== binding.credentialHash ||
							!await manager.existsBy(MiUser, { id: me.id, host: IsNull(), isDeleted: false, isSuspended: false, movedToUri: IsNull() })) throw new GridspaceLinkError('LINK_REVOKED');
						const current = locked.value as Job;
						if (!sameBinding(current.binding, binding)) throw new GridspaceLinkError('LINK_REVOKED');
						const task = current.items.find(row => row.targetId === item.targetId && row.sourceId === play.id);
						if (!task) throw new GridspaceLinkError('LINK_REVOKED');
						if (task.state === 'done') return current;
						const { id: _sourceId, ...data } = play;
						// A new native Play is independent. Do not execute its script or copy likes/storage.
						await manager.insert(MiFlash, { ...data, id: task.targetId, userId: me.id, updatedAt: new Date(), likedCount: 0 });
						task.state = 'done';
						const updated = await manager.update(MiRegistryItem, { id: locked.id, userId: me.id }, { value: current as MiRegistryItem['value'], updatedAt: new Date() });
						if (updated.affected !== 1) throw new Error('Missing import receipt');
						return current;
					});
				} catch (error) {
					if (error instanceof GridspaceLinkError && error.code !== 'PLAY_UNAVAILABLE') throw error;
					// An acknowledgement may be lost after commit: trust the atomic receipt.
					const saved = (await this.registry.getItem(me.id, settingsDomain, scope, key))?.value as Job | undefined;
					if (!saved || !sameBinding(saved.binding, binding)) throw new GridspaceLinkError('LINK_REVOKED');
					const task = saved.items.find(row => row.targetId === item.targetId);
					if (task && task.state !== 'done') task.state = 'failed';
					job = saved;
					await this.registry.set(me.id, settingsDomain, scope, key, job);
				}
			}
		}
		const states = job.items.map(item => item.state);
		return { started: true, complete: states.every(state => state === 'done'), total: states.length,
			done: states.filter(state => state === 'done').length, failed: states.filter(state => state === 'failed').length, pending: states.filter(state => state === 'pending').length };
	}
}
