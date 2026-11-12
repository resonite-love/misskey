/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiMuting } from '@/models/Muting.js';
import { MiBlocking } from '@/models/Blocking.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import { UserMutingService } from '@/core/UserMutingService.js';
import { RegistryApiService } from '@/core/RegistryApiService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { GridspaceLinkError, GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspaceFollowGuardService } from '@/core/gridspace/GridspaceFollowGuardService.js';
import { settingsDomain, selectAccountSettings, type SettingsSnapshot } from '@/core/gridspace/settings-protocol.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import type Update from '../i/update.js';
import type Block from '../blocking/create.js';
import type Mute from '../mute/create.js';

const count = { type: 'integer', optional: false, nullable: false } as const;
export const meta = {
	tags: ['account'], requireCredential: true, secure: true, prohibitMoved: true,
	description: 'Import explicitly selected linked account settings and process restrictions in resumable batches.',
	limit: { duration: 60000, max: 60 },
	errors: { unavailable: { message: 'Linked settings import is unavailable.', code: 'GRIDSPACE_SETTINGS_UNAVAILABLE', id: '52c63796-e285-4b26-97ef-4fe3d227ca5c' } },
	res: { type: 'object', optional: false, nullable: false, properties: {
		requestId: { type: 'string', optional: false, nullable: true },
		client: { type: 'string', optional: false, nullable: true },
		accountApplied: { type: 'boolean', optional: false, nullable: false },
		complete: { type: 'boolean', optional: false, nullable: false },
		total: count, done: count, failed: count, pending: count,
	} },
} as const;
export const paramDef = { type: 'object', properties: {
	action: { type: 'string', enum: ['start', 'step', 'status', 'retry'], default: 'status' },
	requestId: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
}, required: [] } as const;
type Job = { requestId: string; linkId: string; generation: number; credentialHash: string; peerUserId: string; peerOrigin: string; accountApplied: boolean; snapshot: SettingsSnapshot; states: ('pending' | 'done' | 'failed')[] };
const scope = ['gridspace', 'settingsImport'];

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private links: GridspaceLinkService,
		private guard: GridspaceFollowGuardService,
		private registry: RegistryApiService,
		private people: ApPersonService,
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.config) private config: Config,
		@Inject('ep:i/update') private update: Update,
		@Inject('ep:blocking/create') private block: Block,
		@Inject('ep:mute/create') private mute: Mute,
		private muting: UserMutingService,
	) {
		super(meta, paramDef, async (ps, me) => {
			try { return await guard.runProfile(me.id, () => this.run(ps, me)); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}

	private async run(ps: { action: string; requestId?: string }, me: MiLocalUser) {
		if (this.config.gridspace?.channelRole !== 'client') throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		let job = (await this.registry.getItem(me.id, settingsDomain, scope, 'current'))?.value as Job | undefined;
		const save = () => this.registry.set(me.id, settingsDomain, scope, 'current', job!);
		if (ps.action === 'start' && (!job || job.requestId !== ps.requestId)) {
			if (!ps.requestId) throw new GridspaceLinkError('INVALID_CALLBACK');
			const source = await this.links.settings(me);
			job = { requestId: ps.requestId, linkId: source.linkId, generation: source.generation, credentialHash: source.credentialHash, peerUserId: source.peerUserId, peerOrigin: source.peerOrigin, accountApplied: false, snapshot: source.settings, states: source.settings.restrictions.map(() => 'pending') };
			await save();
		}
		if (!job) return { requestId: null, client: null, accountApplied: false, complete: false, total: 0, done: 0, failed: 0, pending: 0 };
		const check = async () => {
			const link = await this.links.checkSettingsAuthorization(me);
			if (link.linkId !== job!.linkId || link.generation !== job!.generation || link.credentialHash !== job!.credentialHash || link.peerUserId !== job!.peerUserId || link.peerOrigin !== job!.peerOrigin) throw new GridspaceLinkError('LINK_REVOKED');
		};
		await check();
		if (ps.action !== 'status') {
			if (ps.requestId !== job.requestId) throw new GridspaceLinkError('INVALID_CALLBACK');
			if (!job.accountApplied) {
				const patch = selectAccountSettings(job.snapshot.account);
				if (patch.notificationRecieveConfig) {
					const current = await this.db.getRepository(MiUserProfile).findOneByOrFail({ userId: me.id });
					const portable = Object.fromEntries(Object.entries(patch.notificationRecieveConfig as Record<string, { type: string }>).filter(([, value]) => value?.type !== 'list'));
					patch.notificationRecieveConfig = { ...current.notificationRecieveConfig, ...portable };
				}
				await this.update.exec(patch, me, null);
				job.accountApplied = true; await save();
			}
			if (ps.action === 'retry') { job.states = job.states.map(state => state === 'failed' ? 'pending' : state); await save(); }
			let processed = 0;
			const deadline = Date.now() + 5000;
			for (let i = 0; i < job.states.length && processed < 5; i++) {
				if (processed > 0 && Date.now() >= deadline) break;
				if (job.states[i] !== 'pending') continue;
				processed++;
				const item = job.snapshot.restrictions[i];
				try {
					if (item.kind === 'mute' && item.expiresAt !== null && item.expiresAt <= Date.now()) { job.states[i] = 'done'; await save(); continue; }
					const url = new URL(item.uri);
					const ownId = url.origin === new URL(this.config.url).origin && /^\/users\/[a-zA-Z0-9]+$/.test(url.pathname) ? url.pathname.split('/').at(-1) : null;
					const target = ownId ? await this.db.getRepository(MiUser).findOneByOrFail({ id: ownId, host: IsNull() }) :
						await this.db.getRepository(MiUser).findOneBy({ uri: item.uri }) ?? await this.people.resolvePerson(item.uri);
					await check();
					if (target.id !== me.id) {
						if (item.kind === 'block') {
							if (!await this.db.getRepository(MiBlocking).existsBy({ blockerId: me.id, blockeeId: target.id })) await this.block.exec({ userId: target.id }, me, null);
						} else if (!await this.db.getRepository(MiMuting).existsBy({ muterId: me.id, muteeId: target.id })) {
							await this.mute.exec({ userId: target.id, expiresAt: item.expiresAt }, me, null);
						} else {
							if (!await this.muting.extendMute(me.id, target.id, item.expiresAt === null ? null : new Date(item.expiresAt))) await this.mute.exec({ userId: target.id, expiresAt: item.expiresAt }, me, null);
						}
					}
					job.states[i] = 'done';
				} catch (error) {
					if (error instanceof GridspaceLinkError) throw error;
					job.states[i] = ['ALREADY_BLOCKING', 'ALREADY_MUTING'].includes((error as { code?: string }).code ?? '') ? 'done' : 'failed';
				}
				await save();
			}
		}
		const done = job.states.filter(state => state === 'done').length;
		const failed = job.states.filter(state => state === 'failed').length;
		return { requestId: job.requestId, client: job.snapshot.client, accountApplied: job.accountApplied, complete: job.accountApplied && done === job.states.length, total: job.states.length, done, failed, pending: job.states.length - done - failed };
	}
}
