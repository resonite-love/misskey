/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, IsNull, type EntityManager } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiUserList } from '@/models/UserList.js';
import { MiUserListMembership } from '@/models/UserListMembership.js';
import { MiRegistryItem } from '@/models/RegistryItem.js';
import { MiBlocking } from '@/models/Blocking.js';
import { IdService } from '@/core/IdService.js';
import { RoleService } from '@/core/RoleService.js';
import { UserListService } from '@/core/UserListService.js';
import { RegistryApiService } from '@/core/RegistryApiService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { GridspaceLinkError, GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspaceFollowGuardService } from '@/core/gridspace/GridspaceFollowGuardService.js';
import { settingsDomain } from '@/core/gridspace/settings-protocol.js';
import { gridspaceHash } from '@/core/gridspace/link-crypto.js';
import type { LinkedList } from '@/core/gridspace/collections-protocol.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';

const count = { type: 'integer', optional: false, nullable: false } as const;
export const meta = {
	tags: ['account', 'lists'], requireCredential: true, secure: true, prohibitMoved: true,
	limit: { duration: 60000, max: 60 },
	errors: { unavailable: { message: 'Linked lists import is unavailable.', code: 'GRIDSPACE_LISTS_UNAVAILABLE', id: '7827f8fb-5d74-43c1-b473-d3f21f1d71a7' } },
	res: { type: 'object', optional: false, nullable: false, properties: {
		started: { type: 'boolean', optional: false, nullable: false }, complete: { type: 'boolean', optional: false, nullable: false },
		total: count, done: count, failed: count, pending: count,
	} },
} as const;
export const paramDef = { type: 'object', properties: { action: { type: 'string', enum: ['start', 'step', 'status', 'retry'], default: 'status' } }, required: [] } as const;
type State = 'pending' | 'done' | 'failed';
type Job = { binding: Awaited<ReturnType<GridspaceLinkService['checkSettingsAuthorization']>>; lists: { source: LinkedList; targetId: string; created: boolean; state: State; members: State[] }[] };
const scope = ['gridspace', 'listImport'];

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private links: GridspaceLinkService, private guard: GridspaceFollowGuardService, private registry: RegistryApiService,
		private people: ApPersonService, private ids: IdService, private roles: RoleService, private lists: UserListService,
		@Inject(DI.db) private db: DataSource, @Inject(DI.config) private config: Config,
	) {
		super(meta, paramDef, async (ps, me) => {
			try { return await guard.runProfile(me.id, () => this.run(ps.action, me)); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}

	private async run(action: string, me: MiLocalUser) {
		if (this.config.gridspace?.channelRole !== 'client') throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const binding = await this.links.checkSettingsAuthorization(me);
		const key = gridspaceHash(`${binding.peerOrigin}:${binding.peerUserId}`);
		let job = (await this.registry.getItem(me.id, settingsDomain, scope, key))?.value as Job | undefined;
		const save = () => this.registry.set(me.id, settingsDomain, scope, key, job!);
		if (action === 'start') {
			if (!job) {
				const snapshot = await this.links.lists(me);
				if (snapshot.peerOrigin !== binding.peerOrigin || snapshot.peerUserId !== binding.peerUserId) throw new GridspaceLinkError('LINK_REVOKED');
				const { lists: _lists, ...snapshotBinding } = snapshot;
				job = { binding: snapshotBinding, lists: snapshot.lists.map(source => ({ source, targetId: this.ids.gen(), created: false, state: 'pending', members: source.members.map(() => 'pending') })) };
			} else job.binding = binding; // A new grant for the same source owner may resume its receipt.
			await save();
		}
		if (!job) return { started: false, complete: false, total: 0, done: 0, failed: 0, pending: 0 };
		const check = async () => {
			const current = await this.links.checkSettingsAuthorization(me);
			if (Object.keys(job!.binding).some(k => current[k as keyof typeof current] !== job!.binding[k as keyof typeof current])) throw new GridspaceLinkError('LINK_REVOKED');
		};
		await check();
		const receipt = await this.registry.getItem(me.id, settingsDomain, scope, key);
		if (!receipt) throw new GridspaceLinkError('LINK_REVOKED');
		const saveAtomic = async (manager: EntityManager) => {
			const result = await manager.update(MiRegistryItem, { id: receipt.id, userId: me.id }, { value: job as MiRegistryItem['value'], updatedAt: new Date() });
			if (result.affected !== 1) throw new Error('Missing import receipt');
		};
		if (action === 'retry') {
			for (const list of job.lists) { if (list.state === 'failed') list.state = 'pending'; list.members = list.members.map(s => s === 'failed' ? 'pending' : s); }
			await save();
		}
		if (action !== 'status') {
			let processed = 0;
			const deadline = Date.now() + 5000;
			for (const list of job.lists) {
				if (processed >= 5 || (processed && Date.now() >= deadline)) break;
				if (list.state === 'failed') continue;
				let target = await this.db.getRepository(MiUserList).findOneBy({ id: list.targetId, userId: me.id });
				if (list.state === 'pending') {
					processed++;
					try {
						await check();
						if (!target) {
							if (list.created) throw new Error('Destination list was removed');
							if (await this.db.getRepository(MiUserList).countBy({ userId: me.id }) >= (await this.roles.getUserPolicies(me.id)).userListLimit) throw new Error('List limit');
							await this.db.transaction(async manager => {
								await manager.insert(MiUserList, { id: list.targetId, userId: me.id, name: list.source.name, isPublic: list.source.isPublic });
								list.created = true; list.state = 'done';
								await saveAtomic(manager);
							});
							target = await this.db.getRepository(MiUserList).findOneByOrFail({ id: list.targetId, userId: me.id });
						}
						list.created = true; list.state = 'done';
					} catch (error) {
						if (error instanceof GridspaceLinkError) throw error;
						const persisted = (await this.registry.getItem(me.id, settingsDomain, scope, key))!.value as Job;
						const saved = persisted.lists.find(l => l.targetId === list.targetId)!;
						list.created = saved.created; list.state = saved.state === 'done' ? 'done' : 'failed';
					}
					await save();
				}
				for (let i = 0; i < list.members.length && processed < 5 && Date.now() < deadline; i++) {
					if (list.members[i] !== 'pending' || list.state !== 'done') continue;
					processed++;
					try {
						if (!target) throw new Error('Destination list was removed');
						const member = list.source.members[i];
						const uri = new URL(member.uri);
						const own = uri.origin === new URL(this.config.url).origin && /^\/users\/[a-zA-Z0-9]+$/.test(uri.pathname);
						const user = own ? await this.db.getRepository(MiUser).findOneByOrFail({ id: uri.pathname.split('/').at(-1), host: IsNull() }) : await this.db.getRepository(MiUser).findOneBy({ uri: member.uri }) ?? await this.people.resolvePerson(member.uri);
						await check();
						if (user.isDeleted || user.isSuspended || await this.db.getRepository(MiBlocking).existsBy([{ blockerId: user.id, blockeeId: me.id }, { blockerId: me.id, blockeeId: user.id }])) throw new Error('Unavailable member');
						if (!await this.db.getRepository(MiUserListMembership).existsBy({ userListId: target.id, userId: user.id })) {
							await this.lists.addMember(user, target, me, { withReplies: member.withReplies, receipt: async manager => { list.members[i] = 'done'; await saveAtomic(manager); } });
						}
						list.members[i] = 'done';
					} catch (error) {
						if (error instanceof GridspaceLinkError) throw error;
						const persisted = (await this.registry.getItem(me.id, settingsDomain, scope, key))!.value as Job;
						list.members[i] = persisted.lists.find(l => l.targetId === list.targetId)!.members[i] === 'done' ? 'done' : 'failed';
					}
					await save();
				}
			}
		}
		const states = job.lists.flatMap(list => [list.state, ...list.members]);
		const done = states.filter(s => s === 'done').length;
		const failed = states.filter(s => s === 'failed').length;
		// A failed list cannot advance its children until explicitly retried.
		const pending = job.lists.reduce((n, list) => n + (list.state === 'pending' ? 1 : 0) + (list.state === 'failed' ? 0 : list.members.filter(s => s === 'pending').length), 0);
		return { started: true, complete: done === states.length, total: states.length, done, failed, pending };
	}
}
