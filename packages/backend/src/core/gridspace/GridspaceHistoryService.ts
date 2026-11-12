/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import { MiUser } from '@/models/User.js';
import { MiNote } from '@/models/Note.js';
import { MiGridspaceLink } from '@/models/Gridspace.js';
import type { MiMeta } from '@/models/Meta.js';
import { IdService } from '@/core/IdService.js';
import { QueryService } from '@/core/QueryService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { GridspaceNoteService } from './GridspaceNoteService.js';
import { resolveGridspaceConfig, type GridspacePeerConfig } from './peer-protocol.js';
import { requestGridspacePeer } from './peer-client.js';
import { decodeHistoryCursor, encodeHistoryCursor, mergeHistory, validateHistoryPage, type HistoryOptions, type HistoryPeerRequest } from './history-protocol.js';

export class GridspaceHistoryError extends Error {
	constructor(public readonly code: 'LINK_UNAVAILABLE' | 'INVALID_CURSOR' | 'PEER_UNAVAILABLE') { super(code); }
}

@Injectable()
export class GridspaceHistoryService {
	private readonly peer: GridspacePeerConfig | null;

	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.config) config: Config,
		@Inject(DI.meta) private meta: MiMeta,
		private ids: IdService,
		private queries: QueryService,
		private users: UserEntityService,
		private notes: NoteEntityService,
		private people: ApPersonService,
		private sharedNotes: GridspaceNoteService,
	) { this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env); }

	private async findLink(userId: string): Promise<MiGridspaceLink | null> {
		if (!this.peer) return null;
		const user = await this.db.getRepository(MiUser).findOneBy({ id: userId, isDeleted: false, isSuspended: false });
		if (!user) return null;
		const links = this.db.getRepository(MiGridspaceLink);
		if (user.host == null) return links.findOneBy({ localUserId: user.id, peerOrigin: this.peer.peerOrigin, state: 'active' });
		const prefix = this.peer.peerOrigin + '/users/';
		if (!user.uri?.startsWith(prefix)) return null;
		return links.findOneBy({ peerUserId: user.uri.slice(prefix.length), peerOrigin: this.peer.peerOrigin, state: 'active' });
	}

	private input(link: MiGridspaceLink, viewer: MiLocalUser | null, options: HistoryOptions, limit: number, before?: string): HistoryPeerRequest {
		return { userId: link.peerUserId, counterpartId: link.localUserId, linkId: link.id, generation: link.generation,
			viewerId: viewer?.id, ...options, limit, before };
	}

	private async remote(input: HistoryPeerRequest) {
		try {
			return validateHistoryPage(await requestGridspacePeer(this.peer!, '/gridspace/v1/history', input, 16384), input.limit, input.before);
		} catch { throw new GridspaceHistoryError('PEER_UNAVAILABLE'); }
	}

	public async member(userId: string, viewer: MiLocalUser | null) {
		const empty = { enabled: this.peer != null, linked: false, available: true, accounts: [] as Awaited<ReturnType<UserEntityService['pack']>>[] };
		const link = await this.findLink(userId);
		if (!link) return empty;
		try {
			const remote = await this.remote(this.input(link, viewer, { withReplies: false, withRenotes: false, withFiles: false }, 0));
			if (!remote.active || !await this.active(link)) return empty;
			const local = await this.db.getRepository(MiUser).findOneBy({ id: link.localUserId, isDeleted: false, isSuspended: false });
			if (!local) return empty;
			const other = await this.people.resolvePerson(`${this.peer!.peerOrigin}/users/${link.peerUserId}`);
			if (other.isDeleted || other.isSuspended) return empty;
			return { ...empty, linked: true, accounts: [await this.users.pack(local, viewer), await this.users.pack(other, viewer)] };
		} catch (error) {
			if (error instanceof GridspaceHistoryError) return { ...empty, linked: true, available: false };
			throw error;
		}
	}

	private active(link: MiGridspaceLink) {
		return this.db.getRepository(MiGridspaceLink).existsBy({ id: link.id, generation: link.generation, state: 'active' });
	}

	private query(userId: string, viewer: { id: string } | null, options: HistoryOptions, before?: string, head?: string) {
		const query = this.db.getRepository(MiNote).createQueryBuilder('note')
			.where('note.userId = :author', { author: userId })
			.andWhere('note.channelId IS NULL')
			.andWhere('note.visibility IN (:...visibility)', { visibility: ['public', 'home'] })
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply').leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('note.renote', 'renote').leftJoinAndSelect('renote.user', 'renoteUser');
		if (before) query.andWhere('note.id < :before', { before });
		if (head) query.andWhere('note.id <= :head', { head });
		if (!options.withReplies) query.andWhere('note.replyId IS NULL');
		if (!options.withRenotes) query.andWhere('(note.renoteId IS NULL OR note.text IS NOT NULL OR note.fileIds != \'{}\' OR note.hasPoll = true)');
		if (options.withFiles) query.andWhere('note.fileIds != \'{}\'');
		// The explicit public/home predicate above is the visibility boundary. Visitor policy is
		// applied by each caller so authenticated, uncached peer visitors do not become anonymous.
		this.queries.generateBaseNoteFilteringQuery(query, viewer);
		if (viewer) {
			query.andWhere('NOT EXISTS (SELECT 1 FROM blocking b WHERE b."blockerId" = :viewer AND b."blockeeId" = note."userId")', { viewer: viewer.id });
		}
		return query.orderBy('note.id', 'DESC');
	}

	/** Only public/home source records cross this endpoint; a linked identity grants no private access. */
	public async peerHistory(input: HistoryPeerRequest) {
		if (!this.peer) throw new GridspaceHistoryError('LINK_UNAVAILABLE');
		const link = await this.db.getRepository(MiGridspaceLink).findOneBy({ id: input.linkId, generation: input.generation,
			localUserId: input.userId, peerUserId: input.counterpartId, peerOrigin: this.peer.peerOrigin, state: 'active' });
		const user = await this.db.getRepository(MiUser).findOneBy({ id: input.userId, isDeleted: false, isSuspended: false });
		if (!link || !user || user.host != null) return { active: false, items: [] };
		if (input.limit === 0) return { active: true, items: [] };
		if (!input.viewerId && this.meta.ugcVisibilityForVisitor === 'none') return { active: true, items: [] };
		// A signed peer assertion authenticates its local visitor, even before their actor is cached here.
		const viewer = input.viewerId ? await this.db.getRepository(MiUser).findOneBy({ uri: `${this.peer.peerOrigin}/users/${input.viewerId}` }) : null;
		const query = this.query(input.userId, viewer, input, input.before, input.head);
		const notes = await query.take(input.limit).getMany();
		return { active: true, items: notes.map(note => ({ id: note.id, date: this.ids.parse(note.id).date.getTime() })) };
	}

	public async history(userId: string, viewer: MiLocalUser | null, options: HistoryOptions, limit: number, cursor?: string) {
		const link = await this.findLink(userId);
		if (!link || !this.peer) throw new GridspaceHistoryError('LINK_UNAVAILABLE');
		const context = JSON.stringify([userId, viewer?.id ?? null, link.id, link.generation, options]);
		let position = { local: null as string | null, remote: null as string | null, localHead: null as string | null, remoteHead: null as string | null, expires: Date.now() + 3600000 };
		if (cursor) {
			try { position = decodeHistoryCursor(this.peer, cursor, context); } catch { throw new GridspaceHistoryError('INVALID_CURSOR'); }
		}
		// Do not advance either keyset on peer failure; a retry must not leave a gap in the merged order.
		const remote = await this.remote({ ...this.input(link, viewer, options, cursor && position.remoteHead == null ? 0 : limit, position.remote ?? undefined), head: position.remoteHead ?? undefined });
		if (!remote.active) throw new GridspaceHistoryError('LINK_UNAVAILABLE');
		const localQuery = this.query(link.localUserId, viewer, options, position.local ?? undefined, position.localHead ?? undefined);
		if (cursor && position.localHead == null) localQuery.andWhere('1=0');
		if (!viewer) this.queries.generateUgcVisibilityQueryForVisitor(localQuery);
		const local = await localQuery.take(limit).getMany();
		const remoteItems = !viewer && this.meta.ugcVisibilityForVisitor !== 'all' ? [] : remote.items;
		if (!cursor) {
			position.localHead = local[0]?.id ?? null;
			position.remoteHead = remoteItems[0]?.id ?? null;
		}
		const selected = mergeHistory(local.map(note => ({ id: note.id, date: this.ids.parse(note.id).date.getTime() })), remoteItems, limit);
		const mapped = new Map<string, string>();
		const budget = { remaining: 64, deadline: Date.now() + 15000 };
		try {
			// Keep imports bounded and silent. Fetching the current source again closes a deletion race.
			for (let offset = 0; offset < selected.length; offset += 4) {
				await Promise.all(selected.slice(offset, offset + 4).map(async item => {
					if (item.source === 'local') { mapped.set(`local:${item.id}`, item.id); return; }
					const note = await this.sharedNotes.historyNote(item.id, budget);
					if (note) mapped.set(`remote:${item.id}`, note.id);
				}));
			}
		} catch { throw new GridspaceHistoryError('PEER_UNAVAILABLE'); }
		if (!await this.active(link)) throw new GridspaceHistoryError('LINK_UNAVAILABLE');
		const other = await this.db.getRepository(MiUser).findOneBy({ uri: `${this.peer.peerOrigin}/users/${link.peerUserId}` });
		const allowed = new Map<string, MiNote>();
		for (const author of [link.localUserId, other?.id].filter((id): id is string => id != null)) {
			if (mapped.size === 0) break;
			const query = this.query(author, viewer, options).andWhere('note.id IN (:...ids)', { ids: [...mapped.values()] });
			if (!viewer) this.queries.generateUgcVisibilityQueryForVisitor(query);
			for (const note of await query.getMany()) allowed.set(note.id, note);
		}
		const result: MiNote[] = [];
		for (const item of selected) {
			position[item.source] = item.id;
			const note = allowed.get(mapped.get(`${item.source}:${item.id}`) ?? '');
			if (note) result.push(note);
		}
		const hasMore = selected.length > 0 && (selected.length < local.length + remoteItems.length || local.length === limit || remoteItems.length === limit);
		return { notes: await this.notes.packMany(result, viewer), cursor: hasMore ? encodeHistoryCursor(this.peer, position, context) : null };
	}
}
