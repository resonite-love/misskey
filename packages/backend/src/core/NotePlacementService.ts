/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DataSource, In, type EntityManager } from 'typeorm';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { canonicalGridspaceNoteUri } from '@/core/gridspace/note-protocol.js';
import { MiGridspacePlacement } from '@/models/GridspacePlacement.js';
import { MiBlocking } from '@/models/Blocking.js';
import { MiChannel } from '@/models/Channel.js';
import { MiNote } from '@/models/Note.js';
import { MiNoteChannelPlacement, MiNoteCreateReceipt } from '@/models/NotePlacement.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { IdService } from '@/core/IdService.js';
import type { RoleService } from '@/core/RoleService.js';
import type { GridspaceSearchService } from '@/core/gridspace/GridspaceSearchService.js';
import type { GridspacePlacementService } from '@/core/gridspace/GridspacePlacementService.js';
import type { PlacementPreview } from '@/core/gridspace/placement-protocol.js';
import { recordPlacementChange, refreshPlacementChannel } from '@/core/gridspace/timeline/placement-change.js';

export type PackedChannelPlacement = {
	origin: string;
	channelId: string;
	canonicalUri: string;
	name: string;
	color: string;
	state: 'active' | 'pending' | 'failed' | 'removed';
	placementId?: string;
	canRemove?: boolean;
	canRetry?: boolean;
};

export type PlacementMap = Map<string, PackedChannelPlacement[]> & {
	rootNoteIds?: Set<string>;
	unavailableNoteIds?: Set<string>;
};

export type MultiNoteRequest = {
	includeDefault: boolean;
	channelIds: string[];
	channelTargets: { origin: string; channelId: string }[];
	clientRequestId: string;
	inputHash: string;
};

export type PreparedPlacements = {
	request: MultiNoteRequest;
	localIds: string[];
	remote: Awaited<ReturnType<GridspacePlacementService['prepare']>>;
};

export class PlacementError extends Error {}

/** Called on validated API fields before resolving relative times or looking up peer state. */
export function createInputHash(input: Record<string, unknown>): string {
	return createHash('sha256').update(JSON.stringify(input, (_key, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
	})).digest('hex');
}

@Injectable()
export class NotePlacementService {
	constructor(
		@Inject(DI.config) private config: Config,
		@Inject(DI.db) private db: DataSource,
		private moduleRef: ModuleRef,
		private idService: IdService,
	) {}

	private get peer() {
		return this.moduleRef.get<GridspacePlacementService>('GridspacePlacementService', { strict: false });
	}

	private get origin() {
		return new URL(this.config.url).origin;
	}

	public async status(userId: string, clientRequestId: string, inputHash?: string, manager = this.db.manager) {
		const receipt = await manager.findOneBy(MiNoteCreateReceipt, { userId, clientRequestId });
		if (!receipt) return { status: 'missing' as const, note: null };
		if (inputHash !== undefined && receipt.inputHash !== inputHash) throw new PlacementError('request-content-conflict');
		const note = !receipt.deleted && receipt.noteId ? await manager.findOneBy(MiNote, { id: receipt.noteId }) : null;
		return note ? { status: 'created' as const, note } : { status: 'deleted' as const, note: null };
	}

	public async prepare(userId: string, request: MultiNoteRequest, preview: PlacementPreview): Promise<PreparedPlacements> {
		if (!this.config.multiNote?.enabled) {
			throw new PlacementError('multi-note-disabled');
		}
		const localIds = [...new Set([...request.channelIds, ...request.channelTargets.filter(t => t.origin === this.origin).map(t => t.channelId)])].sort();
		const targets = request.channelTargets.filter(t => t.origin !== this.origin);
		if (targets.length > 0 && (!this.config.gridspace?.enabled || !this.config.gridspace.timelineEnabled || !await this.peer.peerEnabled())) {
			throw new PlacementError('peer-placement-unavailable');
		}
		if (localIds.length + targets.length === 0) throw new PlacementError('no-channel-destination');
		const user = await this.db.manager.findOneByOrFail(MiUser, { id: userId });
		if (user.host !== null) throw new PlacementError('local-author-required');
		const remote = targets.length > 0 ? await this.peer.prepare(user as MiLocalUser, targets, request.includeDefault, preview) : [];
		return { request, localIds, remote };
	}

	public async lockRequest(manager: EntityManager, note: MiNote, prepared: PreparedPlacements) {
		const { clientRequestId, inputHash } = prepared.request;
		await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['multi-note:' + note.userId + ':' + clientRequestId]);
		const existing = await this.status(note.userId, clientRequestId, inputHash, manager);
		if (existing.status === 'deleted') throw new PlacementError('request-note-deleted');
		return existing.note;
	}

	public async lockConversation(manager: EntityManager, rootId: string, parentId: string) {
		const ids = [...new Set([rootId, parentId])].sort();
		const rows = await manager.createQueryBuilder(MiNote, 'note').select('note.id').where('note.id IN (:...ids)', { ids })
			.orderBy('note.id', 'ASC').setLock('pessimistic_read').getMany();
		if (rows.length !== ids.length) throw new PlacementError('invalid-conversation-parent');
	}

	public async readable(userId: string, noteId: string, manager?: EntityManager) {
		const search = this.moduleRef.get<GridspaceSearchService>('GridspaceSearchService', { strict: false });
		const query = search.noteQuery({ id: userId }, { query: '' }, false, true, undefined, true, false, noteId);
		if (manager?.queryRunner) query.setQueryRunner(manager.queryRunner);
		return query.getOne();
	}

	public async authorizeReply(manager: EntityManager, userId: string, rootId: string, parentId: string) {
		const root = await this.readable(userId, rootId, manager);
		if (parentId !== rootId && !await this.readable(userId, parentId, manager)) throw new PlacementError('invalid-conversation-parent');
		if (!root || root.multiNoteKind !== 'root' || root.includeDefault !== false) throw new PlacementError('invalid-conversation-root');
		const user = await manager.findOneByOrFail(MiUser, { id: userId });
		await this.peer.authorizeConversationWrite(user, root, 'reply', manager);
	}

	public async stage(manager: EntityManager, note: MiNote, prepared?: PreparedPlacements) {
		const canonicalUri = note.uri ?? this.origin + '/notes/' + note.id;
		const ids = prepared?.localIds ?? (note.channelId ? [note.channelId] : []);
		for (const channelId of ids) {
			const channel = await manager.findOne(MiChannel, { where: { id: channelId }, lock: { mode: 'for_no_key_update' } });
			if (!channel || (prepared && channel.isArchived)) throw new PlacementError('channel-unavailable');
			if (prepared && channel.userId && await manager.existsBy(MiBlocking, [
				{ blockerId: channel.userId, blockeeId: note.userId }, { blockerId: note.userId, blockeeId: channel.userId },
			])) throw new PlacementError('channel-unavailable');
			if (prepared?.request.includeDefault && !channel.allowRenoteToExternal) throw new PlacementError('channel-disallows-external-renotes');
			await manager.insert(MiNoteChannelPlacement, {
				id: randomUUID(), noteId: note.id, channelId, canonicalUri,
				sortAt: this.idService.parse(note.id).date, state: 'active',
			});
			await refreshPlacementChannel(manager, channelId, this.origin, this.config.id);
			await recordPlacementChange(manager, { kind: 'place-add', canonicalUri, channelId, channelOrigin: this.origin, noteId: note.id, sourceRevision: 1, targetRevision: 1 });
		}
		if (!prepared) return;
		const { clientRequestId, inputHash } = prepared.request;
		await manager.insert(MiNoteCreateReceipt, { userId: note.userId, clientRequestId, inputHash, canonicalUri, noteId: note.id, deleted: false });
		if (prepared.remote.length > 0) await this.peer.stage(manager, note, prepared.remote);
	}

	public async activeLocalChannelIds(note: Pick<MiNote, 'id' | 'channelId' | 'multiNoteKind'> & Partial<Pick<MiNote, 'uri' | 'gridspaceShared' | 'includeDefault'>>): Promise<string[]> {
		if (note.gridspaceShared && note.uri && note.includeDefault !== false && this.config.gridspace?.peerUrl) {
			const canonicalUri = canonicalGridspaceNoteUri(note.uri, this.config.gridspace.peerUrl);
			const rows = await this.db.manager.find(MiGridspacePlacement, { where: { canonicalUri, state: 'active', includeDefault: true }, select: { channelId: true } });
			return rows.map(p => p.channelId);
		}
		if (!note.channelId && note.multiNoteKind !== 'root') return [];
		const rows = await this.db.manager.findBy(MiNoteChannelPlacement, { noteId: note.id });
		const ids = rows.filter(p => p.state === 'active').map(p => p.channelId);
		if (note.channelId && !rows.some(p => p.channelId === note.channelId)) ids.push(note.channelId);
		return ids;
	}

	public async pack(noteIds: string[], viewer?: Pick<MiUser, 'id'> | null): Promise<PlacementMap> {
		if (!noteIds.length) return new Map();
		const result = await this.peer.pack(noteIds, viewer);
		const query = this.db.getRepository(MiNoteChannelPlacement).createQueryBuilder('placement')
			.innerJoinAndSelect('placement.channel', 'channel').innerJoinAndSelect('placement.note', 'note')
			.where('placement.noteId IN (:...noteIds)', { noteIds });
		if (viewer) {
			query.andWhere(`NOT EXISTS (SELECT 1 FROM blocking b WHERE
				(b."blockerId" = channel."userId" AND b."blockeeId" = :viewer) OR
				(b."blockerId" = :viewer AND b."blockeeId" = channel."userId"))`, { viewer: viewer.id });
			query.andWhere(`NOT EXISTS (SELECT 1 FROM channel_muting m WHERE m."userId" = :viewer AND m."channelId" = channel.id
				AND (m."expiresAt" IS NULL OR m."expiresAt" > CURRENT_TIMESTAMP))`);
		}
		const rows = await query.getMany();
		const isModerator = viewer != null && rows.length > 0 && await this.moduleRef.get<RoleService>('RoleService', { strict: false }).isModerator(viewer);
		for (const row of rows) {
			if (!row.noteId || !row.channel || row.state === 'origin-deleted') continue;
			const canRemove = viewer != null && (row.note?.userId === viewer.id || row.channel.userId === viewer.id || isModerator);
			if (row.state !== 'active' && !canRemove) continue;
			const placements = result.get(row.noteId) ?? [];
			placements.push({
				origin: this.origin, channelId: row.channelId, canonicalUri: row.canonicalUri,
				name: row.channel.name, color: row.channel.color, state: row.state, placementId: row.id, canRemove,
			});
			result.set(row.noteId, placements);
		}
		return result;
	}

	public async removeLocal(viewer: MiLocalUser, channelId: string, canonicalUri: string) {
		await this.db.transaction(async manager => {
			await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['gridspace-note:' + canonicalUri]);
			const channel = await manager.findOne(MiChannel, { where: { id: channelId }, lock: { mode: 'for_no_key_update' } });
			const row = await manager.findOne(MiNoteChannelPlacement, { where: { channelId, canonicalUri }, relations: { note: true } });
			if (!channel || !row || row.note?.multiNoteKind !== 'root') throw new PlacementError('no-such-placement');
			if (viewer.id !== channel.userId && viewer.id !== row.note.userId && !await this.moduleRef.get<RoleService>('RoleService', { strict: false }).isModerator(viewer)) {
				throw new PlacementError('cannot-remove-placement');
			}
			if (row.state !== 'active') return;
			await manager.update(MiNoteChannelPlacement, row.id, { state: 'removed', removedAt: new Date(), removedBy: viewer.id });
			await refreshPlacementChannel(manager, channelId, this.origin, this.config.id);
			await recordPlacementChange(manager, { kind: 'place-remove', canonicalUri, channelId, channelOrigin: this.origin, noteId: row.noteId, sourceRevision: 1, targetRevision: 2 });
		});
	}
}
