/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { DataSource, LessThanOrEqual } from 'typeorm';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiNote } from '@/models/Note.js';
import { MiUser } from '@/models/User.js';
import { MiGridspaceNoteDelivery, MiGridspaceNoteTombstone } from '@/models/Gridspace.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { ApNoteService } from '@/core/activitypub/models/ApNoteService.js';
import { ApResolverService } from '@/core/activitypub/ApResolverService.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { acquireApObjectLock } from '@/misc/distributed-lock.js';
import { resolveGridspaceConfig, type GridspacePeerConfig } from './peer-protocol.js';
import { requestGridspacePeer } from './peer-client.js';
import { canShareGridspaceNote, canonicalGridspaceNoteUri, gridspaceNoteUris, gridspaceNoteId, GRIDSPACE_NOTE_BODY_LIMIT, GRIDSPACE_NOTE_PATH, validateGridspaceBundle, type GridspaceNoteBundle } from './note-protocol.js';

@Injectable()
export class GridspaceNoteService implements OnModuleInit, OnApplicationShutdown {
	private peer: GridspacePeerConfig | null;
	private timer: ReturnType<typeof setInterval> | undefined;
	private working = false;

	constructor(
		@Inject(DI.config) private config: Config,
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.redis) private redis: Redis.Redis,
		private renderer: ApRendererService,
		private apNotes: ApNoteService,
		private resolvers: ApResolverService,
		private create: NoteCreateService,
		private remove: NoteDeleteService,
		private packer: NoteEntityService,
		private events: GlobalEventService,
	) { this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env); }

	public onModuleInit(): void {
		if (!this.peer) return;
		this.timer = setInterval(() => { void this.work(); }, 3000);
		this.timer.unref();
	}

	public onApplicationShutdown(): void { clearInterval(this.timer); }

	private async request(action: string, noteId: string, deadline?: number): Promise<unknown> {
		if (!this.peer) throw new Error('GridSpace disabled');
		return requestGridspacePeer(this.peer, GRIDSPACE_NOTE_PATH + action, { noteId }, GRIDSPACE_NOTE_BODY_LIMIT, deadline);
	}

	private async work(): Promise<void> {
		if (!this.peer || this.working) return;
		this.working = true;
		try {
			const queue = this.db.getRepository(MiGridspaceNoteDelivery);
			const pending = await queue.find({ where: { peerOrigin: this.peer.peerOrigin, retryAt: LessThanOrEqual(new Date()) }, order: { retryAt: 'ASC' }, take: 30 });
			for (const item of pending) {
				try {
					await this.request('sync', item.noteId);
					// A concurrent delete replaces the version and must stay queued.
					await queue.delete({ noteId: item.noteId, version: item.version });
				} catch {
					await queue.update({ noteId: item.noteId, version: item.version }, {
						attempts: item.attempts + 1, retryAt: new Date(Date.now() + Math.min(300000, 3000 * 2 ** Math.min(item.attempts, 7))),
					});
				}
			}
		} catch {
			// Database outages leave durable work for the next tick.
		} finally { this.working = false; }
	}

	/** Read one current object. References are imported only when the peer lacks them. */
	public async read(noteId: string): Promise<GridspaceNoteBundle> {
		if (!this.peer) throw new Error('GridSpace disabled');
		const note = await this.db.transaction(async manager => {
			const current = await manager.findOne(MiNote, { where: { id: noteId }, lock: { mode: 'pessimistic_write' } });
			if (!current || current.userHost != null || !canShareGridspaceNote(current)) return null;
			const user = await manager.findOneBy(MiUser, { id: current.userId });
			if (!user || user.isSuspended || user.isDeleted) return null;
			await manager.update(MiNote, current.id, { gridspaceShared: true });
			return current;
		});
		if (!note) return { deleted: true, notes: [] };
		const result = { deleted: false, notes: [{ object: await this.renderer.renderNote(note, false), localOnly: note.localOnly, reactionAcceptance: note.reactionAcceptance }] };
		if (Buffer.byteLength(JSON.stringify(result)) > GRIDSPACE_NOTE_BODY_LIMIT) throw new Error('Note too large');
		return result;
	}

	/** Notifications contain only IDs; all content is pulled over the signed peer channel. */
	public async sync(noteId: string): Promise<object> {
		await this.importNote(noteId, new Set(), true);
		return { ok: true };
	}

	public async historyNote(noteId: string, budget: { remaining: number; deadline: number }): Promise<MiNote | null> {
		if (!this.peer) throw new Error('GridSpace disabled');
		await this.importNote(noteId, new Set(), false, budget);
		return this.apNotes.fetchNote(`${this.peer.peerOrigin}/notes/${noteId}`);
	}

	private async importNote(noteId: string, visiting: Set<string>, live: boolean, budget?: { remaining: number; deadline: number }): Promise<boolean> {
		if (!this.peer) throw new Error('GridSpace disabled');
		if (budget && (--budget.remaining < 0 || Date.now() > budget.deadline)) throw new Error('History import budget exceeded');
		const uri = `${this.peer.peerOrigin}/notes/${noteId}`;
		if (visiting.has(uri)) throw new Error('Cyclic note references');
		visiting.add(uri);
		const bundle = validateGridspaceBundle(await this.request('read', noteId, budget?.deadline), this.peer.peerOrigin, noteId);
		const entry = bundle.notes[0];
		const resolver = budget ? await this.resolvers.createResolver() : undefined;
		if (resolver) resolver.historyBudget = budget;
		// Resolve missing peer references before taking the root lock. Known parents stop the walk,
		// so each new reply in a long thread costs only one read. Deleted parents do not hide replies.
		if (!bundle.deleted) {
			for (const field of ['inReplyTo', '_misskey_quote', 'quoteUrl'] as const) {
				const value = entry.object[field];
				if (typeof value !== 'string') continue;
				const ref = canonicalGridspaceNoteUri(value, this.peer.peerOrigin);
				entry.object[field] = ref;
				if (await this.apNotes.fetchNote(ref)) continue;
				if (ref.startsWith(this.peer.peerOrigin + '/notes/')) {
					const id = ref.slice((this.peer.peerOrigin + '/notes/').length);
					if (!gridspaceNoteId(id)) throw new Error('Invalid note reference');
					if (!await this.importNote(id, visiting, false, budget)) delete entry.object[field];
				} else if (ref.startsWith(this.peer.origin + '/notes/')) {
					delete entry.object[field];
				} else if (resolver) {
					// Resolve genuine external references within the same budget before taking the root lock.
					// Failure leaves the root unimported so a retry can preserve the original relationship.
					await this.apNotes.resolveNote(ref, { resolver });
				}
			}
		}
		const unlock = await acquireApObjectLock(this.redis, uri);
		try {
			if (bundle.deleted) {
				await this.db.transaction(async manager => {
					await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['gridspace-note:' + uri]);
					await manager.upsert(MiGridspaceNoteTombstone, { uri }, ['uri']);
				});
				const existing = await this.apNotes.fetchNote(uri);
				if (existing) await this.remove.delete(await this.db.getRepository(MiUser).findOneByOrFail({ id: existing.userId }), existing);
				return false;
			}
			if (await this.db.getRepository(MiGridspaceNoteTombstone).existsBy(gridspaceNoteUris(uri, this.peer.peerOrigin).map(uri => ({ uri })))) return false;
			const existing = await this.apNotes.fetchNote(uri);
			if (existing) {
				if (!existing.gridspaceShared) {
					await this.db.getRepository(MiNote).update(existing.id, { gridspaceShared: true, localOnly: existing.localOnly || entry.localOnly });
					existing.gridspaceShared = true;
					existing.localOnly ||= entry.localOnly;
					await this.create.pushToTl(existing, { id: existing.userId, host: existing.userHost });
					if (live) this.events.publishNotesStream(await this.packer.pack(existing, undefined, { skipHide: true }));
				}
				return true;
			}
			await this.apNotes.createNote(entry.object, undefined, resolver, !live, { ...entry, historical: !live });
			return true;
		} finally { visiting.delete(uri); await unlock(); }
	}
}
