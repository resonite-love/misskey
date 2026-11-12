/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { DataSource, In, LessThanOrEqual, type EntityManager } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiNote } from '@/models/Note.js';
import { MiGridspaceReactionDelivery } from '@/models/Gridspace.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { resolveGridspaceConfig, GRIDSPACE_PROTOCOL_VERSION, type GridspacePeerConfig } from './peer-protocol.js';
import { gridspaceNoteId } from './note-protocol.js';
import { supportsGridspaceReactions, type ReactionUpdate } from './reaction-protocol.js';
import { requestGridspacePeer } from './peer-client.js';

/** A transactional, coalescing outbox. Notifications carry no reaction or note content. */
@Injectable()
export class GridspaceReactionDeliveryService implements OnModuleInit, OnApplicationShutdown {
	private readonly peer: GridspacePeerConfig | null;
	private timer: ReturnType<typeof setInterval> | undefined;
	private working = false;
	private capability: { expires: number; value: Promise<boolean> } | undefined;

	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.config) config: Config,
		private events: GlobalEventService,
	) { this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env); }

	public onModuleInit(): void {
		if (!this.peer) return;
		this.timer = setInterval(() => { void this.flush(); }, 3000);
		this.timer.unref();
	}

	public onApplicationShutdown(): void { clearInterval(this.timer); }

	public async mutate<T>(note: MiNote, write: (manager: EntityManager) => Promise<T>): Promise<T> {
		if (!supportsGridspaceReactions(note, this.peer)) return write(this.db.manager);
		return this.db.transaction(async manager => {
			const result = await write(manager);
			await manager.upsert(MiGridspaceReactionDelivery, {
				noteId: note.id, peerOrigin: this.peer!.peerOrigin, version: randomUUID(), retryAt: new Date(), attempts: 0,
			}, ['noteId']);
			return result;
		});
	}

	/** Old peers retain polling during rolling upgrades. Never advertise an unverified capability. */
	public supportsPush(): Promise<boolean> {
		if (!this.peer) return Promise.resolve(false);
		if (!this.capability || this.capability.expires <= Date.now()) {
			const value = requestGridspacePeer(this.peer, '/gridspace/v1/handshake', { protocolVersion: GRIDSPACE_PROTOCOL_VERSION }, 16384, Date.now() + 3000)
				.then(result => !!result && typeof result === 'object' && 'features' in result && Array.isArray(result.features) && result.features.includes('community-reaction-updates'))
				.catch(() => false);
			this.capability = { expires: Date.now() + 60000, value };
		}
		return this.capability.value;
	}

	public async flush(): Promise<void> {
		if (!this.peer || this.working) return;
		this.working = true;
		const runner = this.db.createQueryRunner();
		const lock = `gridspace-reaction-delivery:${this.peer.peerOrigin}`;
		let locked = false;
		try {
			await runner.connect();
			locked = (await runner.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [lock]))[0].locked;
			if (!locked) return;
			const queue = this.db.getRepository(MiGridspaceReactionDelivery);
			const pending = await queue.find({ where: { peerOrigin: this.peer.peerOrigin, retryAt: LessThanOrEqual(new Date()) }, order: { retryAt: 'ASC' }, take: 100 });
			if (!pending.length) return;
			const notes = await this.db.getRepository(MiNote).findBy({ id: In(pending.map(item => item.noteId)) });
			const uris = notes.filter(note => supportsGridspaceReactions(note, this.peer)).map(note => note.uri ?? `${this.peer!.origin}/notes/${note.id}`);
			try {
				if (uris.length) {
					const result = await requestGridspacePeer(this.peer, '/gridspace/v1/reactions/updated', { uris }, 4096, Date.now() + 5000);
					if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) throw new Error('Invalid acknowledgement');
				}
				// An update committed during delivery has a different version and remains queued.
				await queue.delete(pending.map(item => ({ noteId: item.noteId, version: item.version })));
			} catch {
				for (const item of pending) await queue.update({ noteId: item.noteId, version: item.version }, {
					attempts: item.attempts + 1, retryAt: new Date(Date.now() + Math.min(300000, 3000 * 2 ** Math.min(item.attempts, 7))),
				});
			}
		} catch { /* A database outage leaves the outbox intact for the next tick. */ } finally {
			try {
				if (locked) await runner.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]);
			} catch { /* A disconnected session also releases its lock. */ } finally {
				await runner.release().catch(() => {});
				this.working = false;
			}
		}
	}

	public async receive(input: ReactionUpdate): Promise<{ ok: true }> {
		if (!this.peer) throw new Error('GridSpace disabled');
		const ids: string[] = []; const uris: string[] = [];
		for (const uri of input.uris) {
			const origin = [this.peer.origin, this.peer.peerOrigin].find(origin => uri.startsWith(`${origin}/notes/`));
			if (!origin || !gridspaceNoteId(uri.slice(`${origin}/notes/`.length))) throw new Error('Invalid note origin');
			if (origin === this.peer.origin) ids.push(uri.slice(`${origin}/notes/`.length)); else uris.push(uri);
		}
		const notes = await this.db.getRepository(MiNote).findBy([{ id: In(ids) }, { uri: In(uris) }]);
		for (const note of notes) {
			if (supportsGridspaceReactions(note, this.peer)) await this.events.publishNoteStream(note, 'extendedReactionUpdated', {});
		}
		// Unknown notes are not imported. Their first read fetches the current state.
		// Replayed/out-of-order updates only trigger a fresh read, never apply old counts.
		return { ok: true };
	}
}
