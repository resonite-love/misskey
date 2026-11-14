/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiClip } from '@/models/Clip.js';
import { ClipEntityService } from '@/core/entities/ClipEntityService.js';
import { MiPage } from '@/models/Page.js';
import { MiGalleryPost } from '@/models/GalleryPost.js';
import { MiUser } from '@/models/User.js';
import { MiGridspaceLink } from '@/models/Gridspace.js';
import { managedId } from './managed-resource-protocol.js';
import { PageEntityService } from '@/core/entities/PageEntityService.js';
import { GalleryPostEntityService } from '@/core/entities/GalleryPostEntityService.js';
import { IdService } from '@/core/IdService.js';
import { MetaService } from '@/core/MetaService.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { attachContentEmojis } from './content-emojis.js';
import { GridspaceHistoryService } from './GridspaceHistoryService.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import type { ContentOptions, ContentPage } from './content-protocol.js';

@Injectable()
export class GridspaceContentService {
	constructor(
		@Inject(DI.db) private db: DataSource, @Inject(DI.config) private config: Config,
		private pages: PageEntityService, private gallery: GalleryPostEntityService,
		private links: GridspaceLinkService, private history: GridspaceHistoryService, private meta: MetaService, private ids: IdService,
		private emojis: CustomEmojiService, private clips: ClipEntityService,
	) {}

	/** Public content only: a guessed ID must never bypass Page.visibility. */
	public async peer(input: ContentOptions): Promise<ContentPage> {
		const origin = new URL(this.config.url).origin;
		const query = input.kind === 'clips' ? this.db.getRepository(MiClip).createQueryBuilder('item') : input.kind === 'pages' ? this.db.getRepository(MiPage).createQueryBuilder('item') : this.db.getRepository(MiGalleryPost).createQueryBuilder('item');
		query.innerJoin(MiUser, 'author', 'author.id = item.userId')
			.where('author.host IS NULL AND author.isSuspended = false AND author.isDeleted = false');
		if (input.kind === 'clips') query.andWhere('item.isPublic = true');
		if (input.kind === 'pages') query.andWhere('item.visibility = :visibility', { visibility: 'public' });
		if (input.userId) query.andWhere('item.userId = :userId', { userId: input.userId });
		if (input.itemId) query.andWhere('item.id = :itemId', { itemId: input.itemId });
		if (input.after) query.andWhere('item.id > :after', { after: input.after });
		if (input.sinceDate) query.andWhere('item.id > :since', { since: this.ids.gen(input.sinceDate) });
		if (input.untilDate) query.andWhere('item.id < :until', { until: this.ids.gen(input.untilDate) });
		if (input.before) query.andWhere('item.id < :before', { before: input.before });
		// Featured lists are bounded snapshots; chronological lists use an ID keyset.
		if (input.kind !== 'clips' && input.mode === 'featured' && !input.itemId && !input.userId) query.andWhere('item.likedCount > 0').orderBy('item.likedCount', 'DESC');
		query.addOrderBy('item.id', input.after || input.sinceDate ? 'ASC' : 'DESC');
		const limit = input.itemId ? 1 : input.limit ?? 12;
		const rows = await query.take(limit + 1).getMany();
		const selected = rows.slice(0, limit);
		const result = { origin, pages: input.kind === 'pages' ? await this.pages.packMany(selected as MiPage[]) : [],
			gallery: input.kind === 'gallery' ? await this.gallery.packMany(selected as MiGalleryPost[]) : [],
			clips: input.kind === 'clips' ? await this.clips.packMany(selected as MiClip[]) : [],
			next: input.mode !== 'featured' && rows.length > limit ? selected.at(-1)!.id : null };
		await Promise.all([...result.pages, ...result.gallery, ...result.clips].map(item => attachContentEmojis(item, this.emojis, origin)));
		return result;
	}

	public async list(input: ContentOptions, authenticated: boolean, viewerId?: string): Promise<ContentPage> {
		const empty: ContentPage = { origin: null, pages: [], gallery: [], clips: [], next: null };
		if (!this.config.gridspace?.enabled) return empty;
		if (!authenticated && (await this.meta.fetch()).ugcVisibilityForVisitor !== 'all') return empty;
		const origin = new URL(this.config.gridspace.peerUrl).origin;
		let userId: string | undefined;
		if (input.userId) {
			const user = await this.db.getRepository(MiUser).findOneBy({ id: input.userId, isDeleted: false, isSuspended: false });
			if (!user) return empty;
			const prefix = `${origin}/users/`;
			if (user.host && user.uri?.startsWith(prefix)) userId = user.uri.slice(prefix.length);
			else userId = (await this.history.findLink(user.id))?.peerUserId;
			if (!userId) return empty;
		}
		const result = await this.links.json<ContentPage>('/gridspace/v1/content', { ...input, userId });
		result.clips ??= [];
		if (result.origin !== origin || !Array.isArray(result.pages) || !Array.isArray(result.gallery) || !Array.isArray(result.clips) || result.pages.length + result.gallery.length + result.clips.length > (input.itemId ? 1 : input.limit ?? 12)) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		const items = [...result.pages, ...result.gallery, ...result.clips];
		const ascending = Boolean(input.after || input.sinceDate);
		if ((items.length !== (input.kind === 'clips' ? result.clips : input.kind === 'pages' ? result.pages : result.gallery).length) || (result.next !== null && (!items.length || result.next !== items.at(-1)!.id || input.itemId || input.mode === 'featured'))) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		for (let index = 0; index < items.length; index++) {
			const item = items[index];
			if (input.kind === 'clips' && (!('isPublic' in item) || !item.isPublic)) throw new GridspaceLinkError('PEER_UNAVAILABLE');
			if (input.itemId && item.id !== input.itemId || userId && item.userId !== userId || input.before && item.id >= input.before || input.after && item.id <= input.after || input.mode !== 'featured' && index > 0 && (ascending ? item.id <= items[index - 1].id : item.id >= items[index - 1].id)) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		}

		const authors = items.map(item => `${origin}/users/${item.userId}`);
		const known = authors.length ? await this.db.getRepository(MiUser).findBy({ uri: In(authors) }) : [];
		const ownLink = viewerId ? await this.db.getRepository(MiGridspaceLink).findOneBy({ localUserId: viewerId, peerOrigin: origin, state: 'active', driveShared: true }) : null;
		for (const item of items) {
			if (!/^[a-zA-Z0-9]{1,32}$/.test(item.id) || !/^[a-zA-Z0-9]{1,32}$/.test(item.userId) || item.user.host != null) throw new GridspaceLinkError('PEER_UNAVAILABLE');
			item.gridspaceOrigin = origin;
			if (('attachedFiles' in item || 'files' in item) && input.kind !== 'clips' && ownLink?.peerUserId === item.userId) item.gridspaceManagedId = managedId(input.kind === 'pages' ? 'page' : 'gallery', item.id);
			const files = 'attachedFiles' in item ? [...item.attachedFiles, ...(item.eyeCatchingImage ? [item.eyeCatchingImage] : [])] : 'files' in item ? item.files ?? [] : [];
			for (const file of files) file.gridspaceOrigin = origin;
			item.user = { ...item.user, host: new URL(origin).host, id: known.find(user => user.uri === `${origin}/users/${item.userId}`)?.id ?? `gridspace:${item.userId}` };
			item.userId = item.user.id;
		}
		return result;
	}
}
