/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DataSource, In, IsNull, LessThanOrEqual, type EntityManager } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiMeta } from '@/models/Meta.js';
import { MiUser, type MiLocalUser, type MiRemoteUser } from '@/models/User.js';
import { MiNote } from '@/models/Note.js';
import { MiPoll } from '@/models/Poll.js';
import { MiDriveFile } from '@/models/DriveFile.js';
import { MiBlocking } from '@/models/Blocking.js';
import { MiChannel } from '@/models/Channel.js';
import { MiChannelFollowing } from '@/models/ChannelFollowing.js';
import { MiChannelFavorite } from '@/models/ChannelFavorite.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import type { ChannelUpdate } from './channel-protocol.js';
import { MiNoteChannelPlacement, MiNoteCreateReceipt } from '@/models/NotePlacement.js';
import { MiGridspaceNoteTombstone } from '@/models/Gridspace.js';
import { MiGridspacePlacement, MiGridspacePlacementTarget } from '@/models/GridspacePlacement.js';
import { NotePlacementService, type PlacementMap } from '@/core/NotePlacementService.js';
import type { GridspaceSearchService } from './GridspaceSearchService.js';
import { IdService } from '@/core/IdService.js';
import { RoleService } from '@/core/RoleService.js';
import { RateLimiterService } from '@/server/api/RateLimiterService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { ChannelEntityService } from '@/core/entities/ChannelEntityService.js';
import { extractUrlsForKeyWordCheck } from '@/misc/extract-urls-for-keyword-check.js';
import { sqlLikeEscape } from '@/misc/sql-like-escape.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import { canonicalGridspaceNoteUri, gridspaceNoteId } from './note-protocol.js';
import { requestGridspacePeer } from './peer-client.js';
import { resolveGridspaceConfig, GRIDSPACE_HANDSHAKE_PATH, GRIDSPACE_PROTOCOL_VERSION, type GridspacePeerConfig } from './peer-protocol.js';
import {
	linkedChannelFollowsCapability, originPlacementCapability, placementCapability, placementPath, previewHash, signPlacementProof, verifyPlacementProof,
	type OriginPlacementRoot, type PlacementChannels, type PlacementInputs, type PlacementLookupRow, type PlacementPreview, type PlacementProof, type PlacementPurpose, type PlacementStatus, type PreparedRemotePlacement,
} from './placement-protocol.js';
import { recordPlacementChange, refreshPlacementChannel } from './timeline/placement-change.js';

export type { PreparedRemotePlacement } from './placement-protocol.js';
export type PackedPlacementMap = PlacementMap;

const revoked = () => new GridspaceLinkError('AUTHORIZATION_REVOKED');
const unavailable = () => new GridspaceLinkError('CHANNEL_UNAVAILABLE');
const enqueue = () => ({ version: randomUUID(), retryAt: new Date(), attempts: 0 });
const placementUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type PlacementKey = PlacementInputs['delete-origin'];

function ownedId(uri: string, origin: string, path: 'notes' | 'users'): string {
	const prefix = origin + '/' + path + '/';
	if (!uri.startsWith(prefix) || !gridspaceNoteId(uri.slice(prefix.length))) throw revoked();
	return uri.slice(prefix.length);
}

function statusOf(row: MiGridspacePlacement): PlacementStatus {
	return { canonicalUri: row.canonicalUri, channelId: row.channelId, placementId: row.id, state: row.state,
		sourceRevision: row.sourceRevision, targetRevision: row.targetRevision };
}

async function lockUri(manager: EntityManager, uri: string): Promise<void> {
	await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['gridspace-note:' + uri]);
}

@Injectable()
export class GridspacePlacementService implements OnModuleInit, OnApplicationShutdown {
	private readonly peer: GridspacePeerConfig | null;
	private timer?: ReturnType<typeof setInterval>;
	private working = false;
	private capability?: { expiresAt: number; value: Promise<{ supported: boolean; enabled: boolean; linkedFollows: boolean; originLookup: boolean | null }> };

	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.config) private config: Config,
		@Inject(DI.meta) private meta: MiMeta,
		private modules: ModuleRef,
		private roles: RoleService,
		private utility: UtilityService,
		private ids: IdService,
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
	}

	public get enabled(): boolean {
		return this.peer !== null && this.config.multiNote?.enabled === true && this.config.gridspace?.timelineEnabled === true;
	}

	public onModuleInit(): void {
		if (!this.peer) return;
		this.timer = setInterval(() => { void this.flush(); }, 3000);
		this.timer.unref();
	}

	public onApplicationShutdown(): void { clearInterval(this.timer); }

	public async peerEnabled(): Promise<boolean> { return this.enabled && (await this.capabilities()).enabled; }

	public async hasPeerCapability(): Promise<boolean> { return (await this.capabilities()).supported; }

	public async supportsLinkedChannelFollows(): Promise<boolean> { return (await this.capabilities()).linkedFollows; }

	public async assertConversationEnabled(): Promise<void> {
		if (!await this.peerEnabled()) throw unavailable();
	}

	private async capabilities() {
		if (!this.peer) return { supported: false, enabled: false, linkedFollows: false, originLookup: false };
		if (!this.capability || this.capability.expiresAt <= Date.now()) {
			const value = requestGridspacePeer(this.peer, GRIDSPACE_HANDSHAKE_PATH, { protocolVersion: GRIDSPACE_PROTOCOL_VERSION }, 16384, Date.now() + 3000)
				.then(r => {
					if (!r || typeof r !== 'object' || !('features' in r) || !Array.isArray(r.features)) return { supported: false, enabled: false, linkedFollows: false, originLookup: false };
					const supported = r.features.includes(placementCapability);
					return { supported, linkedFollows: supported && r.features.includes(linkedChannelFollowsCapability), enabled: supported && 'placementEnabled' in r && r.placementEnabled === true, originLookup: supported && r.features.includes(originPlacementCapability) };
				}).catch(() => ({ supported: false, enabled: false, linkedFollows: false, originLookup: null }));
			this.capability = { expiresAt: Date.now() + 15000, value };
		}
		return this.capability.value;
	}

	private async call<K extends keyof PlacementInputs, T>(name: K, data: PlacementInputs[K]): Promise<T> {
		if (!this.peer) throw unavailable();
		try {
			return await this.modules.get(GridspaceLinkService, { strict: false }).json<T>(placementPath + name, data);
		} catch (error) {
			if (error instanceof GridspaceLinkError && ['CHANNEL_UNAVAILABLE', 'AUTHORIZATION_REVOKED', 'RATE_LIMITED'].includes(error.code)) throw error;
			throw new GridspaceLinkError('PEER_UNAVAILABLE');
		}
	}

	public async currentActorCredential(user: MiLocalUser): Promise<{ actorId: string }> {
		if (!this.peer || !await this.db.getRepository(MiUser).existsBy({ id: user.id, host: IsNull(), isDeleted: false, isSuspended: false, movedToUri: IsNull() })) throw revoked();
		return { actorId: user.id };
	}

	public async resolveActor(peerActorId: string, manager?: EntityManager): Promise<MiRemoteUser> {
		if (!this.peer || !gridspaceNoteId(peerActorId)) throw revoked();
		const host = new URL(this.peer.peerOrigin).host;
		if (this.utility.isBlockedHost(this.meta.blockedHosts, host)) throw revoked();
		const uri = this.peer.peerOrigin + '/users/' + peerActorId;
		let user = await (manager ?? this.db.manager).findOne(MiUser, { where: { uri, host }, ...(manager ? { lock: { mode: 'pessimistic_read' as const } } : {}) });
		if (!user && !manager) user = await this.modules.get(ApPersonService, { strict: false }).resolvePerson(uri);
		if (!user || user.uri !== uri || user.host !== host || user.isDeleted || user.isSuspended || user.movedToUri) throw revoked();
		return user as MiRemoteUser;
	}

	private async checkChannel(id: string, user: MiUser, write: boolean, includeDefault: boolean, manager?: EntityManager): Promise<MiChannel> {
		const db = manager ?? this.db.manager;
		const channel = await db.findOne(MiChannel, { where: { id }, ...(manager ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
		if (!channel || (write && channel.isArchived) || (includeDefault && !channel.allowRenoteToExternal)) throw unavailable();
		if (channel.userId && await db.existsBy(MiBlocking, [{ blockerId: channel.userId, blockeeId: user.id }, { blockerId: user.id, blockeeId: channel.userId }])) throw revoked();
		if (write && !(await this.roles.getUserPolicies(user.id)).canPublicNote) throw revoked();
		return channel;
	}

	private checkPreview(input: PlacementInputs['prepare']): void {
		if (input.hash !== previewHash(input.preview)) throw unavailable();
		const preview = input.preview;
		const content = this.utility.concatNoteContentsForKeyWordCheck({ ...preview, others: [
			...(preview.files ?? []).flatMap(file => [file.name, file.comment ?? '']),
			...extractUrlsForKeyWordCheck(preview.text ?? ''), ...extractUrlsForKeyWordCheck(preview.cw ?? ''),
		] });
		if (this.utility.isKeyWordIncluded(content, this.meta.prohibitedWords) || this.utility.isKeyWordIncluded(content, this.meta.sensitiveWords)) throw unavailable();
	}

	public async prepare(user: MiLocalUser, targets: { origin: string; channelId: string }[], includeDefault: boolean, preview: PlacementPreview = {}): Promise<PreparedRemotePlacement[]> {
		if (!targets.length) return [];
		if (!await this.peerEnabled() || targets.some(t => t.origin !== this.peer!.peerOrigin)) throw unavailable();
		const credential = await this.currentActorCredential(user);
		const hash = previewHash(preview);
		const prepared = [];
		for (const { channelId } of targets) {
			const row = await this.call<'prepare', PreparedRemotePlacement>('prepare', { ...credential, preview, hash, includeDefault, channelId });
			if (row.origin !== this.peer!.peerOrigin || row.channelId !== channelId || typeof row.name !== 'string' || typeof row.color !== 'string') throw unavailable();
			prepared.push(row);
		}
		return prepared;
	}

	public async stage(manager: EntityManager, note: MiNote, prepared: PreparedRemotePlacement[]): Promise<void> {
		for (const target of prepared) {
			await manager.insert(MiGridspacePlacementTarget, {
				canonicalUri: this.config.url + '/notes/' + note.id, noteId: note.id, peerOrigin: target.origin, channelId: target.channelId,
				authorId: note.userId, includeDefault: note.includeDefault === true, sortAt: this.ids.parse(note.id).date,
				name: target.name, color: target.color, state: 'pending', sourceRevision: 1, targetRevision: 0, placementId: null, ...enqueue(),
			});
		}
	}

	private async receivePrepare(input: PlacementInputs['prepare']): Promise<PreparedRemotePlacement> {
		if (!this.enabled) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		this.checkPreview(input);
		const channel = await this.checkChannel(input.channelId, await this.resolveActor(input.actorId), true, input.includeDefault);
		return { origin: this.peer!.origin, channelId: channel.id, name: channel.name, color: channel.color };
	}

	private async visiblePeerTargets(input: PlacementInputs['lookup']): Promise<{ items: PlacementLookupRow[] }> {
		const peer = this.peer!;
		if (this.utility.isBlockedHost(this.meta.blockedHosts, new URL(peer.peerOrigin).host)) return { items: [] };
		for (const key of input.keys) {
			ownedId(key.canonicalUri, peer.peerOrigin, 'notes');
			if (!key.placementId) throw revoked();
		}
		const viewer = input.viewerActorUri ? await this.viewerActor(input.viewerActorUri) : null;
		const items = await this.db.query<PlacementLookupRow[]>(`
			SELECT p.id AS "placementId", ch.name, ch.color, ch."isSensitive", ch."isArchived", ch."allowRenoteToExternal", coalesce(owner.uri, $3 || '/users/' || owner.id) AS "ownerUri"
			FROM jsonb_to_recordset($1::jsonb) AS k("canonicalUri" text, "placementId" uuid, "channelId" text, "sourceRevision" integer, "targetRevision" integer)
			JOIN gridspace_channel_placement p ON p.id = k."placementId" AND p."canonicalUri" = k."canonicalUri" AND p."channelId" = k."channelId"
				AND p."sourceRevision" = k."sourceRevision" AND p."targetRevision" = k."targetRevision"
			JOIN channel ch ON ch.id = p."channelId"
			LEFT JOIN "user" owner ON owner.id = ch."userId"
			JOIN "user" author ON author.uri = p."authorUri"
			WHERE p.state = 'active' AND NOT author."isDeleted" AND NOT author."isSuspended"
				AND (owner.id IS NULL OR (NOT owner."isDeleted" AND NOT owner."isSuspended"))
				AND NOT EXISTS (SELECT 1 FROM gridspace_note_tombstone t WHERE t.uri = p."canonicalUri")
				AND NOT EXISTS (SELECT 1 FROM muting m WHERE m."muterId" = $2 AND m."muteeId" IN (ch."userId",author.id) AND (m."expiresAt" IS NULL OR m."expiresAt" > now()))
				AND NOT EXISTS (SELECT 1 FROM blocking b WHERE (b."blockerId" = $2 AND b."blockeeId" IN (ch."userId",author.id)) OR (b."blockeeId" = $2 AND b."blockerId" IN (ch."userId",author.id)))
				AND NOT EXISTS (SELECT 1 FROM channel_muting m WHERE m."userId" = $2 AND m."channelId" = ch.id AND (m."expiresAt" IS NULL OR m."expiresAt" > now()))
		`, [JSON.stringify(input.keys), viewer?.id ?? null, peer.origin]);
		return { items };
	}

	private async viewerActor(uri: string): Promise<MiUser> {
		if (uri.startsWith(this.config.url + '/users/')) {
			const user = await this.db.getRepository(MiUser).findOneBy({ id: ownedId(uri, this.config.url, 'users'), host: IsNull(), isDeleted: false, isSuspended: false, movedToUri: IsNull() });
			if (!user) throw revoked();
			return user;
		}
		return this.resolveActor(ownedId(uri, this.peer!.peerOrigin, 'users'));
	}

	private async lookupViewer(viewer?: Pick<MiUser, 'id'> | null): Promise<{ viewerActorUri?: string } | null> {
		if (!this.peer || this.utility.isBlockedHost(this.meta.blockedHosts, new URL(this.peer.peerOrigin).host)) return null;
		if (!viewer) return {};
		const user = await this.db.getRepository(MiUser).findOne({ select: { id: true, uri: true }, where: { id: viewer.id, isDeleted: false, isSuspended: false, movedToUri: IsNull() } });
		if (!user) return null;
		const viewerActorUri = user.uri ?? this.config.url + '/users/' + user.id;
		if (![this.config.url, this.peer.peerOrigin].some(origin => viewerActorUri.startsWith(origin + '/users/'))) return null;
		return { viewerActorUri };
	}

	private async blockedOwners(viewer: Pick<MiUser, 'id'> | null | undefined, ownerUris: string[]): Promise<Set<string>> {
		if (!ownerUris.length) return new Set();
		const prefix = this.config.url + '/users/';
		const localIds = ownerUris.filter(uri => uri.startsWith(prefix)).map(uri => uri.slice(prefix.length)).filter(gridspaceNoteId);
		const hidden = await this.db.query<{ uri: string }[]>(`
			SELECT coalesce(owner.uri, $3 || '/users/' || owner.id) AS uri FROM "user" owner
			WHERE (owner.uri = ANY($2::varchar[]) OR (owner.uri IS NULL AND owner.id = ANY($4::varchar[]))) AND
			(owner."isSuspended" OR owner."isDeleted" OR EXISTS (SELECT 1 FROM blocking b WHERE
			(b."blockerId" = owner.id AND b."blockeeId" = $1) OR (b."blockeeId" = owner.id AND b."blockerId" = $1))
			OR EXISTS (SELECT 1 FROM muting m WHERE m."muterId" = $1 AND m."muteeId" = owner.id AND (m."expiresAt" IS NULL OR m."expiresAt" > now())))`,
		[viewer?.id ?? null, ownerUris, this.config.url, localIds]);
		return new Set(hidden.map(row => row.uri));
	}

	private async liveTargets(rows: MiGridspacePlacementTarget[], viewer: Pick<MiUser, 'id'> | null | undefined, result: PackedPlacementMap): Promise<Map<string, PlacementLookupRow>> {
		const visible = new Map<string, PlacementLookupRow>();
		if (!rows.length) return visible;
		const identity = await this.lookupViewer(viewer);
		if (!identity) return visible;
		for (let i = 0; i < rows.length; i += 100) {
			const batch = rows.slice(i, i + 100);
			try {
				const { items } = await this.call<'lookup', { items: PlacementLookupRow[] }>('lookup', { ...identity, keys: batch.map(r => ({ ...this.key(r), placementId: r.placementId, targetRevision: r.targetRevision })) });
				if (!Array.isArray(items) || items.length > batch.length) throw unavailable();
				const blocked = await this.blockedOwners(viewer, items.flatMap(item => item.ownerUri ? [item.ownerUri] : []));
				for (const item of items) {
					if (typeof item.name !== 'string' || typeof item.color !== 'string' || !batch.some(row => row.placementId === item.placementId)) throw unavailable();
					if (!item.ownerUri || !blocked.has(item.ownerUri)) visible.set(item.placementId, item);
				}
			} catch {
				result.unavailableNoteIds ??= new Set();
				for (const row of batch) {
					result.unavailableNoteIds.add(row.noteId);
					if (row.placementId) visible.delete(row.placementId);
				}
			}
		}
		return visible;
	}

	private readableSharedNotes(noteIds: string[], viewer?: Pick<MiUser, 'id'> | null) {
		return this.modules.get<GridspaceSearchService>('GridspaceSearchService', { strict: false })
			.noteQuery(viewer ?? null, { query: '' }, false, viewer != null, undefined, false, true)
			.andWhere('note.id IN (:...placementNoteIds) AND note.gridspaceShared AND note.visibility = :placementVisibility',
				{ placementNoteIds: noteIds, placementVisibility: 'public' });
	}

	/** Read only origin-owned rows. Calling the note packer here would send another lookup to the peer. */
	private async originLookup(input: PlacementInputs['origin-lookup']): Promise<{ roots: OriginPlacementRoot[] }> {
		const peer = this.peer!;
		if (this.utility.isBlockedHost(this.meta.blockedHosts, new URL(peer.peerOrigin).host)) return { roots: [] };
		const viewer = input.viewerActorUri ? await this.viewerActor(input.viewerActorUri) : null;
		const query = this.readableSharedNotes(input.noteIds, viewer)
			.andWhere('note.uri IS NULL AND note.userHost IS NULL AND note.multiNoteKind = :root AND note.includeDefault', { root: 'root' })
			.leftJoin(MiNoteChannelPlacement, 'p', "p.noteId = note.id AND p.state = 'active'")
			.leftJoin(MiChannel, 'dest', `dest.id = p."channelId"
				AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = dest."userId" AND (u."isDeleted" OR u."isSuspended"))
				AND NOT EXISTS (SELECT 1 FROM channel_muting m WHERE m."userId" = :chipViewer AND m."channelId" = dest.id AND (m."expiresAt" IS NULL OR m."expiresAt" > now()))
				AND NOT EXISTS (SELECT 1 FROM muting m WHERE m."muterId" = :chipViewer AND m."muteeId" = dest."userId" AND (m."expiresAt" IS NULL OR m."expiresAt" > now()))
				AND NOT EXISTS (SELECT 1 FROM blocking b WHERE (b."blockerId" = :chipViewer AND b."blockeeId" = dest."userId") OR (b."blockeeId" = :chipViewer AND b."blockerId" = dest."userId"))`,
			{ chipViewer: viewer?.id ?? null })
			.leftJoin(MiUser, 'owner', 'owner.id = dest.userId')
			.select('note.id', 'noteId').addSelect('dest.id', 'channelId').addSelect('p.id', 'placementId')
			.addSelect('dest.name', 'name').addSelect('dest.color', 'color').addSelect('dest.isSensitive', 'isSensitive').addSelect('dest.isArchived', 'isArchived').addSelect('dest.allowRenoteToExternal', 'allowRenoteToExternal')
			.addSelect("coalesce(owner.uri, :chipOrigin || '/users/' || owner.id)", 'ownerUri').setParameter('chipOrigin', peer.origin)
			.orderBy('note.id').addOrderBy('dest.id');
		const roots = new Map<string, OriginPlacementRoot>();
		for (const { noteId, channelId, placementId, name, color, ownerUri, isSensitive, isArchived, allowRenoteToExternal } of await query.getRawMany<PlacementLookupRow & { noteId: string; channelId: string | null }>()) {
			let root = roots.get(noteId);
			if (!root) { root = { noteId, channels: [] }; roots.set(noteId, root); }
			if (channelId !== null) root.channels.push({ channelId, placementId, name, color, ownerUri, isSensitive, isArchived, allowRenoteToExternal });
		}
		return { roots: [...roots.values()] };
	}

	private async packMirrorOrigins(noteIds: string[], viewer: Pick<MiUser, 'id'> | null | undefined, result: PackedPlacementMap): Promise<void> {
		if (!this.peer || this.config.gridspace?.enabled !== true) return;
		const origin = this.peer.peerOrigin;
		const links = await this.readableSharedNotes(noteIds, viewer)
			.andWhere('note.userHost = :chipHost AND note.uri IS NOT NULL', { chipHost: new URL(origin).host })
			.select('note.id', 'id').addSelect('note.uri', 'uri').getRawMany<{ id: string; uri: string }>();
		const mirrors = new Map<string, { id: string; uri: string }[]>();
		for (const row of links) {
			const uri = canonicalGridspaceNoteUri(row.uri, origin);
			const prefix = origin + '/notes/';
			const sourceId = uri.slice(prefix.length);
			if (!uri.startsWith(prefix) || !gridspaceNoteId(sourceId)) continue;
			const refs = mirrors.get(sourceId) ?? [];
			refs.push({ id: row.id, uri });
			mirrors.set(sourceId, refs);
		}
		if (!mirrors.size) return;
		const support = (await this.capabilities()).originLookup;
		if (support === false) return;
		const identity = await this.lookupViewer(viewer);
		if (!identity) return;
		const sourceIds = [...mirrors.keys()];
		for (let offset = 0; offset < sourceIds.length; offset += 100) {
			const batch = sourceIds.slice(offset, offset + 100);
			try {
				if (support !== true) throw unavailable();
				const { roots } = await this.call<'origin-lookup', { roots: OriginPlacementRoot[] }>('origin-lookup', { ...identity, noteIds: batch });
				if (!Array.isArray(roots) || roots.length > batch.length || new Set(roots.map(r => r.noteId)).size !== roots.length) throw unavailable();
				for (const root of roots) {
					if (!batch.includes(root.noteId) || !Array.isArray(root.channels)) throw unavailable();
					const channelIds = new Set<string>();
					for (const channel of root.channels) {
						if (!gridspaceNoteId(channel.channelId) || channelIds.has(channel.channelId) ||
							typeof channel.placementId !== 'string' || !placementUuid.test(channel.placementId) ||
							typeof channel.name !== 'string' || typeof channel.color !== 'string') throw unavailable();
						if (channel.ownerUri !== null) ownedId(channel.ownerUri, origin, 'users');
						channelIds.add(channel.channelId);
					}
				}
				const hidden = await this.blockedOwners(viewer, roots.flatMap(root => root.channels.flatMap(c => c.ownerUri ? [c.ownerUri] : [])));
				result.rootNoteIds ??= new Set();
				for (const root of roots) {
					for (const ref of mirrors.get(root.noteId)!) {
						result.rootNoteIds.add(ref.id);
						const placements = result.get(ref.id) ?? [];
						const seen = new Set(placements.filter(p => p.origin === origin).map(p => p.channelId));
						for (const c of root.channels) {
							if (seen.has(c.channelId) || (c.ownerUri && hidden.has(c.ownerUri))) continue;
							seen.add(c.channelId);
							placements.push({ origin, channelId: c.channelId, canonicalUri: ref.uri, name: c.name, color: c.color, isArchived: c.isArchived, isSensitive: c.isSensitive, allowRenoteToExternal: c.allowRenoteToExternal, placementId: c.placementId, state: 'active', canRemove: false });
						}
						result.set(ref.id, placements);
					}
				}
			} catch {
				result.unavailableNoteIds ??= new Set();
				for (const id of batch) for (const ref of mirrors.get(id)!) result.unavailableNoteIds.add(ref.id);
			}
		}
	}

	public async pack(noteIds: string[], viewer?: Pick<MiUser, 'id'> | null): Promise<PackedPlacementMap> {
		const result: PackedPlacementMap = new Map();
		if (!noteIds.length) return result;
		const rows = await this.db.getRepository(MiGridspacePlacementTarget).findBy({ noteId: In(noteIds) });
		const live = await this.liveTargets(rows.filter(r => r.state === 'active'), viewer, result);
		const originModerator = !!viewer && rows.length > 0 && await this.roles.isModerator(viewer);
		for (const r of rows) {
			const managesDelivery = !!viewer && (r.authorId === viewer.id || originModerator);
			if (r.state === 'origin-deleted' || (r.state !== 'active' && !managesDelivery)) continue;
			const current = r.placementId ? live.get(r.placementId) : null;
			if (r.state === 'active' && !current) continue;
			const list = result.get(r.noteId) ?? [];
			list.push({ origin: r.peerOrigin, channelId: r.channelId, canonicalUri: r.canonicalUri, name: current?.name ?? r.name, color: current?.color ?? r.color, state: r.state,
				allowRenoteToExternal: current?.allowRenoteToExternal, isArchived: current?.isArchived, isSensitive: current?.isSensitive,
				canRemove: r.authorId === viewer?.id && r.state !== 'removed', canRetry: managesDelivery && !r.permanentFailure && (r.state === 'pending' || r.state === 'failed'),
				...(r.placementId ? { placementId: r.placementId } : {}) });
			result.set(r.noteId, list);
		}
		const mirrors = await this.db.query<{ noteId: string; placementId: string; canonicalUri: string; channelId: string; name: string; color: string; ownerId: string | null; isSensitive: boolean; isArchived: boolean; allowRenoteToExternal: boolean }[]>(
			`SELECT n.id AS "noteId", p.id AS "placementId", p."canonicalUri", c.id AS "channelId", c.name, c.color, c."isSensitive", c."isArchived", c."allowRenoteToExternal", c."userId" AS "ownerId"
			FROM note n JOIN gridspace_channel_placement p ON n.uri IN (p."canonicalUri", p."canonicalUri" || '/activity')
			JOIN channel c ON c.id = p."channelId" LEFT JOIN "user" owner ON owner.id = c."userId"
			WHERE n.id = ANY($1::varchar[]) AND n."gridspaceShared" AND p.state = 'active'
				AND (owner.id IS NULL OR (NOT owner."isDeleted" AND NOT owner."isSuspended"))
				AND NOT EXISTS (SELECT 1 FROM channel_muting m WHERE m."userId" = $2 AND m."channelId" = c.id AND (m."expiresAt" IS NULL OR m."expiresAt" > now()))
				AND NOT EXISTS (SELECT 1 FROM muting m WHERE m."muterId" = $2 AND m."muteeId" IN (c."userId",n."userId") AND (m."expiresAt" IS NULL OR m."expiresAt" > now()))
				AND NOT EXISTS (SELECT 1 FROM blocking b WHERE (b."blockerId" = $2 AND b."blockeeId" IN (c."userId",n."userId")) OR (b."blockeeId" = $2 AND b."blockerId" IN (c."userId",n."userId")))`, [noteIds, viewer?.id ?? null]);
		const moderator = !!viewer && mirrors.length > 0 && await this.roles.isModerator(viewer);
		for (const row of mirrors) {
			const placements = result.get(row.noteId) ?? [];
			placements.push({ origin: this.config.url, channelId: row.channelId, canonicalUri: row.canonicalUri, name: row.name, color: row.color, isSensitive: row.isSensitive, isArchived: row.isArchived, allowRenoteToExternal: row.allowRenoteToExternal,
				state: 'active', placementId: row.placementId, canRemove: viewer != null && (viewer.id === row.ownerId || moderator) });
			result.set(row.noteId, placements);
		}
		await this.packMirrorOrigins(noteIds, viewer, result);
		return result;
	}

	private async listCandidates(input: PlacementInputs['channels']) {
		if (!input.channelId && !this.enabled) throw unavailable();
		const actor = await this.resolveActor(input.actorId);
		const query = this.db.getRepository(MiChannel).createQueryBuilder('channel')
			.where(input.channelId ? 'channel.id = :channelId' : 'channel."isArchived" = false', { channelId: input.channelId })
			.andWhere(`NOT EXISTS (SELECT 1 FROM channel_muting m WHERE m."userId" = :viewer AND m."channelId" = channel.id AND (m."expiresAt" IS NULL OR m."expiresAt" > CURRENT_TIMESTAMP))`, { viewer: actor.id })
			.andWhere(`NOT EXISTS (SELECT 1 FROM blocking b WHERE (b."blockerId" = :viewer AND b."blockeeId" = channel."userId") OR (b."blockeeId" = :viewer AND b."blockerId" = channel."userId"))`);
		if (input.list === 'favorite' || input.list === 'favorites') query.andWhere('EXISTS (SELECT 1 FROM channel_favorite f WHERE f."userId" = :viewer AND f."channelId" = channel.id)');
		if (input.list === 'owned') query.andWhere('channel."userId" = :viewer');
		if (input.list === 'following') query.andWhere('EXISTS (SELECT 1 FROM channel_following f WHERE f."followerId" = :viewer AND f."followeeId" = channel.id)');
		if (input.list === 'featured') query.andWhere('channel."lastNotedAt" IS NOT NULL');
		if (input.before) query.andWhere('channel.id < :before', { before: input.before });
		if (input.query?.trim()) query.andWhere(input.queryType === 'nameOnly' ? 'channel.name ILIKE :search' : '(channel.name ILIKE :search OR channel.description ILIKE :search)', { search: '%' + sqlLikeEscape(input.query.trim()) + '%' });
		const limit = input.limit ?? 12;
		const rows = await query.orderBy('channel.id', 'DESC').take(limit + 1).getMany();
		const channels = await Promise.all(rows.slice(0, limit).map(async row => {
			const packed = await this.modules.get(ChannelEntityService, { strict: false }).pack(row, { id: actor.id });
			return { id: row.id, name: row.name, description: row.description, bannerUrl: packed.bannerUrl, color: row.color,
				isArchived: row.isArchived, isSensitive: row.isSensitive, allowRenoteToExternal: row.allowRenoteToExternal, isFollowing: packed.isFollowing === true, notesCount: row.notesCount,
				isFavorited: packed.isFavorited === true, isOwned: row.userId === actor.id, usersCount: row.usersCount, createdAt: packed.createdAt, lastNotedAt: packed.lastNotedAt };
		}));
		return { origin: this.config.url, channels, enabled: true, next: rows.length > limit ? channels.at(-1)!.id : null };
	}

	public async channels(user: MiLocalUser, input: PlacementChannels) {
		if (!(input.channelId ? await this.hasPeerCapability() : await this.peerEnabled())) return { origin: this.peer?.peerOrigin ?? '', enabled: false, channels: [], next: null };
		const result = await this.call<'channels', Awaited<ReturnType<GridspacePlacementService['listCandidates']>>>('channels', { ...input, ...await this.currentActorCredential(user) });
		if (result.origin !== this.peer!.peerOrigin || !Array.isArray(result.channels) || result.channels.length > 20) throw unavailable();
		return result;
	}

	public async updateChannel(viewer: MiLocalUser, input: ChannelUpdate) {
		return this.call<'channel-update', { isFollowing: boolean; isFavorited: boolean }>('channel-update', { ...input, ...await this.currentActorCredential(viewer) });
	}

	private async receiveChannelUpdate(input: PlacementInputs['channel-update']) {
		const actor = await this.resolveActor(input.actorId);
		const result = await this.db.transaction(async manager => {
			await this.resolveActor(input.actorId, manager);
			await this.checkChannel(input.channelId, actor, false, false, manager);
			const followKey = { followerId: actor.id, followeeId: input.channelId };
			const favoriteKey = { userId: actor.id, channelId: input.channelId };
			const follow = manager.getRepository(MiChannelFollowing);
			const favorite = manager.getRepository(MiChannelFavorite);
			if (input.action === 'follow') await follow.createQueryBuilder().insert().values({ id: this.ids.gen(), ...followKey }).orIgnore().execute();
			if (input.action === 'unfollow') await follow.delete(followKey);
			if (input.action === 'favorite') await favorite.createQueryBuilder().insert().values({ id: this.ids.gen(), ...favoriteKey }).orIgnore().execute();
			if (input.action === 'unfavorite') await favorite.delete(favoriteKey);
			return { isFollowing: await follow.existsBy(followKey), isFavorited: await favorite.existsBy(favoriteKey) };
		});
		if (input.action === 'follow' || input.action === 'unfollow') this.modules.get(GlobalEventService, { strict: false }).publishInternalEvent(input.action === 'follow' ? 'followChannel' : 'unfollowChannel', { userId: actor.id, channelId: input.channelId });
		return result;
	}

	private async changed(manager: EntityManager, row: MiGridspacePlacement, kind: 'place-add' | 'place-remove' | 'origin-delete'): Promise<void> {
		const mirror = row.includeDefault ? await manager.findOne(MiNote, { select: { id: true },
			where: { uri: In([row.canonicalUri, row.canonicalUri + '/activity']), gridspaceShared: true } }) : null;
		await recordPlacementChange(manager, { kind, canonicalUri: row.canonicalUri, channelOrigin: this.config.url, noteId: mirror?.id ?? null,
			channelId: row.channelId, sourceRevision: row.sourceRevision, targetRevision: row.targetRevision });
		await refreshPlacementChannel(manager, row.channelId, this.config.url, this.config.id);
	}

	private async receivePlace(input: PlacementInputs['place'] | PlacementInputs['remove'], removing: boolean): Promise<PlacementStatus> {
		const peer = this.peer!;
		const originNoteId = ownedId(input.canonicalUri, peer.peerOrigin, 'notes');
		if (!removing) {
			if (!this.enabled) throw new GridspaceLinkError('PEER_UNAVAILABLE');
			const place = input as PlacementInputs['place'];
			this.checkPreview(place);
			const intent = await this.call<'sync', { hash: string; actorId: string; sortAt: string; includeDefault: boolean }>('sync', this.key(place));
			if (intent.hash !== place.hash || intent.actorId !== place.actorId || intent.sortAt !== place.sortAt || intent.includeDefault !== place.includeDefault) throw revoked();
			await this.resolveActor(input.actorId);
		}
		return this.db.transaction(async manager => {
			await lockUri(manager, input.canonicalUri);
			if (await manager.existsBy(MiGridspaceNoteTombstone, { uri: input.canonicalUri })) return { ...this.key(input), placementId: null, targetRevision: 0, state: 'origin-deleted' };
			const repo = manager.getRepository(MiGridspacePlacement);
			let row = await repo.findOneBy({ channelId: input.channelId, canonicalUri: input.canonicalUri });
			// A destination owner removal is terminal even when the source later retries a higher revision.
			if (row && row.state !== 'active') {
				if (row.sourceRevision < input.sourceRevision) {
					row = await repo.save({ ...row, sourceRevision: input.sourceRevision, ...enqueue() });
				}
				return statusOf(row);
			}
			if (row && (input.sourceRevision < row.sourceRevision || (!removing && input.sourceRevision === row.sourceRevision))) return statusOf(row);
			if (!removing) {
				const actor = await this.resolveActor(input.actorId, manager);
				await this.checkChannel(input.channelId, actor, true, input.includeDefault, manager);
				// The canonical URI lock makes a multi-channel note consume a single posting allowance.
				if (!await repo.existsBy({ canonicalUri: input.canonicalUri })) {
					const factor = (await this.roles.getUserPolicies(actor.id)).rateLimitFactor;
					const limiter = this.modules.get(RateLimiterService, { strict: false });
					if (factor > 0 && await limiter.limit({ key: 'notes/create', duration: 3600000, max: 300 }, actor.id, factor)) throw new GridspaceLinkError('RATE_LIMITED');
				}
			} else {
				await manager.findOne(MiChannel, { where: { id: input.channelId }, lock: { mode: 'pessimistic_write' } });
			}
			const prior = row?.state;
			row = await repo.save({ ...row, channelId: input.channelId, canonicalUri: input.canonicalUri, noteOrigin: peer.peerOrigin, channelOrigin: peer.origin, originNoteId,
				authorUri: peer.peerOrigin + '/users/' + input.actorId, authorOrigin: peer.peerOrigin, sortAt: new Date(input.sortAt), includeDefault: input.includeDefault,
				sourceRevision: input.sourceRevision, targetRevision: (row?.targetRevision ?? 0) + 1, state: removing ? 'removed' : 'active', ...enqueue() });
			if (row.state !== prior) await this.changed(manager, row, removing ? 'place-remove' : 'place-add');
			return statusOf(row);
		});
	}

	private key(input: PlacementKey): PlacementKey {
		return { canonicalUri: input.canonicalUri, channelId: input.channelId, sourceRevision: input.sourceRevision };
	}

	private async receiveDelete(input: PlacementKey): Promise<PlacementStatus> {
		ownedId(input.canonicalUri, this.peer!.peerOrigin, 'notes');
		return this.db.transaction(async manager => {
			await lockUri(manager, input.canonicalUri);
			await manager.upsert(MiGridspaceNoteTombstone, { uri: input.canonicalUri }, ['uri']);
			const repo = manager.getRepository(MiGridspacePlacement);
			const rows = await repo.find({ where: { canonicalUri: input.canonicalUri }, order: { channelId: 'ASC' } });
			for (const row of rows) {
				if (row.state === 'origin-deleted') continue;
				await manager.findOne(MiChannel, { where: { id: row.channelId }, lock: { mode: 'pessimistic_write' } });
				const updated = await repo.save({ ...row, state: 'origin-deleted' as const, sourceRevision: Math.max(row.sourceRevision, input.sourceRevision), targetRevision: row.targetRevision + 1, ...enqueue() });
				await this.changed(manager, updated, 'origin-delete');
			}
			return { ...this.key(input), placementId: null, targetRevision: 0, state: 'origin-deleted' };
		});
	}

	private async receiveStatus(input: PlacementStatus): Promise<{ ok: boolean }> {
		ownedId(input.canonicalUri, this.config.url, 'notes');
		return this.db.transaction(async manager => {
			const repo = manager.getRepository(MiGridspacePlacementTarget);
			const row = await repo.findOne({ where: { canonicalUri: input.canonicalUri, channelId: input.channelId, peerOrigin: this.peer!.peerOrigin }, lock: { mode: 'pessimistic_write' } });
			if (!row || input.sourceRevision !== row.sourceRevision || input.targetRevision < row.targetRevision || row.state === 'origin-deleted') return { ok: true };
			if (row.state === 'removed' && input.state !== 'removed') return { ok: true };
			if (row.permanentFailure && input.state === 'active') return { ok: true };
			if (row.state === input.state && row.targetRevision === input.targetRevision && row.retryAt === null) return { ok: true };
			if (input.state === 'active' && !input.placementId) throw unavailable();
			await repo.update(row.id, { state: input.state, placementId: input.placementId, targetRevision: input.targetRevision, version: randomUUID(), retryAt: null, attempts: 0 });
			await recordPlacementChange(manager, { kind: input.state === 'active' ? 'place-add' : input.state === 'removed' ? 'place-remove' : 'origin-delete',
				canonicalUri: row.canonicalUri, channelOrigin: row.peerOrigin, channelId: row.channelId, sourceRevision: row.sourceRevision, targetRevision: input.targetRevision, noteId: row.noteId });
			return { ok: true };
		});
	}

	public async remove(user: MiLocalUser, input: { canonicalUri: string; channelId: string; channelOrigin: string }): Promise<void> {
		if (input.channelOrigin === this.config.url) {
			if (input.canonicalUri.startsWith(this.config.url + '/notes/')) {
				await this.modules.get(NotePlacementService, { strict: false }).removeLocal(user, input.channelId, input.canonicalUri);
				return;
			}
			if (!this.peer) throw unavailable();
			ownedId(input.canonicalUri, this.peer.peerOrigin, 'notes');
			await this.db.transaction(async manager => {
				await lockUri(manager, input.canonicalUri);
				const repo = manager.getRepository(MiGridspacePlacement);
				const row = await repo.findOneBy({ canonicalUri: input.canonicalUri, channelId: input.channelId });
				const channel = await manager.findOne(MiChannel, { where: { id: input.channelId }, lock: { mode: 'pessimistic_write' } });
				if (!channel || (channel.userId !== user.id && !await this.roles.isModerator(user))) throw revoked();
				if (!row || row.state !== 'active') return;
				const updated = await repo.save({ ...row, state: 'removed' as const, targetRevision: row.targetRevision + 1, ...enqueue() });
				await this.changed(manager, updated, 'place-remove');
			});
			return;
		}
		if (!this.peer || input.channelOrigin !== this.peer.peerOrigin) throw unavailable();
		const noteId = ownedId(input.canonicalUri, this.config.url, 'notes');
		await this.db.transaction(async manager => {
			const repo = manager.getRepository(MiGridspacePlacementTarget);
			const row = await repo.findOne({ where: { noteId, authorId: user.id, channelId: input.channelId, peerOrigin: input.channelOrigin }, lock: { mode: 'pessimistic_write' } });
			if (!row) throw revoked();
			if (row.state === 'removed' || row.state === 'origin-deleted') return;
			await repo.update(row.id, { state: 'removed', sourceRevision: row.sourceRevision + 1, ...enqueue() });
			await recordPlacementChange(manager, { kind: 'place-remove', canonicalUri: input.canonicalUri, channelId: input.channelId, channelOrigin: input.channelOrigin, sourceRevision: row.sourceRevision + 1, targetRevision: row.targetRevision, noteId });
		});
	}

	public async retry(user: MiLocalUser, canonicalUri: string): Promise<void> {
		const noteId = ownedId(canonicalUri, this.config.url, 'notes');
		await this.currentActorCredential(user);
		if (!await this.peerEnabled()) throw unavailable();
		const original = await this.db.getRepository(MiNote).findOneBy({ id: noteId, multiNoteKind: 'root', uri: IsNull(), userHost: IsNull() });
		if (!original || (original.userId !== user.id && !await this.roles.isModerator(user))) throw revoked();
		await this.db.getRepository(MiGridspacePlacementTarget).update({ canonicalUri, noteId, authorId: original.userId,
			state: In(['failed', 'pending']), permanentFailure: false }, { state: 'pending', ...enqueue() });
	}

	public async stageOriginDelete(manager: EntityManager, note: MiNote): Promise<void> {
		if (!note.multiNoteKind && !note.channelId) return;
		await manager.update(MiNoteCreateReceipt, { noteId: note.id }, { deleted: true });
		const local = manager.getRepository(MiNoteChannelPlacement);
		for (const row of await local.find({ where: { noteId: note.id }, order: { channelId: 'ASC' } })) {
			await manager.findOne(MiChannel, { where: { id: row.channelId }, lock: { mode: 'pessimistic_write' } });
			await local.update(row.id, { state: 'origin-deleted', removedAt: new Date() });
			await recordPlacementChange(manager, { kind: 'origin-delete', canonicalUri: row.canonicalUri, channelId: row.channelId, channelOrigin: this.config.url, noteId: note.id });
			await refreshPlacementChannel(manager, row.channelId, this.config.url, this.config.id);
		}
		const repo = manager.getRepository(MiGridspacePlacementTarget);
		for (const row of await repo.createQueryBuilder('target').where('target.noteId = :noteId', { noteId: note.id }).orderBy('target.id').setLock('pessimistic_write').getMany()) {
			await repo.update(row.id, { state: 'origin-deleted', sourceRevision: row.sourceRevision + 1, ...enqueue() });
			await recordPlacementChange(manager, { kind: 'origin-delete', canonicalUri: row.canonicalUri, channelOrigin: row.peerOrigin,
				channelId: row.channelId, noteId: note.id, sourceRevision: row.sourceRevision + 1, targetRevision: row.targetRevision });
		}
	}

	public async issueProof(actorUri: string, canonicalUri: string, channelId: string, purpose: PlacementPurpose): Promise<PlacementProof> {
		const peer = this.peer;
		if (!peer || (purpose !== 'read' && !this.enabled)) throw unavailable();
		ownedId(canonicalUri, peer.peerOrigin, 'notes');
		const actor = actorUri.startsWith(peer.origin + '/users/')
			? await this.db.getRepository(MiUser).findOneBy({ id: ownedId(actorUri, peer.origin, 'users'), host: IsNull(), isSuspended: false, isDeleted: false, movedToUri: IsNull() })
			: await this.resolveActor(ownedId(actorUri, peer.peerOrigin, 'users'));
		if (!actor) throw revoked();
		return this.db.transaction(async manager => {
			await lockUri(manager, canonicalUri);
			const row = await manager.findOneBy(MiGridspacePlacement, { channelId, canonicalUri, state: 'active' });
			if (!row || await manager.existsBy(MiGridspaceNoteTombstone, { uri: canonicalUri })) throw revoked();
			const author = await this.resolveActor(ownedId(row.authorUri, peer.peerOrigin, 'users'), manager);
			if (await manager.existsBy(MiBlocking, [{ blockerId: actor.id, blockeeId: author.id }, { blockerId: author.id, blockeeId: actor.id }])) throw revoked();
			await this.checkChannel(channelId, actor, purpose !== 'read', false, manager);
			const data = { actorUri, canonicalUri, channelOrigin: peer.origin, channelId, purpose, sourceRevision: row.sourceRevision, targetRevision: row.targetRevision,
				placementId: row.id, expiresAt: Date.now() + 60000 };
			return { ...data, signature: signPlacementProof(peer, data) };
		});
	}

	public async consumeProof(proof: PlacementProof, actorUri: string, canonicalUri: string, purpose: PlacementPurpose, manager?: EntityManager): Promise<void> {
		if (!this.peer || !verifyPlacementProof(this.peer, proof, actorUri, canonicalUri, purpose)) throw revoked();
		const repository = (manager ?? this.db.manager).getRepository(MiGridspacePlacementTarget);
		const row = await repository.findOne({ where: { canonicalUri, peerOrigin: proof.channelOrigin, channelId: proof.channelId, state: 'active',
			placementId: proof.placementId, sourceRevision: proof.sourceRevision, targetRevision: proof.targetRevision },
		...(manager ? { lock: { mode: 'pessimistic_read' as const } } : {}) });
		if (!row) throw revoked();
	}

	public async requestProof(viewer: MiLocalUser, canonicalUri: string, channelId: string, purpose: PlacementPurpose): Promise<PlacementProof> {
		const { actorId } = await this.currentActorCredential(viewer);
		return this.call<'proof', PlacementProof>('proof', { actorUri: this.config.url + '/users/' + actorId, canonicalUri, channelId, purpose });
	}

	public async authorizeConversationWrite(viewer: MiUser, root: MiNote, purpose: 'reply' | 'upload', manager?: EntityManager): Promise<void> {
		if (root.multiNoteKind !== 'root' || !this.config.multiNote?.enabled || viewer.isDeleted || viewer.isSuspended || viewer.movedToUri) throw revoked();
		const db = manager ?? this.db.manager;
		const local = await db.find(MiNoteChannelPlacement, { where: { noteId: root.id, state: 'active' }, order: { channelId: 'ASC' } });
		for (const row of local) {
			try {
				await this.checkChannel(row.channelId, viewer, true, false, manager);
				if (await db.existsBy(MiNoteChannelPlacement, { id: row.id, state: 'active' })) return;
			} catch (error) { if (!(error instanceof GridspaceLinkError)) throw error; }
		}
		const canonicalUri = this.config.url + '/notes/' + root.id;
		const actorUri = viewer.host === null ? this.config.url + '/users/' + viewer.id : viewer.uri;
		if (!actorUri || !this.peer || !this.enabled) throw revoked();
		const targets = await db.findBy(MiGridspacePlacementTarget, { canonicalUri, peerOrigin: this.peer.peerOrigin, state: 'active' });
		for (const target of targets) {
			try {
				const proof = await this.call<'proof', PlacementProof>('proof', { actorUri, canonicalUri, channelId: target.channelId, purpose });
				await this.consumeProof(proof, actorUri, canonicalUri, purpose, manager);
				return;
			} catch (error) { if (!(error instanceof Error)) throw error; }
		}
		throw revoked();
	}

	private async sourcePreview(row: MiGridspacePlacementTarget): Promise<PlacementPreview> {
		const note = await this.db.getRepository(MiNote).findOneBy({ id: row.noteId, userId: row.authorId, multiNoteKind: 'root', visibility: 'public' });
		if (!note) throw unavailable();
		const actor = await this.db.getRepository(MiUser).findOneBy({ id: row.authorId, host: IsNull() });
		if (!actor) throw revoked();
		await this.currentActorCredential(actor as MiLocalUser);
		const files = note.fileIds.length ? await this.db.getRepository(MiDriveFile).findBy({ id: In(note.fileIds) }) : [];
		const indexed = new Map(files.map(f => [f.id, f]));
		const poll = note.hasPoll ? await this.db.getRepository(MiPoll).findOneBy({ noteId: note.id }) : null;
		return { text: note.text, cw: note.cw, pollChoices: poll?.choices, files: note.fileIds.flatMap(id => {
			const f = indexed.get(id);
			return f ? [{ name: f.name, comment: f.comment, isSensitive: f.isSensitive }] : [];
		}) };
	}

	public readonly handlers = {
		sync: async (input: PlacementInputs['sync']) => {
			if (!this.enabled) throw new GridspaceLinkError('PEER_UNAVAILABLE');
			const noteId = ownedId(input.canonicalUri, this.config.url, 'notes');
			const row = await this.db.getRepository(MiGridspacePlacementTarget).findOneBy({ ...input, noteId,
				peerOrigin: this.peer!.peerOrigin, permanentFailure: false, state: In(['pending', 'failed', 'active']) });
			if (!row) throw unavailable();
			return { hash: previewHash(await this.sourcePreview(row)), actorId: row.authorId, sortAt: row.sortAt.toISOString(), includeDefault: row.includeDefault };
		},
		lookup: (input: PlacementInputs['lookup']) => this.visiblePeerTargets(input),
		'origin-lookup': (input: PlacementInputs['origin-lookup']) => this.originLookup(input),
		channels: (input: PlacementInputs['channels']) => this.listCandidates(input),
		'channel-update': (input: PlacementInputs['channel-update']) => this.receiveChannelUpdate(input),
		prepare: (input: PlacementInputs['prepare']) => this.receivePrepare(input),
		place: (input: PlacementInputs['place']) => this.receivePlace(input, false),
		remove: (input: PlacementInputs['remove']) => this.receivePlace(input, true),
		status: (input: PlacementInputs['status']) => this.receiveStatus(input),
		'request-status': async (input: PlacementKey) => {
			ownedId(input.canonicalUri, this.peer!.peerOrigin, 'notes');
			const row = await this.db.getRepository(MiGridspacePlacement).findOneBy({ canonicalUri: input.canonicalUri, channelId: input.channelId });
			return { status: row ? statusOf(row) : null };
		},
		'delete-origin': (input: PlacementKey) => this.receiveDelete(input),
		proof: (input: PlacementInputs['proof']) => this.issueProof(input.actorUri, input.canonicalUri, input.channelId, input.purpose),
	};

	private async deliver(row: MiGridspacePlacementTarget): Promise<void> {
		const key = this.key(row);
		let status: PlacementStatus;
		if (row.state === 'origin-deleted') {
			status = await this.call<'delete-origin', PlacementStatus>('delete-origin', key);
		} else {
			const identity = { ...key, actorId: row.authorId, sortAt: row.sortAt.toISOString(), includeDefault: row.includeDefault };
			if (row.state === 'removed') {
				status = await this.call<'remove', PlacementStatus>('remove', identity);
			} else {
				if (!await this.peerEnabled()) throw new GridspaceLinkError('PEER_UNAVAILABLE');
				if (row.attempts > 0) {
					const { status: previous } = await this.call<'request-status', { status: PlacementStatus | null }>('request-status', key);
					if (previous && previous.sourceRevision === row.sourceRevision && previous.channelId === row.channelId && previous.canonicalUri === row.canonicalUri) {
						await this.receiveStatus(previous);
						return;
					}
				}
				const preview = await this.sourcePreview(row);
				status = await this.call<'place', PlacementStatus>('place', { ...identity, preview, hash: previewHash(preview) });
			}
		}
		if (!status || status.canonicalUri !== key.canonicalUri || status.channelId !== key.channelId || status.sourceRevision !== key.sourceRevision ||
			!['active', 'removed', 'origin-deleted'].includes(status.state) || !Number.isSafeInteger(status.targetRevision)) throw unavailable();
		if (row.state === 'origin-deleted') {
			if (status.state !== 'origin-deleted') throw unavailable();
			await this.db.getRepository(MiGridspacePlacementTarget).update({ id: row.id, version: row.version }, { retryAt: null });
		} else {
			await this.receiveStatus(status);
		}
	}

	public async flush(): Promise<void> {
		if (!this.peer || this.working) return;
		this.working = true;
		try {
			const sources = this.db.getRepository(MiGridspacePlacementTarget);
			const destinations = this.db.getRepository(MiGridspacePlacement);
			const now = new Date();
			const due = { retryAt: LessThanOrEqual(now) };
			for (const row of await sources.find({ where: { ...due, peerOrigin: this.peer.peerOrigin, state: In(['pending', 'removed', 'origin-deleted']) }, order: { retryAt: 'ASC' }, take: 20 })) {
				try {
					await this.deliver(row);
				} catch (error) {
					const attempts = row.attempts + 1;
					const permanentFailure = row.state === 'pending' && error instanceof GridspaceLinkError && ['CHANNEL_UNAVAILABLE', 'AUTHORIZATION_REVOKED'].includes(error.code);
					const failed = row.state === 'pending' && (permanentFailure || attempts >= 5);
					await sources.update({ id: row.id, version: row.version }, {
						attempts, permanentFailure, retryAt: failed ? null : new Date(Date.now() + Math.min(300000, 3000 * 2 ** Math.min(attempts, 7))),
						...(failed ? { state: 'failed' as const } : {}),
					});
				}
			}
			for (const row of await destinations.find({ where: { ...due, noteOrigin: this.peer.peerOrigin }, order: { retryAt: 'ASC' }, take: 20 })) {
				try {
					const ack = await this.call<'status', { ok: boolean }>('status', statusOf(row));
					if (ack.ok !== true) throw unavailable();
					await destinations.update({ id: row.id, version: row.version }, { retryAt: null });
				} catch {
					await destinations.update({ id: row.id, version: row.version }, { attempts: row.attempts + 1,
						retryAt: new Date(Date.now() + Math.min(300000, 3000 * 2 ** Math.min(row.attempts + 1, 7))) });
				}
			}
		} catch { /* A database outage leaves every unacknowledged version in the queue. */ } finally { this.working = false; }
	}
}
