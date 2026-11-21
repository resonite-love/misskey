/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DataSource, LessThanOrEqual } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiNote } from '@/models/Note.js';
import { MiUser } from '@/models/User.js';
import { MiGridspaceReactionNotification } from '@/models/Gridspace.js';
import { NotificationService } from '@/core/NotificationService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { GridspaceSearchService } from './GridspaceSearchService.js';
import { resolveGridspaceConfig, type GridspacePeerConfig } from './peer-protocol.js';
import { requestGridspacePeer } from './peer-client.js';
import { includesDefault } from '@/misc/note-distribution.js';
import { canonicalReaction, localReaction, type ReactionNotification } from './reaction-protocol.js';

const maxAge = 24 * 60 * 60 * 1000;

@Injectable()
export class GridspaceReactionNotificationService implements OnModuleInit, OnApplicationShutdown {
	private readonly peer: GridspacePeerConfig | null;
	private timer: ReturnType<typeof setInterval> | undefined;
	private working = false;

	constructor(@Inject(DI.db) private db: DataSource, @Inject(DI.config) config: Config, private modules: ModuleRef) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
	}

	public onModuleInit(): void {
		if (!this.peer) return;
		this.timer = setInterval(() => { void this.flush(); }, 3000);
		this.timer.unref();
	}

	public onApplicationShutdown(): void { clearInterval(this.timer); }

	public async flush(): Promise<void> {
		if (!this.peer || this.working) return;
		this.working = true;
		const runner = this.db.createQueryRunner();
		const lock = `gridspace-reaction-notifications:${this.peer.peerOrigin}`;
		let locked = false;
		try {
			await runner.connect();
			locked = (await runner.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [lock]))[0].locked;
			if (!locked) return;
			const queue = this.db.getRepository(MiGridspaceReactionNotification);
			const pending = await queue.find({ where: { retryAt: LessThanOrEqual(new Date()) }, order: { retryAt: 'ASC' }, take: 50 });
			for (const item of pending) {
				try {
					const note = await this.db.getRepository(MiNote).findOneBy({ id: item.noteId });
					// A deletion/cancellation before delivery must not produce a stale notification.
					const active = await this.db.query(`SELECT 1 FROM note_reaction WHERE id=$1 AND "noteId"=$2 AND "userId"=$3 AND reaction=$4
						UNION ALL SELECT 1 FROM extended_note_reaction WHERE id=$1 AND "noteId"=$2 AND "userId"=$3 AND reaction=$4`, [item.reactionId, item.noteId, item.notifierId, item.reaction]);
					if (Date.now() - item.createdAt.getTime() > maxAge || !active.length || !note?.localOnly || note.channelId !== null || !includesDefault(note) ||
						note.userHost !== new URL(this.peer.peerOrigin).host || !note.uri?.startsWith(`${this.peer.peerOrigin}/notes/`)) {
						await queue.delete(item.reactionId);
						continue;
					}
					const result = await requestGridspacePeer(this.peer, '/gridspace/v1/reactions/notify', {
						reactionId: item.reactionId, noteId: note.uri.slice(`${this.peer.peerOrigin}/notes/`.length),
						actorId: item.notifierId, reaction: canonicalReaction(item.reaction, this.peer.origin), createdAt: item.createdAt.getTime(),
					}, 4096, Date.now() + 5000);
					if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) throw new Error('Invalid acknowledgement');
					await queue.delete(item.reactionId);
				} catch {
					await queue.update(item.reactionId, { attempts: item.attempts + 1, retryAt: new Date(Date.now() + Math.min(300000, 3000 * 2 ** Math.min(item.attempts, 7))) });
				}
			}
		} catch { /* A database outage leaves the queue intact. */ } finally {
			try { if (locked) await runner.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]); } catch { /* Session loss releases the lock. */ }
			await runner.release().catch(() => {});
			this.working = false;
		}
	}

	/** Only the authenticated peer may name its local actor; no arbitrary actor URL is accepted. */
	public async receive(input: ReactionNotification): Promise<{ ok: true }> {
		if (!this.peer) throw new Error('GridSpace disabled');
		if (Date.now() - input.createdAt > maxAge || input.createdAt > Date.now() + 60000) return { ok: true };
		const note = await this.db.getRepository(MiNote).findOneBy({ id: input.noteId });
		if (!note || note.userHost !== null || !note.localOnly || note.channelId !== null || !includesDefault(note)) return { ok: true };
		const actorUri = `${this.peer.peerOrigin}/users/${input.actorId}`;
		const users = this.db.getRepository(MiUser);
		const actor = await users.findOneBy({ uri: actorUri }) ?? await this.modules.get(ApPersonService).resolvePerson(actorUri);
		if (actor.uri !== actorUri || actor.host !== new URL(this.peer.peerOrigin).host || actor.isDeleted || actor.isSuspended) return { ok: true };
		const search = this.modules.get(GridspaceSearchService);
		const visible = await search.read(search.noteQuery(actor, { query: '' }, false, true).andWhere('note.id = :reactionNote', { reactionNote: note.id }));
		if (!visible.length) return { ok: true };
		const receipt = createHash('sha256').update(`${this.peer.peerOrigin}\n${input.reactionId}`).digest('hex');
		await this.modules.get(NotificationService).createReactionNotificationOnce(note, localReaction(input.reaction, this.peer.origin), actor.id, receipt);
		return { ok: true };
	}
}
