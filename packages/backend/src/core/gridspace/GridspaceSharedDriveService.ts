/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DataSource, EntityManager, IsNull, LessThanOrEqual } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiDriveFile } from '@/models/DriveFile.js';
import { MiDriveFolder } from '@/models/DriveFolder.js';
import { MiGridspaceLink } from '@/models/Gridspace.js';
import { MiGridspaceDriveEntry } from '@/models/GridspaceDriveEntry.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { DriveService } from '@/core/DriveService.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { DriveFolderEntityService } from '@/core/entities/DriveFolderEntityService.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceLinkService } from './GridspaceLinkService.js';
import { sharedDriveUnavailable, validateSharedDriveValues, validateSharedDriveWire, type SharedDriveRef, type SharedDriveRequest, type SharedDriveValues, type SharedDriveWire } from './shared-drive-protocol.js';

type Kind = SharedDriveWire['kind'];
type Change = { kind: Kind; id: string; deleted: boolean; created: boolean };
type StoredWire = SharedDriveWire & { binding?: Pick<SharedDriveRequest, 'linkId' | 'generation' | 'localUserId' | 'peerUserId'> };

/** File bytes have one owner. The other database holds a normal-API reference. */
@Injectable()
export class GridspaceSharedDriveService implements OnModuleInit, OnApplicationShutdown {
	private timer: ReturnType<typeof setInterval> | undefined;
	private working = false;
	private sending = new Set<string>();
	private auditCursor = new Map<string, string>();
	private lastAudit = 0;
	private readonly origin: string;
	private readonly peerOrigin: string;

	constructor(
		@Inject(DI.db) private db: DataSource, @Inject(DI.config) private config: Config,
		private modules: ModuleRef,
		private links: GridspaceLinkService, private files: DriveFileEntityService,
		private folders: DriveFolderEntityService, private ids: IdService, private events: GlobalEventService,
	) {
		this.origin = new URL(config.url).origin;
		this.peerOrigin = config.gridspace?.peerUrl ? new URL(config.gridspace.peerUrl).origin : '';
	}

	private get drive() { return this.modules.get(DriveService, { strict: false }); }

	public onModuleInit() {
		if (!this.config.gridspace?.enabled) return;
		this.timer = setInterval(() => void this.tick().catch(() => {}), 2000);
		this.timer.unref();
	}

	public onApplicationShutdown() { clearInterval(this.timer); }

	private async link(userId: string, manager = this.db.manager, cleanup = false) {
		if (!this.config.gridspace?.enabled) return null;
		if (!cleanup && !await manager.getRepository(MiUser).existsBy({ id: userId, host: IsNull(), isDeleted: false, isSuspended: false })) return null;
		return manager.getRepository(MiGridspaceLink).findOneBy({ localUserId: userId, peerOrigin: this.peerOrigin, state: 'active', driveShared: true });
	}

	private async actor(input: SharedDriveRequest) {
		const link = await this.db.getRepository(MiGridspaceLink).findOneBy({ id: input.linkId, generation: input.generation,
			localUserId: input.peerUserId, peerUserId: input.localUserId, peerOrigin: this.peerOrigin, state: 'active', ...(input.action === 'release' ? {} : { driveShared: true }) });
		const user = link && await this.db.getRepository(MiUser).findOneBy({ id: link.localUserId, host: IsNull(), isDeleted: false, isSuspended: false });
		if (!link || !user || user.host !== null) throw new ApiError(sharedDriveUnavailable);
		return { link, user: user as MiLocalUser };
	}

	private credential(link: MiGridspaceLink) {
		return { linkId: link.id, generation: link.generation, localUserId: link.localUserId, peerUserId: link.peerUserId };
	}

	private async request<T>(link: MiGridspaceLink, input: Omit<SharedDriveRequest, 'linkId' | 'generation' | 'localUserId' | 'peerUserId'>): Promise<T> {
		try {
			const result = await this.links.json<T>('/gridspace/v1/shared-drive', { ...this.credential(link), ...input });
			const current = await this.link(link.localUserId, this.db.manager, input.action === 'put' && input.wire?.deleted === true);
			if (!current || current.id !== link.id || current.generation !== link.generation) throw new Error('Sharing changed');
			return result;
		} catch { throw new ApiError(sharedDriveUnavailable); }
	}

	private repository(manager: EntityManager, kind: Kind) {
		return kind === 'file' ? manager.getRepository(MiDriveFile) : manager.getRepository(MiDriveFolder);
	}

	private async folderRef(manager: EntityManager, folderId: string | null): Promise<SharedDriveRef | null> {
		if (!folderId) return null;
		const entry = await manager.getRepository(MiGridspaceDriveEntry).findOneBy({ kind: 'folder', localId: folderId });
		return entry ? { origin: entry.origin, id: entry.sourceId } : { origin: this.origin, id: folderId };
	}

	private async snapshot(manager: EntityManager, kind: Kind, localId: string, userId: string, revision: number): Promise<SharedDriveWire | null> {
		const row = await this.repository(manager, kind).findOneBy({ id: localId, userId });
		if (!row) return null;
		const entry = await manager.getRepository(MiGridspaceDriveEntry).findOneBy({ kind, localId });
		const wire: SharedDriveWire = { kind, origin: entry?.origin ?? this.origin, id: entry?.sourceId ?? row.id,
			revision, deleted: false, createdAt: this.ids.parse(row.id).date.toISOString(), name: row.name,
			parent: await this.folderRef(manager, kind === 'file' ? (row as MiDriveFile).folderId : (row as MiDriveFolder).parentId) };
		if (kind === 'file') {
			const file = row as MiDriveFile;
			wire.file = { url: file.url, thumbnailUrl: file.thumbnailUrl, webpublicUrl: file.webpublicUrl, webpublicType: file.webpublicType,
				type: file.type, md5: file.md5, size: file.size, comment: file.comment, blurhash: file.blurhash,
				properties: file.properties, isSensitive: file.isSensitive };
		}
		return wire;
	}

	private async ancestors(link: MiGridspaceLink, wire: SharedDriveWire) {
		const result: SharedDriveWire[] = [];
		let parent = wire.parent;
		const seen = new Set<string>();
		while (parent) {
			const key = parent.origin + '/' + parent.id;
			if (seen.has(key) || seen.size >= 64) throw new ApiError(sharedDriveUnavailable);
			seen.add(key);
			const entry = await this.db.getRepository(MiGridspaceDriveEntry).findOneBy({ linkId: link.id, kind: 'folder', origin: parent.origin, sourceId: parent.id });
			const id = entry?.localId ?? (parent.origin === this.origin ? parent.id : null);
			const row = id && await this.snapshot(this.db.manager, 'folder', id, link.localUserId, entry?.revision ?? 0);
			if (!row) break;
			result.unshift(row);
			parent = row.parent;
		}
		return result;
	}

	/** Called after native mutations; persisting the outbox never downloads media. */
	public async changed(kind: Kind, localId: string, userId: string | null, deleted = false, audit = false) {
		if (!userId) return;
		const link = await this.link(userId, this.db.manager, deleted);
		if (!link) return;
		await this.db.transaction(async manager => {
			await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`shared-drive:${kind}:${localId}`]);
			const repository = manager.getRepository(MiGridspaceDriveEntry);
			let entry = await repository.findOneBy({ kind, localId });
			if (entry && entry.origin !== this.origin) return null;
			if (!entry) entry = repository.create({ id: randomUUID(), linkId: link.id, kind, origin: this.origin, sourceId: localId, localId, revision: 0 });
			const next = deleted ? { ...(entry.payload as unknown as SharedDriveWire | null), kind, origin: this.origin, id: localId,
				name: '', parent: null, createdAt: this.ids.parse(localId).date.toISOString(), deleted: true, revision: entry.revision + 1 } as SharedDriveWire
				: await this.snapshot(manager, kind, localId, userId, entry.revision + 1);
			if (!next) return null;
			(next as StoredWire).binding = this.credential(link);
			if (audit && entry.payload && isDeepStrictEqual({ ...entry.payload, revision: 0 }, { ...next, revision: 0 })) return null;
			entry.revision = next.revision; entry.deleted = next.deleted; entry.payload = next as unknown as Record<string, unknown>;
			entry.pending = true; entry.retryAt = new Date(); entry.lastError = null; entry.attempts = 0;
			return repository.save(entry);
		});
	}

	private async resolveParent(manager: EntityManager, link: MiGridspaceLink, ref: SharedDriveRef | null) {
		if (!ref) return null;
		let id: string | null;
		if (ref.origin === this.origin) id = ref.id;
		else if (ref.origin === this.peerOrigin) id = (await manager.getRepository(MiGridspaceDriveEntry).findOneBy({ linkId: link.id, kind: 'folder', origin: ref.origin, sourceId: ref.id, deleted: false }))?.localId ?? null;
		else throw new ApiError(sharedDriveUnavailable);
		if (!id) return null; // A concurrently deleted folder becomes the root, like ON DELETE SET NULL.
		const folder = await manager.getRepository(MiDriveFolder).findOneBy({ id, userId: link.localUserId });
		if (!folder) throw new ApiError(sharedDriveUnavailable);
		return folder.id;
	}

	private async acceptRecord(manager: EntityManager, link: MiGridspaceLink, wire: SharedDriveWire, changes: Change[]) {
		validateSharedDriveWire(wire, [this.origin, this.peerOrigin]);
		if (wire.origin === this.origin) {
			if (!await this.repository(manager, wire.kind).existsBy({ id: wire.id, userId: link.localUserId })) throw new ApiError(sharedDriveUnavailable);
			return wire.id;
		}
		await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`shared-drive:${link.id}:${wire.kind}:${wire.id}`]);
		const entries = manager.getRepository(MiGridspaceDriveEntry);
		let entry = await entries.findOneBy({ linkId: link.id, kind: wire.kind, origin: wire.origin, sourceId: wire.id });
		if (entry && (entry.deleted || entry.revision >= wire.revision)) return entry.localId;
		const created = !entry;
		if (!entry) entry = entries.create({ id: randomUUID(), linkId: link.id, kind: wire.kind, origin: wire.origin, sourceId: wire.id,
			localId: this.ids.gen(Date.parse(wire.createdAt)), pending: false, retryAt: new Date(), attempts: 0 });
		const parentId = wire.deleted ? null : await this.resolveParent(manager, link, wire.parent);
		if (wire.deleted) {
			await this.repository(manager, wire.kind).delete({ id: entry.localId, userId: link.localUserId });
		 } else if (wire.kind === 'folder') {
			let cursor = parentId; const seen = new Set<string>();
			while (cursor) {
				if (cursor === entry.localId || seen.has(cursor) || seen.size >= 64) throw new ApiError(sharedDriveUnavailable);
				seen.add(cursor);
				cursor = (await manager.getRepository(MiDriveFolder).findOneByOrFail({ id: cursor, userId: link.localUserId })).parentId;
			}
			await manager.getRepository(MiDriveFolder).save({ id: entry.localId, userId: link.localUserId, name: wire.name, parentId });
		} else {
			const file = wire.file!;
			const current = await manager.getRepository(MiDriveFile).findOneBy({ id: entry.localId });
			if (current && current.userId !== link.localUserId) throw new ApiError(sharedDriveUnavailable);
			await manager.getRepository(MiDriveFile).save({ ...current, id: entry.localId, userId: link.localUserId, userHost: null,
				name: wire.name, ...file, folderId: parentId, isLink: true, storedInternal: false, uri: null,
				accessKey: current?.accessKey ?? randomUUID(), thumbnailAccessKey: current?.thumbnailAccessKey ?? null, webpublicAccessKey: current?.webpublicAccessKey ?? null,
				requestHeaders: null, requestIp: null });
		}
		entry.revision = wire.revision; entry.deleted = wire.deleted; entry.payload = wire as unknown as Record<string, unknown>;
		await entries.save(entry);
		changes.push({ kind: wire.kind, id: entry.localId, deleted: wire.deleted, created });
		return entry.localId;
	}

	private async accept(link: MiGridspaceLink, wire: SharedDriveWire, ancestors: SharedDriveWire[] = []) {
		if (wire.origin !== this.peerOrigin || ancestors.length > 64 || ancestors.some(item => item.kind !== 'folder' || item.deleted)) throw new ApiError(sharedDriveUnavailable);
		const changes: Change[] = [];
		const id = await this.db.transaction(async manager => {
			const current = await manager.getRepository(MiGridspaceLink).findOne({ where: { id: link.id, generation: link.generation, state: 'active', driveShared: true }, lock: { mode: 'pessimistic_read' } });
			if (!current) throw new ApiError(sharedDriveUnavailable);
			for (const parent of ancestors) await this.acceptRecord(manager, link, parent, changes);
			return this.acceptRecord(manager, link, wire, changes);
		});
		for (const change of changes) {
			if (change.deleted) this.events.publishDriveStream(link.localUserId, change.kind === 'file' ? 'fileDeleted' : 'folderDeleted', change.id);
			else if (change.kind === 'file') this.events.publishDriveStream(link.localUserId, change.created ? 'fileCreated' : 'fileUpdated', await this.files.pack(change.id, { self: true }));
			else this.events.publishDriveStream(link.localUserId, change.created ? 'folderCreated' : 'folderUpdated', await this.folders.pack(change.id));
		}
		return id;
	}

	private async deliver(entry: MiGridspaceDriveEntry) {
		if (this.sending.has(entry.id)) return;
		this.sending.add(entry.id);
		try {
			const link = await this.db.getRepository(MiGridspaceLink).findOneBy({ id: entry.linkId, state: 'active', driveShared: true });
			const payload = entry.payload as unknown as StoredWire | null;
			if (!link && entry.deleted && entry.origin === this.origin && payload?.binding) {
				// Account removal cascades the local pair. Only a deletion may use its
				// persisted, nonsecret identity; the peer still validates its live pair.
				const remaining = await this.db.getRepository(MiGridspaceLink).existsBy({ id: entry.linkId });
				if (!remaining) {
					const { binding, ...wire } = payload;
					await this.links.json('/gridspace/v1/shared-drive', { ...binding, action: 'put', wire, ancestors: [] });
					await this.db.getRepository(MiGridspaceDriveEntry).update({ id: entry.id, revision: entry.revision }, { pending: false, lastError: null, attempts: 0 });
					return;
				}
			}
			if (!link || !await this.link(link.localUserId, this.db.manager, entry.deleted) || !entry.payload) {
				await this.db.getRepository(MiGridspaceDriveEntry).update(entry.id, { pending: false, lastError: 'SHARING_STOPPED' });
				return;
			}
			const { binding: _binding, ...wire } = payload!;
			await this.request(link, { action: 'put', wire, ancestors: wire.deleted ? [] : await this.ancestors(link, wire) });
			await this.db.getRepository(MiGridspaceDriveEntry).update({ id: entry.id, revision: entry.revision }, { pending: false, lastError: null, attempts: 0 });
		} catch {
			await this.db.getRepository(MiGridspaceDriveEntry).update({ id: entry.id, revision: entry.revision }, { attempts: entry.attempts + 1,
				lastError: 'PEER_UNAVAILABLE', retryAt: new Date(Date.now() + Math.min(60000, 2000 * 2 ** Math.min(entry.attempts, 5))) });
		} finally { this.sending.delete(entry.id); }
	}

	public async peer(input: SharedDriveRequest): Promise<object> {
		const { link, user } = await this.actor(input);
		if (input.action === 'release') {
			await this.db.getRepository(MiGridspaceLink).update({ id: link.id }, { driveShared: false });
			return { ok: true };
		}
		if (input.action === 'put') {
			if (!input.wire) throw new ApiError(sharedDriveUnavailable);
			return { id: await this.accept(link, input.wire, input.ancestors) };
		}
		if (!input.id || !input.kind) throw new ApiError(sharedDriveUnavailable);
		const row = await this.repository(this.db.manager, input.kind).findOneBy({ id: input.id, userId: user.id });
		const existing = await this.db.getRepository(MiGridspaceDriveEntry).findOneBy({ kind: input.kind, localId: input.id });
		if (existing && existing.origin !== this.origin || !row && !existing?.deleted) throw new ApiError(sharedDriveUnavailable);
		if (input.action === 'mutate') {
			validateSharedDriveValues(input.values ?? {}, [this.origin, this.peerOrigin]);
			if (!row && existing?.deleted && input.deleted) return { wire: existing.payload, ancestors: [] };
			if (!row) throw new ApiError(sharedDriveUnavailable);
			// Bring newly created foreign parent references over before moving the item.
			for (const parent of input.ancestors ?? []) {
				if (parent.kind !== 'folder' || parent.deleted) throw new ApiError(sharedDriveUnavailable);
				if (parent.origin === this.peerOrigin) await this.accept(link, parent, []);
			}
			if (input.kind === 'file') {
				if (input.deleted) await this.drive.deleteFile(row as MiDriveFile, false, user);
				else {
					const values = input.values ?? {};
					await this.drive.updateFile(row as MiDriveFile, { name: values.name, comment: values.comment, isSensitive: values.isSensitive,
						...(values.parent === undefined ? {} : { folderId: await this.resolveParent(this.db.manager, link, values.parent) }) }, user);
				}
			} else await this.mutateFolder(row as MiDriveFolder, input.values ?? {}, Boolean(input.deleted), user);
		}
		await this.changed(input.kind, input.id, user.id, Boolean(input.deleted), true);
		const entry = await this.db.getRepository(MiGridspaceDriveEntry).findOneByOrFail({ kind: input.kind, localId: input.id });
		const wire = entry.payload as unknown as SharedDriveWire;
		return { wire, ancestors: wire.deleted ? [] : await this.ancestors(link, wire) };
	}

	private async proxy(kind: Kind, localId: string, userId: string | null, values: SharedDriveValues, deleted: boolean) {
		if (!this.config.gridspace?.enabled) return false;
		const entry = await this.db.getRepository(MiGridspaceDriveEntry).findOneBy({ kind, localId });
		if (!entry || entry.origin === this.origin) return false;
		// After an administrator releases the pair, this is an ordinary local link.
		const pair = await this.db.getRepository(MiGridspaceLink).findOneBy({ id: entry.linkId });
		if (pair && !pair.driveShared) return false;
		if (!userId) throw new ApiError(sharedDriveUnavailable);
		const link = await this.link(userId);
		if (!link || entry.linkId !== link.id || entry.deleted) throw new ApiError(sharedDriveUnavailable);
		const base = entry.payload as unknown as SharedDriveWire;
		const response = await this.request<{ wire: SharedDriveWire; ancestors: SharedDriveWire[] }>(link, { action: 'mutate', kind, id: entry.sourceId,
			values, deleted, ancestors: values.parent ? await this.ancestors(link, { ...base, parent: values.parent }) : [] });
		if (response.wire.kind !== kind || response.wire.id !== entry.sourceId) throw new ApiError(sharedDriveUnavailable);
		await this.accept(link, response.wire, response.ancestors);
		return true;
	}

	public async updateFile(file: MiDriveFile, values: Partial<MiDriveFile>) {
		if (values.folderId && !await this.db.getRepository(MiDriveFolder).existsBy({ id: values.folderId, userId: file.userId ?? '' })) throw new ApiError(sharedDriveUnavailable);
		return this.proxy('file', file.id, file.userId, { name: values.name, comment: values.comment, isSensitive: values.isSensitive,
			...(values.folderId === undefined ? {} : { parent: await this.folderRef(this.db.manager, values.folderId) }) }, false);
	}

	public async deleteFile(file: MiDriveFile) { return this.proxy('file', file.id, file.userId, {}, true); }

	public async updateFolder(folder: MiDriveFolder, values: { name?: string; parentId?: string | null }) {
		if (values.parentId && !await this.db.getRepository(MiDriveFolder).existsBy({ id: values.parentId, userId: folder.userId ?? '' })) throw new ApiError(sharedDriveUnavailable);
		return this.proxy('folder', folder.id, folder.userId, { name: values.name,
			...(values.parentId === undefined ? {} : { parent: await this.folderRef(this.db.manager, values.parentId) }) }, false);
	}

	public async deleteFolder(folder: MiDriveFolder) { return this.proxy('folder', folder.id, folder.userId, {}, true); }

	private async mutateFolder(folder: MiDriveFolder, values: SharedDriveValues, deleted: boolean, user: MiLocalUser) {
		if (deleted) {
			if (await this.db.getRepository(MiDriveFolder).existsBy({ parentId: folder.id }) || await this.db.getRepository(MiDriveFile).existsBy({ folderId: folder.id })) throw new ApiError(sharedDriveUnavailable);
			await this.db.getRepository(MiDriveFolder).delete({ id: folder.id, userId: user.id });
			await this.changed('folder', folder.id, user.id, true);
			this.events.publishDriveStream(user.id, 'folderDeleted', folder.id);
			return;
		}
		if (values.name !== undefined && (!values.name || values.name.length > 200)) throw new ApiError(sharedDriveUnavailable);
		const parentId = values.parent === undefined ? folder.parentId : await this.resolveParent(this.db.manager, (await this.link(user.id))!, values.parent);
		let current = parentId; const seen = new Set<string>();
		while (current) {
			if (current === folder.id || seen.has(current) || seen.size >= 64) throw new ApiError(sharedDriveUnavailable);
			seen.add(current);
			current = (await this.db.getRepository(MiDriveFolder).findOneByOrFail({ id: current, userId: user.id })).parentId;
		}
		await this.db.getRepository(MiDriveFolder).update(folder.id, { name: values.name ?? folder.name, parentId });
		await this.changed('folder', folder.id, user.id);
		this.events.publishDriveStream(user.id, 'folderUpdated', await this.folders.pack(folder.id));
	}

	public async referenceFile(user: MiLocalUser, sourceId: string) {
		const link = await this.link(user.id);
		if (!link) return null;
		const response = await this.request<{ wire: SharedDriveWire; ancestors: SharedDriveWire[] }>(link, { action: 'get', kind: 'file', id: sourceId });
		if (response.wire.kind !== 'file' || response.wire.id !== sourceId || response.wire.deleted) throw new ApiError(sharedDriveUnavailable);
		return this.files.pack(await this.accept(link, response.wire, response.ancestors), { self: true });
	}

	public async status(userId?: string) {
		const query = this.db.getRepository(MiGridspaceDriveEntry).createQueryBuilder('entry').innerJoin(MiGridspaceLink, 'link', 'link.id = entry.linkId');
		if (userId) query.where('link.localUserId = :userId', { userId });
		const [total, pending, failed] = await Promise.all([query.clone().getCount(), query.clone().andWhere('entry.pending = true').getCount(), query.clone().andWhere('entry.lastError IS NOT NULL').getCount()]);
		const links = this.db.getRepository(MiGridspaceLink).createQueryBuilder('link').where('link.state = :state AND link.driveShared = true', { state: 'active' });
		if (userId) links.andWhere('link.localUserId = :userId', { userId });
		const [accounts, preparing] = await Promise.all([links.clone().getCount(), links.clone().andWhere('link.driveSeeded = false').getCount()]);
		return { total, pending, failed, accounts, preparing };
	}

	public async retry() { await this.db.getRepository(MiGridspaceDriveEntry).update({ pending: true }, { retryAt: new Date(), lastError: null, attempts: 0 }); }
	public async release(userId: string) {
		const link = await this.link(userId);
		if (!link) return;
		await this.request(link, { action: 'release' });
		await this.db.getRepository(MiGridspaceLink).update({ id: link.id }, { driveShared: false });
	}

	public async tick() {
		if (this.working || !this.config.gridspace?.enabled) return;
		this.working = true;
		try {
			const links = await this.db.getRepository(MiGridspaceLink).find({ where: { state: 'active', driveShared: true, peerOrigin: this.peerOrigin }, order: { id: 'ASC' } });
			const audit = Date.now() - this.lastAudit > 60000;
			for (const link of links) {
				if (!await this.link(link.localUserId)) continue;
				if (!link.driveSeeded) {
					let complete = true;
					for (const kind of ['folder', 'file'] as const) {
						const rows = await this.repository(this.db.manager, kind).createQueryBuilder('item').where('item.userId = :userId', { userId: link.localUserId })
							.andWhere('NOT EXISTS (SELECT 1 FROM gridspace_drive_entry e WHERE e.kind = :kind AND e."localId" = item.id)', { kind })
							// Match the existing (userId, folderId, id) index instead of scanning every owner's primary-key entries.
							.orderBy(kind === 'file' ? 'item.folderId' : 'item.id', 'ASC').addOrderBy('item.id', 'ASC').take(2).getMany();
						for (const row of rows) await this.changed(kind, row.id, link.localUserId);
						if (rows.length === 2) complete = false;
					}
					if (complete) await this.db.getRepository(MiGridspaceLink).update(link.id, { driveSeeded: true });
				}
				if (audit) {
					const rows = await this.db.getRepository(MiGridspaceDriveEntry).createQueryBuilder('entry').where('entry.linkId = :linkId AND entry.origin = :origin AND entry.deleted = false', { linkId: link.id, origin: this.origin })
						.andWhere('entry.localId > :after', { after: this.auditCursor.get(link.id) ?? '' }).orderBy('entry.localId', 'ASC').take(20).getMany();
					for (const row of rows) await this.changed(row.kind, row.localId, link.localUserId, !await this.repository(this.db.manager, row.kind).existsBy({ id: row.localId, userId: link.localUserId }), true);
					this.auditCursor.set(link.id, rows.length === 20 ? rows.at(-1)!.localId : '');
				}
			}
			if (audit) this.lastAudit = Date.now();
			const pending = await this.db.getRepository(MiGridspaceDriveEntry).find({ where: { pending: true, retryAt: LessThanOrEqual(new Date()) }, order: { retryAt: 'ASC' }, take: 20 });
			for (const entry of pending) await this.deliver(entry);
		} finally { this.working = false; }
	}
}
