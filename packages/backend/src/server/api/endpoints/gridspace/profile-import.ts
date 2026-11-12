/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import { DriveService } from '@/core/DriveService.js';
import { RegistryApiService } from '@/core/RegistryApiService.js';
import { GridspaceLinkError, GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspaceFollowGuardService } from '@/core/gridspace/GridspaceFollowGuardService.js';
import { profileFields, profileValueIsEmpty, type ProfileField } from '@/core/gridspace/profile-protocol.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import type Update from '../i/update.js';

const fieldsSchema = { type: 'array', optional: false, nullable: false, items: { type: 'string', enum: [...profileFields] } } as const;
export const meta = {
	tags: ['account'], requireCredential: true, secure: true, prohibitMoved: true,
	description: 'Copy unset profile fields once from the authorized linked source account.',
	limit: { duration: 3600000, max: 10 },
	errors: { unavailable: { message: 'Linked profile import is unavailable.', code: 'GRIDSPACE_PROFILE_UNAVAILABLE', id: 'da41555d-8388-4e1f-8982-ac358bc9339f' } },
	res: { type: 'object', optional: false, nullable: false, properties: {
		copied: fieldsSchema, skipped: fieldsSchema, failed: fieldsSchema,
		complete: { type: 'boolean', optional: false, nullable: false },
	} },
} as const;
export const paramDef = { type: 'object', properties: {}, required: [] } as const;
const scope = ['gridspace', 'profileImport'];

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private links: GridspaceLinkService,
		private guard: GridspaceFollowGuardService,
		@Inject(DI.db) private db: DataSource,
		private drive: DriveService,
		private registry: RegistryApiService,
		@Inject('ep:i/update') private update: Update,
	) {
		super(meta, paramDef, async (_ps, me) => {
			try { return await this.guard.runProfile(me.id, () => this.copy(me)); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}

	private async copy(me: MiLocalUser) {
		const binding = await this.links.privateLink(me.id);
		const source = await this.links.profile(me);
		const key = JSON.stringify([source.peerOrigin, source.peerUserId]);
		const receipt = (await this.registry.getItem(me.id, null, scope, key))?.value;
		const copied = new Set<ProfileField>(profileFields.filter(field => receipt?.copied?.includes(field)));
		const skipped = new Set<ProfileField>(profileFields.filter(field => receipt?.skipped?.includes(field)));
		const failed = new Set<ProfileField>();
		const save = () => this.registry.set(me.id, null, scope, key, { copied: [...copied], skipped: [...skipped] });
		const current = async () => ({
			...await this.db.getRepository(MiUserProfile).findOneByOrFail({ userId: me.id }),
			...await this.db.getRepository(MiUser).findOneByOrFail({ id: me.id }),
		});
		// Use the ordinary profile update path for validation, media policies,
		// ActivityPub updates, hashtags, cached entities and streaming events.
		const apply = async (values: Record<string, unknown>, fields: ProfileField[]) => {
			await this.links.profile(me); // Recheck source consent after asynchronous downloads.
			const currentLink = await this.links.privateLink(me.id);
			if (currentLink.id !== binding.id || currentLink.generation !== binding.generation || currentLink.tokenCipher !== binding.tokenCipher ||
				currentLink.peerUserId !== source.peerUserId || currentLink.peerOrigin !== source.peerOrigin) throw new GridspaceLinkError('LINK_REVOKED');
			const latest = await current();
			const patch: Record<string, unknown> = {};
			for (const field of fields) {
				if (!profileValueIsEmpty(latest[field])) skipped.add(field);
				else patch[field] = values[field];
			}
			if (Object.keys(patch).length) {
				try {
					await this.update.exec(patch, me, null);
					for (const field of fields) if (field in patch) copied.add(field);
				} catch { for (const field of fields) if (field in patch) failed.add(field); }
			}
			await save();
		};
		const destination = await current();
		const text: Record<string, unknown> = {};
		for (const field of profileFields) {
			if (copied.has(field) || skipped.has(field)) continue;
			if (!profileValueIsEmpty(destination[field])) { skipped.add(field); continue; }
			if (field === 'avatarId' || field === 'bannerId') continue;
			if (profileValueIsEmpty(source.profile[field])) skipped.add(field);
			else text[field] = source.profile[field];
		}
		await save();
		if (Object.keys(text).length) await apply(text, Object.keys(text) as ProfileField[]);
		for (const field of ['avatarId', 'bannerId'] as const) {
			if (copied.has(field) || skipped.has(field)) continue;
			const url = source.profile[field === 'avatarId' ? 'avatarUrl' : 'bannerUrl'];
			if (!url) { skipped.add(field); await save(); continue; }
			let file;
			try { file = await this.drive.uploadFromUrl({ url, user: me }); } catch { failed.add(field); continue; }
			await apply({ [field]: file.id }, [field]);
		}
		return { copied: [...copied], skipped: [...skipped], failed: [...failed], complete: failed.size === 0 };
	}
}
