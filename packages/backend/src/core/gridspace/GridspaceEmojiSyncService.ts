/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { DataSource, IsNull, LessThan, MoreThan, Not } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiEmoji } from '@/models/Emoji.js';
import { MiGridspaceEmojiReceipt, MiGridspaceEmojiSync, MiGridspaceEmojiState } from '@/models/GridspaceEmojiSync.js';
import { DriveService } from '@/core/DriveService.js';
import { DownloadService } from '@/core/DownloadService.js';
import { FileInfoService } from '@/core/FileInfoService.js';
import { createTemp } from '@/misc/create-temp.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { EmojiEntityService } from '@/core/entities/EmojiEntityService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { IdService } from '@/core/IdService.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import { decideEmoji, emojiContent, emojiDigest, emojiReactionPair, sameEmoji } from './emoji-sync-protocol.js';
import type { EmojiApply, EmojiManifest, EmojiPeerRequest, EmojiReactionPairs, EmojiSyncRequest, SyncEmoji } from './emoji-sync-protocol.js';

const path = '/gridspace/v1/emojis';
const maxItems = 20_000;

@Injectable()
export class GridspaceEmojiSyncService implements OnModuleInit, OnApplicationShutdown {
	private timer: ReturnType<typeof setInterval> | undefined;
	private working = false;
	private cache: { stamp: string; at: number; value: EmojiManifest } | undefined;
	private remoteCache: EmojiManifest | undefined;
	private reactionPairsCache: { until: number; value: EmojiReactionPairs } | undefined;
	private reactionPairsPending: Promise<EmojiReactionPairs> | undefined;
	private aliasesCache: { until: number; value: Record<string, string> } | undefined;
	private aliasesPending: Promise<Record<string, string>> | undefined;
	private readonly origin: string;
	private readonly peerOrigin: string | null;
	private readonly leader: boolean;

	constructor(
		@Inject(DI.config) config: Config, @Inject(DI.db) private db: DataSource,
		private links: GridspaceLinkService, private drive: DriveService, private emojis: CustomEmojiService,
		private packer: EmojiEntityService, private events: GlobalEventService, private ids: IdService,
		private downloads: DownloadService, private files: FileInfoService,
	) {
		this.origin = new URL(config.url).origin;
		this.peerOrigin = config.gridspace?.enabled ? new URL(config.gridspace.peerUrl).origin : null;
		this.leader = this.peerOrigin != null && this.origin < this.peerOrigin;
	}

	public onModuleInit() {
		if (!this.leader) return;
		this.timer = setInterval(() => { void this.run().catch(() => {}); }, 30_000);
		this.timer.unref();
	}
	public onApplicationShutdown() { clearInterval(this.timer); }

	private describe(row: MiEmoji, hashes: Map<string, string>): SyncEmoji {
		const data = { id: row.id, name: row.name, originalUrl: row.originalUrl, imageHash: hashes.get(row.originalUrl) ?? null,
																	category: row.category, aliases: row.aliases, license: row.license, isSensitive: row.isSensitive,
																	localOnly: row.localOnly, restricted: row.roleIdsThatCanBeUsedThisEmojiAsReaction.length > 0 };
		return { ...data, hash: emojiDigest({ id: data.id, ...emojiContent(data), originalUrl: data.originalUrl }) };
	}

	public async manifest(force = false): Promise<EmojiManifest> {
		const [stamp] = await this.db.query<{ count: string; changed: string | null }[]>('SELECT count(*)::text AS count, max("updatedAt")::text AS changed FROM emoji WHERE host IS NULL');
		const key = JSON.stringify(stamp);
		if (!force && this.cache?.stamp === key && Date.now() - this.cache.at < 600_000) return this.cache.value;
		const rows = await this.db.getRepository(MiEmoji).find({ where: { host: IsNull() }, order: { id: 'ASC' }, take: maxItems + 1 });
		if (rows.length > maxItems) throw new GridspaceLinkError('EMOJI_LIMIT');
		const urls = rows.map(row => row.originalUrl);
		const files = urls.length ? await this.db.query<{ url: string; md5: string }[]>('SELECT url, md5 FROM drive_file WHERE url = ANY($1::varchar[])', [urls]) : [];
		const hashes = new Map(files.map(file => [file.url, file.md5]));
		const emojis = rows.map(row => this.describe(row, hashes));
		const value = { origin: this.origin, revision: emojiDigest(emojis.map(emoji => emoji.hash)), emojis };
		this.cache = { stamp: key, at: Date.now(), value };
		return value;
	}

	private async manifests() {
		const a = await this.manifest();
		const remote = await this.links.json<EmojiManifest>(path, { action: 'manifest', revision: this.remoteCache?.revision }, true, 32 * 1024 * 1024);
		if (remote.origin !== this.peerOrigin || !/^[a-f0-9]{64}$/.test(remote.revision)) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		if (remote.emojis) {
			if (remote.emojis.length > maxItems || remote.emojis.some(emoji => emoji.hash !== emojiDigest({ id: emoji.id, ...emojiContent(emoji), originalUrl: emoji.originalUrl }))) throw new GridspaceLinkError('PEER_UNAVAILABLE');
			this.remoteCache = remote;
		}
		if (!this.remoteCache?.emojis || this.remoteCache.revision !== remote.revision) throw new GridspaceLinkError('PEER_UNAVAILABLE');
		return [a.emojis!, this.remoteCache.emojis] as const;
	}

	private async lock<T>(action: () => Promise<T>): Promise<T | null> {
		const runner = this.db.createQueryRunner();
		await runner.connect();
		try {
			const rows = await runner.query('SELECT pg_try_advisory_lock(73161, 1) AS locked');
			const row = (rows as unknown as { locked: boolean }[])[0];
			if (!row.locked) return null;
			try { return await action(); } finally { await runner.query('SELECT pg_advisory_unlock(73161, 1)'); }
		} finally { await runner.release(); }
	}

	/** All changes are conditional on the target state observed by the coordinator. */
	public async apply(input: EmojiApply): Promise<SyncEmoji> {
		if (!this.peerOrigin || input.emoji.restricted) throw new GridspaceLinkError('ROLE_RESTRICTED');
		const receiptRepo = this.db.getRepository(MiGridspaceEmojiReceipt);
		const receipt = await receiptRepo.findOneBy({ id: input.operationId, peerOrigin: this.peerOrigin });
		const manifest = await this.manifest(true);
		if (receipt) {
			const current = manifest.emojis!.find(emoji => emoji.id === receipt.emojiId);
			if (current?.hash !== receipt.result.hash) throw new GridspaceLinkError('EMOJI_CONFLICT');
			return receipt.result;
		}
		const current = manifest.emojis!.find(emoji => emoji.id === input.targetId);
		if ((current?.hash ?? null) !== input.expected || (!!input.targetId && !current)) throw new GridspaceLinkError('EMOJI_CONFLICT');
		if (current?.restricted) throw new GridspaceLinkError('ROLE_RESTRICTED');
		const duplicate = manifest.emojis!.find(emoji => emoji.name === input.emoji.name && emoji.id !== input.targetId);
		if (duplicate) {
			throw new GridspaceLinkError('NAME_CONFLICT');
		}
		const url = new URL(input.emoji.originalUrl);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new GridspaceLinkError('IMAGE_UNAVAILABLE');
		const replaceImage = !current || (current.imageHash && input.emoji.imageHash ? current.imageHash !== input.emoji.imageHash : current.originalUrl !== input.emoji.originalUrl);
		const file = replaceImage ? await this.importImage(input.emoji) : null;
		const before = current ? await this.db.getRepository(MiEmoji).findOneBy({ id: current.id, host: IsNull() }) : null;
		const hashes = new Map(manifest.emojis!.filter(emoji => emoji.imageHash).map(emoji => [emoji.originalUrl, emoji.imageHash!]));
		if (file) hashes.set(file.url, file.md5);
		const result = await this.db.transaction(async manager => {
			const repo = manager.getRepository(MiEmoji);
			const row = input.targetId ? await repo.findOne({ where: { id: input.targetId, host: IsNull() }, lock: { mode: 'pessimistic_write' } }) : null;
			if ((row ? this.describe(row, hashes).hash : null) !== input.expected) throw new GridspaceLinkError('EMOJI_CONFLICT');
			if (await repo.exists({ where: { name: input.emoji.name, host: IsNull(), ...(row ? { id: Not(row.id) } : {}) } })) throw new GridspaceLinkError('NAME_CONFLICT');
			const data = { name: input.emoji.name, category: input.emoji.category, aliases: input.emoji.aliases, license: input.emoji.license,
																		isSensitive: input.emoji.isSensitive, localOnly: input.emoji.localOnly, updatedAt: new Date(),
																		...(file ? { originalUrl: file.url, publicUrl: file.webpublicUrl ?? file.url, type: file.webpublicType ?? file.type } : {}) };
			const saved = row ? Object.assign(row, data) : repo.create({ ...data, id: this.ids.gen(), host: null, uri: null, roleIdsThatCanBeUsedThisEmojiAsReaction: [] });
			await repo.save(saved);
			const packed = this.describe(saved, hashes);
			await manager.getRepository(MiGridspaceEmojiReceipt).insert({ id: input.operationId, peerOrigin: this.peerOrigin!, emojiId: saved.id, result: packed, createdAt: new Date() });
			return packed;
		});
		this.cache = undefined;
		await receiptRepo.delete({ createdAt: LessThan(new Date(Date.now() - 7 * 86400_000)) });
		this.emojis.localEmojisCache.refresh();
		if (before && before.name !== result.name) this.events.publishBroadcastStream('emojiDeleted', { emojis: [await this.packer.packDetailed(before)] });
		const packed = await this.packer.packDetailed(result.id);
		if (!before || before.name !== result.name) this.events.publishBroadcastStream('emojiAdded', { emoji: packed });
		else this.events.publishBroadcastStream('emojiUpdated', { emojis: [packed] });
		return result;
	}

	private async importImage(emoji: SyncEmoji) {
		const [temp, cleanup] = await createTemp();
		try {
			const { filename } = await this.downloads.downloadUrl(emoji.originalUrl, temp);
			const info = await this.files.getFileInfo(temp, { fileName: filename, skipSensitiveDetection: true });
			if (!info.type.mime.startsWith('image/') || (emoji.imageHash && info.md5 !== emoji.imageHash)) throw new GridspaceLinkError('IMAGE_CHANGED');
			return await this.drive.addFile({ user: null, path: temp, name: filename, force: false });
		} finally { cleanup(); }
	}

	private async transfer(source: SyncEmoji, target: SyncEmoji | undefined, toA: boolean, operationId: string) {
		const request: EmojiApply = { action: 'apply', operationId, emoji: source, targetId: target?.id ?? null, expected: target?.hash ?? null };
		const result = toA ? await this.apply(request) : await this.links.json<SyncEmoji>(path, request);
		if (!sameEmoji(source.imageHash ? source : { ...source, imageHash: result.imageHash }, result)) throw new GridspaceLinkError('EMOJI_CONFLICT');
		return result;
	}

	private rowVersion(row: MiGridspaceEmojiSync): string {
		// JSONB may reorder object keys. Only persisted, meaningful changes require a write.
		return JSON.stringify([row.aId, row.bId, row.hashA, row.hashB, row.a?.hash, row.b?.hash,
																									row.state, row.reason, row.attempts, row.retryAt.toISOString(), row.pending?.id]);
	}

	public async run(): Promise<void> {
		if (!this.leader || this.working) return;
		this.working = true;
		try {
			await this.lock(async () => {
				try {
					const [allA, allB] = await this.manifests();
					const mapA = new Map(allA.map(emoji => [emoji.id, emoji])), mapB = new Map(allB.map(emoji => [emoji.id, emoji]));
					const repo = this.db.getRepository(MiGridspaceEmojiSync);
					const rows = await repo.findBy({ peerOrigin: this.peerOrigin! });
					const existingIds = new Set(rows.map(row => row.id));
					const usedA = new Set(rows.map(row => row.aId)), usedB = new Set(rows.map(row => row.bId));
					const namesA = new Map(allA.map(emoji => [emoji.name, emoji])), namesB = new Map(allB.map(emoji => [emoji.name, emoji]));
					// Recover an add whose response or tracking write was lost before discovering new pairs.
					for (const row of rows) {
						if (row.aId && !row.bId) {
							const name = mapA.get(row.aId)?.name, found = name ? namesB.get(name) : undefined;
							if (found && !usedB.has(found.id)) { row.bId = found.id; usedB.add(found.id); }
						} else if (row.bId && !row.aId) {
							const name = mapB.get(row.bId)?.name, found = name ? namesA.get(name) : undefined;
							if (found && !usedA.has(found.id)) { row.aId = found.id; usedA.add(found.id); }
						}
					}
					for (const emoji of allA) {
						if (usedA.has(emoji.id)) continue;
						const candidate = namesB.get(emoji.name), b = candidate && !usedB.has(candidate.id) ? candidate : undefined;
						rows.push(this.newRow(emoji, b)); usedA.add(emoji.id); if (b) usedB.add(b.id);
					}
					for (const emoji of allB) if (!usedB.has(emoji.id)) rows.push(this.newRow(undefined, emoji));
					let budget = 8;
					const changed: MiGridspaceEmojiSync[] = [];
					for (const row of rows) {
						const a = row.aId ? mapA.get(row.aId) : undefined, b = row.bId ? mapB.get(row.bId) : undefined;
						const previous = this.rowVersion(row);
						const sourceChanged = (row.a?.hash ?? null) !== (a?.hash ?? null) || (row.b?.hash ?? null) !== (b?.hash ?? null);
						row.a = a ?? null; row.b = b ?? null;
						if (row.state !== 'ignored') {
							const decision = decideEmoji(a, b, row.hashA, row.hashB);
							if (decision === 'same' || decision === 'unchanged') { row.state = 'synced'; row.reason = null; row.hashA = a?.hash ?? null; row.hashB = b?.hash ?? null; row.pending = null; } else if (['conflict', 'removed', 'restricted'].includes(decision)) { row.state = 'conflict'; row.reason = decision.toUpperCase(); } else if (budget > 0 && (row.state !== 'conflict' || sourceChanged) && (row.state !== 'failed' || row.retryAt.getTime() <= Date.now() || sourceChanged)) {
								budget--;
								try { await this.syncRow(row, a, b, decision === 'toA'); } catch (error) {
									const reason = error instanceof GridspaceLinkError ? error.code : 'IMAGE_UNAVAILABLE';
									row.state = ['EMOJI_CONFLICT', 'NAME_CONFLICT', 'ROLE_RESTRICTED', 'IMAGE_CHANGED'].includes(reason) ? 'conflict' : 'failed';
									row.reason = reason; row.attempts++; row.retryAt = new Date(Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(row.attempts, 7)));
								}
							}
						}
						if (this.rowVersion(row) !== previous || !existingIds.has(row.id)) { row.updatedAt = new Date(); changed.push(row); }
					}
					if (changed.length) await repo.save(changed, { chunk: 100 });
					await this.db.getRepository(MiGridspaceEmojiReceipt).delete({ createdAt: LessThan(new Date(Date.now() - 7 * 86400_000)) });
					await this.db.getRepository(MiGridspaceEmojiState).upsert({ peerOrigin: this.peerOrigin!, checkedAt: new Date(), lastError: null }, ['peerOrigin']);
				} catch (error) {
					await this.db.getRepository(MiGridspaceEmojiState).upsert({ peerOrigin: this.peerOrigin!, checkedAt: new Date(), lastError: error instanceof GridspaceLinkError ? error.code : 'UNAVAILABLE' }, ['peerOrigin']);
					throw error;
				}
			});
		} catch { /* The persisted heartbeat reports outages; retry on the next tick. */ } finally { this.working = false; }
	}

	private newRow(a: SyncEmoji | undefined, b: SyncEmoji | undefined) {
		return this.db.getRepository(MiGridspaceEmojiSync).create({ id: randomUUID(), peerOrigin: this.peerOrigin!, aId: a?.id ?? null, bId: b?.id ?? null,
																																																														a: a ?? null, b: b ?? null, hashA: null, hashB: null, pending: null, state: 'pending', reason: null, attempts: 0, retryAt: new Date(), updatedAt: new Date() });
	}

	/** One shared refresh per server, never a manifest request for each note or viewer. */
	private async reactionPairs(): Promise<EmojiReactionPairs> {
		if (this.reactionPairsCache && this.reactionPairsCache.until > Date.now()) return this.reactionPairsCache.value;
		if (this.reactionPairsPending) return this.reactionPairsPending;
		this.reactionPairsPending = (async () => {
			let value: EmojiReactionPairs;
			if (this.leader) {
				const [a, b] = await this.manifests();
				const byA = new Map(a.map(emoji => [emoji.id, emoji]));
				const byB = new Map(b.map(emoji => [emoji.id, emoji]));
				const rows = await this.db.getRepository(MiGridspaceEmojiSync).findBy({ peerOrigin: this.peerOrigin!, state: 'synced' });
				value = { originA: this.origin, originB: this.peerOrigin, pairs: rows.flatMap(row => {
					const pair = emojiReactionPair(row, byA.get(row.aId!), byB.get(row.bId!));
					return pair ? [pair] : [];
				}) };
			} else {
				value = await this.links.json<EmojiReactionPairs>(path, { action: 'reaction-aliases' }, true, 8 * 1024 * 1024);
				if (value.originA !== this.peerOrigin || value.originB !== this.origin || !Array.isArray(value.pairs) || value.pairs.length > maxItems) throw new GridspaceLinkError('PEER_UNAVAILABLE');
			}
			this.reactionPairsCache = { until: Date.now() + 30_000, value };
			return value;
		})();
		try { return await this.reactionPairsPending; } catch {
			const value = { originA: this.leader ? this.origin : this.peerOrigin!, originB: this.leader ? this.peerOrigin : this.origin, pairs: [] };
			this.reactionPairsCache = { until: Date.now() + 5_000, value };
			return value;
		} finally { this.reactionPairsPending = undefined; }
	}

	public async reactionAliases(): Promise<Record<string, string>> {
		if (!this.peerOrigin) return {};
		if (this.aliasesCache && this.aliasesCache.until > Date.now()) return this.aliasesCache.value;
		if (this.aliasesPending) return this.aliasesPending;
		this.aliasesPending = (async () => {
			try {
				const [result, local] = await Promise.all([this.reactionPairs(), this.manifest()]);
				const byId = new Map(local.emojis!.map(emoji => [emoji.id, emoji]));
				const host = new URL(this.peerOrigin!).host;
				const value = Object.fromEntries(result.pairs.flatMap(pair => {
					const emoji = byId.get(this.leader ? pair.aId : pair.bId);
					if (!emoji || emoji.restricted || emoji.name !== pair.name || emoji.hash !== (this.leader ? pair.aHash : pair.bHash)) return [];
					return [[`:${pair.name}@${host}:`, `:${pair.name}@.:`]];
				}));
				this.aliasesCache = { until: Math.min(Date.now() + 30_000, this.reactionPairsCache!.until), value };
				return value;
			} catch {
				this.aliasesCache = { until: Date.now() + 5_000, value: {} };
				return {}; // A sync outage must not stop notes or ordinary reactions.
			}
		})();
		try { return await this.aliasesPending; } finally { this.aliasesPending = undefined; }
	}
	private async syncRow(row: MiGridspaceEmojiSync, a: SyncEmoji | undefined, b: SyncEmoji | undefined, toA: boolean) {
		const source = toA ? b : a;
		if (!source) throw new GridspaceLinkError('DELETE_REQUIRES_MANUAL');
		const target = toA ? a : b;
		if (!row.pending || row.pending.toA !== toA || row.pending.sourceHash !== source.hash || row.pending.targetHash !== (target?.hash ?? null)) {
			row.pending = { id: emojiDigest(randomUUID()), sourceHash: source.hash, targetHash: target?.hash ?? null, toA };
		}
		// Persist the operation identity before the peer can mutate anything.
		await this.db.getRepository(MiGridspaceEmojiSync).save(row);
		const result = await this.transfer(source, target, toA, row.pending.id);
		row.a = toA ? result : a!; row.b = toA ? b! : result;
		row.aId = row.a.id; row.bId = row.b.id; row.hashA = row.a.hash; row.hashB = row.b.hash;
		row.state = 'synced'; row.reason = null; row.attempts = 0; row.pending = null;
	}

	public async admin(input: EmojiSyncRequest) {
		if (!this.peerOrigin) return this.status();
		if (!this.leader) return this.links.json<Awaited<ReturnType<GridspaceEmojiSyncService['status']>>>(path, input);
		if (input.action === 'status') return this.status(input.after);
		if (input.action === 'retry') {
			await this.db.getRepository(MiGridspaceEmojiSync).update({ peerOrigin: this.peerOrigin, state: 'failed' }, { state: 'pending', retryAt: new Date() });
			await this.run(); return this.status();
		}
		if (!input.id || input.expectedA === undefined || input.expectedB === undefined) throw new GridspaceLinkError('INVALID_REQUEST');
		const result = await this.lock(async () => {
			const row = await this.db.getRepository(MiGridspaceEmojiSync).findOneBy({ id: input.id!, peerOrigin: this.peerOrigin! });
			if (!row) throw new GridspaceLinkError('EMOJI_CONFLICT');
			const [allA, allB] = await this.manifests();
			const a = allA.find(emoji => emoji.id === row.aId), b = allB.find(emoji => emoji.id === row.bId);
			if ((a?.hash ?? null) !== input.expectedA || (b?.hash ?? null) !== input.expectedB) throw new GridspaceLinkError('EMOJI_CONFLICT');
			if (input.action === 'ignore') { row.state = 'ignored'; row.pending = null; } else if (input.action === 'resume') { row.state = 'pending'; row.retryAt = new Date(); } else await this.syncRow(row, a, b, input.action === 'preferB');
			row.updatedAt = new Date(); await this.db.getRepository(MiGridspaceEmojiSync).save(row);
			return true;
		});
		if (!result) throw new GridspaceLinkError('BUSY');
		return this.status();
	}

	private async status(after?: string) {
		const repo = this.db.getRepository(MiGridspaceEmojiSync);
		const rows = this.peerOrigin ? await repo.find({ where: { peerOrigin: this.peerOrigin, state: Not('synced'), ...(after ? { id: MoreThan(after) } : {}) }, order: { id: 'ASC' }, take: 51 }) : [];
		const counts = { pending: 0, synced: 0, conflict: 0, failed: 0, ignored: 0 };
		const heartbeat = this.peerOrigin ? await this.db.getRepository(MiGridspaceEmojiState).findOneBy({ peerOrigin: this.peerOrigin }) : null;
		const grouped = this.peerOrigin ? await this.db.query<{ state: keyof typeof counts; count: string }[]>('SELECT state, count(*)::text AS count FROM gridspace_emoji_sync WHERE "peerOrigin" = $1 GROUP BY state', [this.peerOrigin]) : [];
		for (const row of grouped) counts[row.state] = Number(row.count);
		return { enabled: this.peerOrigin !== null, originA: this.origin, originB: this.peerOrigin, checkedAt: heartbeat?.checkedAt.toISOString() ?? null, lastError: heartbeat?.lastError ?? null,
											counts, next: rows.length > 50 ? rows[49].id : null, items: rows.slice(0, 50).map(row => ({ id: row.id, state: row.state, reason: row.reason, a: row.a, b: row.b, attempts: row.attempts, retryAt: row.retryAt.toISOString() })) };
	}
	public async peer(input: EmojiPeerRequest): Promise<object> {
		if (!this.peerOrigin) throw new GridspaceLinkError('DISABLED');
		if (input.action === 'reaction-aliases') {
			if (!this.leader) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			return this.reactionPairs();
		}
		if (input.action === 'manifest') {
			const manifest = await this.manifest();
			return input.revision === manifest.revision ? { origin: manifest.origin, revision: manifest.revision } : manifest;
		}
		if (input.action === 'apply') {
			if (this.leader) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			return this.apply(input);
		}
		if (!this.leader) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		return this.admin(input);
	}
}
