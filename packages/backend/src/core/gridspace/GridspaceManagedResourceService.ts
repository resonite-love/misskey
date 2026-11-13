/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DataSource, IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiGridspaceLink } from '@/models/Gridspace.js';
import { MiAntenna } from '@/models/Antenna.js';
import { MiPage } from '@/models/Page.js';
import { MiClip } from '@/models/Clip.js';
import { MiGalleryPost } from '@/models/GalleryPost.js';
import { MiNote } from '@/models/Note.js';
import { ApNoteService } from '@/core/activitypub/models/ApNoteService.js';
import { MiRegistryItem } from '@/models/RegistryItem.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { GridspaceNoteService } from './GridspaceNoteService.js';
import { attachContentEmojis, type ContentEmojiCarrier } from './content-emojis.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceLinkService } from './GridspaceLinkService.js';
import { GridspaceSharedDriveService } from './GridspaceSharedDriveService.js';
import { gridspaceHash } from './link-crypto.js';
import { settingsDomain } from './settings-protocol.js';
import { managedError, managedId, type ManagedInput, type ManagedPeerInput, type ManagedKind } from './managed-resource-protocol.js';

type Item = Record<string, unknown>;
type Result = { enabled: boolean; origin: string | null; item: Item | null; items: Item[]; aliases: { sourceId: string; targetId: string }[]; clipNoteError?: 'already-added' | 'too-many' };
const resources = {
	antenna: { entity: MiAntenna, prefix: 'antennas', key: 'antennaId', list: 'antennas/list' },
	page: { entity: MiPage, prefix: 'pages', key: 'pageId', list: 'i/pages' },
	clip: { entity: MiClip, prefix: 'clips', key: 'clipId', list: 'clips/list' },
	gallery: { entity: MiGalleryPost, prefix: 'gallery/posts', key: 'postId', list: 'i/gallery/posts' },
} as const;

/** Only the four explicitly listed native resources can be managed across the pair. */
@Injectable()
export class GridspaceManagedResourceService {
	constructor(@Inject(DI.db) private db: DataSource, @Inject(DI.config) private config: Config,
		private modules: ModuleRef, private links: GridspaceLinkService, private drive: GridspaceSharedDriveService,
		private events: GlobalEventService, private emojis: CustomEmojiService) {}

	private async pair(userId: string) {
		if (!this.config.gridspace?.enabled) return null;
		if (!await this.db.getRepository(MiUser).existsBy({ id: userId, host: IsNull(), isDeleted: false, isSuspended: false, movedToUri: IsNull() })) return null;
		return this.db.getRepository(MiGridspaceLink).findOneBy({ localUserId: userId, peerOrigin: new URL(this.config.gridspace.peerUrl).origin, state: 'active', driveShared: true });
	}

	private async native(path: string, data: Item, user: MiLocalUser): Promise<unknown> {
		return this.modules.get<{ exec: (data: Item, user: MiLocalUser, token: null) => Promise<unknown> }>(`ep:${path}`, { strict: false }).exec(data, user, null);
	}

	private async aliases(user: MiLocalUser, link: MiGridspaceLink) {
		const receipt = await this.db.getRepository(MiRegistryItem).createQueryBuilder('item')
			.where('item.userId = :userId AND item.domain = :domain AND item.scope = :scope AND item.key = :key', {
				userId: user.id, domain: settingsDomain, scope: ['gridspace', 'listImport'], key: gridspaceHash(`${link.peerOrigin}:${link.peerUserId}`),
			}).getOne();
		const value = receipt?.value as { antennas?: { source: { id: string }; targetId: string; state: string }[] } | undefined;
		return (value?.antennas ?? []).filter(row => row.state === 'done').map(row => ({ sourceId: row.source.id, targetId: row.targetId }));
	}

	public async peer(input: ManagedPeerInput): Promise<Result> {
		const link = await this.pair(input.peerUserId);
		if (!link || link.id !== input.linkId || link.generation !== input.generation || link.peerUserId !== input.localUserId) throw new ApiError(managedError);
		const user = await this.db.getRepository(MiUser).findOneByOrFail({ id: link.localUserId });
		const resource = resources[input.kind];
		if (!resource) throw new ApiError(managedError);
		const result: Result = { enabled: true, origin: new URL(this.config.url).origin, item: null, items: [], aliases: [] };
		if (input.action === 'list') {
			result.items = await this.native(resource.list, { ...input.data, limit: Math.min(100, Number(input.data?.limit ?? 100)) }, user as MiLocalUser) as Item[];
			if (input.kind === 'antenna') {
				const copies = new Set((await this.aliases(user as MiLocalUser, link)).map(row => row.targetId));
				result.items = result.items.filter(item => !copies.has(String(item.id)));
			}
		} else if (input.action === 'lists' && input.kind === 'antenna') {
			result.items = await this.native('users/lists/list', {}, user as MiLocalUser) as Item[];
		} else {
			if (!input.id || !await this.db.getRepository(resource.entity).existsBy({ id: input.id, userId: user.id })) throw new ApiError(managedError);
			const action = input.action;
			if (input.kind === 'clip' && (action === 'add-note' || action === 'remove-note')) {
				const noteId = await this.clipNote(input.data?.noteUrl, user as MiLocalUser, link, action === 'add-note');
				const current = await this.pair(user.id);
				if (!current || current.id !== link.id || current.generation !== link.generation) throw new ApiError(managedError);
				try {
					await this.native(`clips/${action}`, { clipId: input.id, noteId }, user as MiLocalUser);
				} catch (error) {
					if (error instanceof ApiError && error.code === 'ALREADY_CLIPPED') result.clipNoteError = 'already-added';
					else if (error instanceof ApiError && error.code === 'TOO_MANY_CLIP_NOTES') result.clipNoteError = 'too-many';
					else throw error;
				}
			} else {
				if (!['show', 'update', 'delete'].includes(action)) throw new ApiError(managedError);
				const data = input.kind === 'page' && input.data ? await this.pageNotes(input.data, user as MiLocalUser, link) as Item : input.data;
				const response = await this.native(`${resource.prefix}/${action}`, { ...(data ?? {}), [resource.key]: input.id }, user as MiLocalUser);
				if (action !== 'delete') result.item = (response ?? await this.native(`${resource.prefix}/show`, { [resource.key]: input.id }, user as MiLocalUser)) as Item;
			}
		}
		// Revocation/suspension during a request must not return private resource data.
		const current = await this.pair(user.id);
		if (!current || current.id !== link.id || current.generation !== link.generation) throw new ApiError(managedError);
		if (input.kind === 'page' || input.kind === 'gallery') {
			await Promise.all((result.item ? [result.item] : result.items).map(item => attachContentEmojis(item as ContentEmojiCarrier, this.emojis, result.origin!)));
		}
		return result;
	}

	private async clipNote(value: unknown, user: MiLocalUser, link: MiGridspaceLink, adding: boolean): Promise<string> {
		if (typeof value !== 'string') throw new ApiError(managedError);
		const uri = new URL(value);
		if (!['https:', 'http:'].includes(uri.protocol) || uri.username || uri.password || uri.hash) throw new ApiError(managedError);
		let note: MiNote | null;
		if (uri.origin === new URL(this.config.url).origin) {
			if (!/^\/notes\/[a-zA-Z0-9]{1,32}$/.test(uri.pathname) || uri.search) throw new ApiError(managedError);
			note = await this.db.getRepository(MiNote).findOneBy({ id: uri.pathname.split('/').at(-1)! });
		} else {
			note = await this.db.getRepository(MiNote).findOneBy({ uri: uri.href });
			if (adding && !note && uri.origin === link.peerOrigin && /^\/notes\/[a-zA-Z0-9]{1,32}$/.test(uri.pathname) && !uri.search) {
				note = await this.modules.get(GridspaceNoteService, { strict: false }).historyNote(uri.pathname.split('/').at(-1)!, { remaining: 20, deadline: Date.now() + 8000 });
			} else if (adding && !note) {
				if (!this.modules.get(UtilityService, { strict: false }).isFederationAllowedUri(uri.href)) throw new ApiError(managedError);
				note = await this.modules.get(ApNoteService, { strict: false }).resolveNote(uri.href);
			}
		}
		if (!note) throw new ApiError(managedError);
		if (adding) {
			const visible = await this.native('notes/show', { noteId: note.id }, user) as Item;
			if (visible.isHidden) throw new ApiError(managedError);
		}
		return note.id;
	}

	private async pageNotes(value: unknown, user: MiLocalUser, link: MiGridspaceLink): Promise<unknown> {
		if (Array.isArray(value)) return Promise.all(value.map(item => this.pageNotes(item, user, link)));
		if (!value || typeof value !== 'object') return value;
		const result = { ...value } as Item;
		if (result.type === 'note' && typeof result.note === 'string' && /^https?:/.test(result.note)) {
			const uri = new URL(result.note);
			if (![new URL(this.config.url).origin, link.peerOrigin].includes(uri.origin) || !/^\/notes\/[a-zA-Z0-9]+$/.test(uri.pathname)) throw new ApiError(managedError);
			let id: string;
			if (uri.origin === new URL(this.config.url).origin) id = uri.pathname.split('/').at(-1)!;
			else {
				const note = await this.db.getRepository(MiNote).findOneBy({ uri: uri.href }) ?? await this.modules.get(ApNoteService, { strict: false }).resolveNote(uri.href);
				if (!note) throw new ApiError(managedError);
				id = note.id;
			}
			const visible = await this.native('notes/show', { noteId: id }, user) as Item;
			if (visible.isHidden) throw new ApiError(managedError);
			result.note = id;
		}
		for (const key of ['content', 'children']) if (Array.isArray(result[key])) result[key] = await this.pageNotes(result[key], user, link);
		return result;
	}

	private async files(value: unknown, convert: (id: string) => Promise<string>): Promise<unknown> {
		if (Array.isArray(value)) return Promise.all(value.map(item => this.files(item, convert)));
		if (!value || typeof value !== 'object') return value;
		const result = { ...value } as Item;
		for (const [key, item] of Object.entries(result)) {
			if (['fileId', 'eyeCatchingImageId'].includes(key) && typeof item === 'string') result[key] = await convert(item);
			else if (key === 'fileIds' && Array.isArray(item)) result[key] = await Promise.all(item.map(id => convert(String(id))));
			else if (['content', 'children'].includes(key)) result[key] = await this.files(item, convert);
		}
		return result;
	}

	public async request(user: MiLocalUser, input: ManagedInput): Promise<Result> {
		const link = await this.pair(user.id);
		if (!link) {
			if (input.action === 'list') return { enabled: false, origin: null, item: null, items: [], aliases: [] };
			throw new ApiError(managedError);
		}
		let data = input.data && ['page', 'gallery'].includes(input.kind)
			? await this.files(input.data, id => this.drive.fileIdOnPeer(user, id)) as Item : input.data;
		if (input.kind === 'clip' && ['add-note', 'remove-note'].includes(input.action)) {
			if (typeof input.data?.noteId !== 'string' || !/^[a-zA-Z0-9]{1,32}$/.test(input.data.noteId)) throw new ApiError(managedError);
			const note = await this.db.getRepository(MiNote).findOneBy({ id: input.data.noteId });
			if (!note) throw new ApiError(managedError);
			if (input.action === 'add-note') {
				const visible = await this.native('notes/show', { noteId: note.id }, user) as Item;
				if (visible.isHidden) throw new ApiError(managedError);
			}
			// Use a server-owned canonical URI. Never forward a browser-supplied URL or credentials.
			data = { noteUrl: note.uri ?? `${new URL(this.config.url).origin}/notes/${note.id}` };
		}
		const result = await this.links.json<Result>('/gridspace/v1/managed-resource', { ...input, data, linkId: link.id, generation: link.generation, localUserId: user.id, peerUserId: link.peerUserId });
		const current = await this.pair(user.id);
		if (!current || current.id !== link.id || current.generation !== link.generation || result.origin !== link.peerOrigin) throw new ApiError(managedError);
		if (input.kind === 'antenna' && input.action === 'list') {
			result.aliases = await this.aliases(user, link);
			for (const alias of result.aliases) {
				const copy = await this.db.getRepository(MiAntenna).findOneBy({ id: alias.targetId, userId: user.id, isActive: true });
				if (copy) {
					await this.db.getRepository(MiAntenna).update(copy.id, { isActive: false });
					this.events.publishInternalEvent('antennaDeleted', copy);
				}
			}
		}
		if (result.item && ['page', 'gallery'].includes(input.kind)) {
			result.item = await this.files(result.item, async id => {
				const file = await this.drive.referenceFile(user, id);
				if (!file) throw new ApiError(managedError);
				return file.id;
			}) as Item;
			for (const key of ['files', 'attachedFiles']) {
				const files = result.item[key];
				if (Array.isArray(files)) result.item[key] = await Promise.all(files.map(async file => this.drive.referenceFile(user, String(file.id))));
			}
		}
		for (const item of input.action === 'lists' ? [] : result.item ? [result.item] : result.items) {
			item.gridspaceOriginalId = item.id;
			item.id = managedId(input.kind, String(item.id));
			item.gridspaceManagedId = item.id;
			item.gridspaceOrigin = result.origin;
			if (item.user && typeof item.user === 'object') item.user = { ...item.user, host: new URL(result.origin!).host };
		}
		const final = await this.pair(user.id);
		if (!final || final.id !== link.id || final.generation !== link.generation) throw new ApiError(managedError);
		return result;
	}
}
