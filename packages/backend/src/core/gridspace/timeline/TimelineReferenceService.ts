/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { In, type DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { MiNote } from '@/models/Note.js';
import { MiGridspaceTimelineOutbox, MiGridspaceTimelineChange, MiGridspaceTimelineState } from '@/models/GridspaceTimeline.js';
import { canonicalGridspaceNoteUri } from '../note-protocol.js';

export type TimelinePosition = { sortAt: string; canonicalUri: string };
export type TimelineReference = TimelinePosition & { noteId: string; normalized: boolean; generation: number };
export type TimelineChange = { sequence: string; canonicalUri: string | null; noteId: string | null; kind: string; affectedUserId: string | null; createdAt: Date };

export function timelineMicroseconds(date: Date): string {
	const time = date.getTime();
	if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid timeline timestamp');
	return (BigInt(time) * 1000n).toString();
}

export function validTimelinePosition(position: TimelinePosition): boolean {
	return /^(0|[1-9]\d{0,18})$/.test(position.sortAt) && BigInt(position.sortAt) <= 9223372036854775807n &&
		position.canonicalUri.length <= 1024 && /^https?:\/\//.test(position.canonicalUri) && !/[\u0000-\u0020\u007f]/.test(position.canonicalUri);
}

@Injectable()
export class TimelineReferenceService implements OnModuleInit, OnApplicationShutdown {
	private timer: ReturnType<typeof setInterval> | undefined;
	private maintaining = false;

	constructor(
		@Inject(DI.db) private readonly db: DataSource,
		@Inject(DI.config) private readonly config: Config,
		private readonly ids: IdService,
		private readonly events: GlobalEventService,
	) {}

	public onModuleInit(): void {
		if (process.env.NODE_ENV === 'test') return;
		// Maintenance only moves content-free committed events; it does not scan
		// notes, call the peer or poll any user's timeline.
		this.timer = setInterval(() => { void this.maintain(); }, 60_000);
		this.timer.unref();
	}

	public onApplicationShutdown(): void { clearInterval(this.timer); }

	private async maintain(): Promise<void> {
		if (this.maintaining) return;
		this.maintaining = true;
		try {
			await this.drainChanges();
			await this.pruneChanges();
		} catch {
			// A failed DB transaction preserves the outbox for the next request or tick.
		} finally { this.maintaining = false; }
	}

	/** Existing notes only; callers must independently authorize these references. */
	public async getMany(noteIds: string[]): Promise<TimelineReference[]> {
		if (noteIds.length > 512) throw new Error('Too many timeline references');
		if (noteIds.length === 0) return [];
		const notes = await this.db.getRepository(MiNote).find({ where: { id: In(noteIds) }, select: { id: true, uri: true } });
		return notes.map(note => ({ noteId: note.id,
			canonicalUri: canonicalGridspaceNoteUri(note.uri ?? `${this.config.url}/notes/${note.id}`, this.config.gridspace?.peerUrl),
			sortAt: timelineMicroseconds(this.ids.parse(note.id).date), normalized: true, generation: 1 }));
	}

	public async status(): Promise<{ generation: number; currentSequence: string }> {
		const state = await this.db.getRepository(MiGridspaceTimelineState).findOneByOrFail({ key: 'changes' });
		return { generation: state.generation, currentSequence: state.nextSequence };
	}

	/** Sequence only committed outbox rows, under one short transaction-wide lock. */
	public async drainChanges(limit = 1000): Promise<string> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid change batch size');
		let changed = false;
		const result = await this.db.transaction(async manager => {
			const state = await manager.getRepository(MiGridspaceTimelineState).findOneOrFail({ where: { key: 'changes' }, lock: { mode: 'pessimistic_write' } });
			const pending = await manager.getRepository(MiGridspaceTimelineOutbox).createQueryBuilder('event').orderBy('event.createdAt', 'ASC').addOrderBy('event.id', 'ASC').limit(limit).setLock('pessimistic_write').getMany();
			let sequence = BigInt(state.nextSequence);
			if (pending.length) {
				changed = true;
				const createdAt = new Date();
				await manager.getRepository(MiGridspaceTimelineChange).insert(pending.map(event => ({
					sequence: (++sequence).toString(), canonicalUri: event.canonicalUri ?? (event.noteId ? `${this.config.url}/notes/${event.noteId}` : null),
					noteId: event.noteId, kind: event.kind, affectedUserId: event.affectedUserId, createdAt,
				})));
				await manager.getRepository(MiGridspaceTimelineOutbox).delete(pending.map(event => event.id));
				await manager.getRepository(MiGridspaceTimelineState).update({ key: 'changes' }, { nextSequence: sequence.toString() });
			}
			return sequence.toString();
		});
		// Publish after the sequenced rows commit. Redis never receives a private
		// reference or body, and a lost signal is recovered by the HTTP cursor.
		if (changed) this.events.publishInternalEvent('gridspaceTimelineChanged', { sequence: result });
		return result;
	}

	public async currentPosition(): Promise<string> { return this.drainChanges(); }

	public async changes(after: string, limit = 100): Promise<{ events: TimelineChange[]; cursor: string; resetRequired: boolean; hasMore: boolean }> {
		if (!/^(0|[1-9]\d{0,18})$/.test(after) || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid change cursor');
		const head = await this.drainChanges();
		const state = await this.db.getRepository(MiGridspaceTimelineState).findOneByOrFail({ key: 'changes' });
		const resetRequired = BigInt(after) > BigInt(head) || BigInt(after) < BigInt(state.trimmedThrough);
		if (resetRequired) return { events: [], cursor: head, resetRequired: true, hasMore: false };
		const events = await this.db.getRepository(MiGridspaceTimelineChange).createQueryBuilder('event').where('event.sequence > :after::bigint', { after }).andWhere('event.sequence <= :head::bigint', { head }).orderBy('event.sequence', 'ASC').limit(limit + 1).getMany();
		const hasMore = events.length > limit;
		if (hasMore) events.pop();
		return { events, cursor: hasMore ? events.at(-1)!.sequence : head, resetRequired: false, hasMore };
	}

	public async pruneChanges(): Promise<void> {
		await this.db.transaction(async manager => {
			await manager.getRepository(MiGridspaceTimelineState).findOneOrFail({ where: { key: 'changes' }, lock: { mode: 'pessimistic_write' } });
			// Sequence time is commit order. Remove only a contiguous prefix and retain
			// its boundary even when every change row expires.
			await manager.query(`WITH expired AS (DELETE FROM "gridspace_timeline_change" WHERE "sequence" IN (SELECT "sequence" FROM "gridspace_timeline_change" WHERE "createdAt" < now() - interval '24 hours' AND "sequence" < COALESCE((SELECT min("sequence") FROM "gridspace_timeline_change" WHERE "createdAt" >= now() - interval '24 hours'), 9223372036854775807) ORDER BY "sequence" LIMIT 10000) RETURNING "sequence") UPDATE "gridspace_timeline_state" SET "trimmedThrough" = GREATEST("trimmedThrough", COALESCE((SELECT max("sequence") FROM expired), 0)) WHERE "key" = 'changes'`);
		});
	}
}
