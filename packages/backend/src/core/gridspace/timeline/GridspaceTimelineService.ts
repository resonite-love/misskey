/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import { GridspacePrivateService } from '../GridspacePrivateService.js';
import { GridspaceLinkError } from '../GridspaceLinkService.js';
import { sealGridspaceSecret, openGridspaceSecret } from '../link-crypto.js';
import { resolveGridspaceConfig, type GridspacePeerConfig } from '../peer-protocol.js';
import { canonicalGridspaceNoteUri } from '../note-protocol.js';
import { GridspaceNoteService } from '../GridspaceNoteService.js';
import { TimelineFavoriteSource, type FavoriteReference } from './TimelineFavoriteSource.js';
import type { TimelineListOptions } from './GridspaceTimelineListSourceService.js';
import { TimelineReferenceService } from './TimelineReferenceService.js';
import { TimelineLocalSource } from './TimelineLocalSource.js';
import { TimelineSessionStore } from './TimelineSessionStore.js';
import { GridspaceTimelineListSourceService } from './GridspaceTimelineListSourceService.js';
import type { TimelineLocalOptions } from './TimelineLocalSource.js';
import { emptyTimelineMerge, mergeTimeline, type TimelineMergeState } from './TimelineMergeService.js';
import { TIMELINE_AUTHORIZATION_TTL_MS, TIMELINE_REVALIDATE_MS, compareTimelinePosition, type TimelineItem, type TimelineOptions, type TimelinePage, type TimelinePosition, type TimelineReference, type TimelineSourceState } from './timeline-protocol.js';

type Checkpoint = {
	options: TimelineOptions; mode: 'unified' | 'local-fallback'; revision: string; expires: number; session: string;
	viewerId?: string;
	merge: TimelineMergeState; selected?: TimelineReference[]; nextId?: string | null; sequence: string; peerSequence?: string;
	untilAt?: number;
	fromAt?: number;
	windowHead?: TimelineReference;
	nextPolicyCheckAt?: number | null;
	checkedThrough?: string;
};
type Cursor = { session: string; id: string; expires: number };
export type TimelineStreamEvent = { source: 'local' | 'peer'; noteId: string };
export type TimelineStreamResult = { session: string; revision: string; item?: TimelineItem; resetRequired: boolean };

@Injectable()
export class GridspaceTimelineService {
	private readonly peer: GridspacePeerConfig | null;
	private readonly enabled: boolean;
	constructor(
		@Inject(DI.config) config: Config,
		private sessions: TimelineSessionStore,
		private local: TimelineLocalSource,
		private references: TimelineReferenceService,
		private delegated: GridspacePrivateService,
		private lists?: GridspaceTimelineListSourceService,
		private favorites?: TimelineFavoriteSource,
		private sharedNotes?: GridspaceNoteService,
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
		this.enabled = config.gridspace?.timelineEnabled === true;
	}

	public async capability() {
		if (!this.peer) return { version: 1, enabled: false, kinds: ['home', 'social'] };
		return { version: 1, enabled: this.enabled, kinds: ['home', 'social', 'profile', 'search', 'mentions', 'direct', 'favorites', 'channel', 'antenna', 'clip'] };
	}

	private localSource(options: TimelineOptions) {
		if (options.kind === 'home' || options.kind === 'social') return {
			readPage: (viewer: MiLocalUser, position: Parameters<TimelineLocalSource['readPage']>[2]) => this.local.readPage(viewer, options as TimelineLocalOptions, position),
			hydrate: (viewer: MiLocalUser, refs: TimelineReference[]) => this.local.hydrate(viewer, options as TimelineLocalOptions, refs),
			ownerReferences: (viewer: MiLocalUser, uris: string[], upper?: Parameters<TimelineLocalSource['ownerReferences']>[3]) => this.local.ownerReferences(viewer, options as TimelineLocalOptions, uris, upper),
		};
		if (options.kind === 'mentions' || options.kind === 'direct' || options.kind === 'profile' || options.kind === 'search') return {
			readPage: (viewer: MiLocalUser, position: Parameters<TimelineLocalSource['readPage']>[2]) => this.lists!.readPage(viewer, options as TimelineListOptions, position),
			hydrate: (viewer: MiLocalUser, refs: TimelineReference[]) => this.lists!.hydrate(viewer, options as TimelineListOptions, refs),
			ownerReferences: (viewer: MiLocalUser, uris: string[], upper?: Parameters<TimelineLocalSource['ownerReferences']>[3]) => this.lists!.ownerReferences(viewer, options as TimelineListOptions, uris, upper),
		};
		if (options.kind === 'favorites') return {
			readPage: (viewer: MiLocalUser, position: Parameters<TimelineLocalSource['readPage']>[2]) => this.favorites!.readPage(viewer, position),
			hydrate: (viewer: MiLocalUser, refs: TimelineReference[]) => this.favorites!.hydrate(viewer, refs as FavoriteReference[]),
			ownerReferences: (viewer: MiLocalUser, uris: string[], upper?: Parameters<TimelineLocalSource['ownerReferences']>[3]) => this.favorites!.ownerReferences(viewer, uris, upper),
		};
		// Linked channels are authored on the source server; the destination's
		// normal note store is not an alternative channel source.
		return {
			readPage: async (_viewer: MiLocalUser, _position: Parameters<TimelineLocalSource['readPage']>[2]) => ({ references: [] as TimelineReference[], next: null, upper: null, ended: true }),
			hydrate: async (_viewer: MiLocalUser, _refs: TimelineReference[]) => [],
			ownerReferences: async (_viewer: MiLocalUser, _uris: string[], _upper?: Parameters<TimelineLocalSource['ownerReferences']>[3]) => [],
		};
	}

	private compare(options: TimelineOptions) {
		return options.kind === 'clip' && options.order === 'oldest'
			? (a: TimelinePosition, b: TimelinePosition) => -compareTimelinePosition(a, b)
			: compareTimelinePosition;
	}

	private context(viewer: MiLocalUser, options: TimelineOptions, mode: string) { return `timeline-v1:${viewer.id}:${mode}:${JSON.stringify(options)}`; }
	private token(viewer: MiLocalUser, checkpoint: Checkpoint, id: string) {
		return sealGridspaceSecret(this.peer!, JSON.stringify({ session: checkpoint.session, id, expires: checkpoint.expires }), this.context(viewer, checkpoint.options, checkpoint.mode));
	}
	private async store(checkpoint: Checkpoint, id: string, onlyAbsent = false) {
		const serialized = JSON.stringify({ ...checkpoint, merge: { ...checkpoint.merge, owners: {} } });
		if (Buffer.byteLength(serialized) > 256 * 1024) throw new GridspaceLinkError('INVALID_CURSOR');
		await this.sessions.putCheckpoint(checkpoint.session, id, serialized, checkpoint.expires, onlyAbsent);
	}
	private decode(viewer: MiLocalUser, options: TimelineOptions, mode: string, value: string): Cursor {
		try {
			const cursor = JSON.parse(openGridspaceSecret(this.peer!, value, this.context(viewer, options, mode))) as Cursor;
			if (!/^[0-9a-f-]{36}$/.test(cursor.session) || !/^[0-9a-f-]{36}$/.test(cursor.id) || cursor.expires <= Date.now()) throw new Error();
			return cursor;
		} catch { throw new GridspaceLinkError('INVALID_CURSOR'); }
	}
	private async hydrate(viewer: MiLocalUser, checkpoint: Checkpoint, selected: TimelineReference[], deadline = Date.now() + 8000, authorizedPeer?: Awaited<ReturnType<GridspacePrivateService['timeline']>>): Promise<TimelineItem[]> {
		const started = Date.now();
		const local = await this.localSource(checkpoint.options).hydrate(viewer, selected.filter(ref => ref.source === 'local'));
		const peerRefs = selected.filter(ref => ref.source === 'peer');
		const remote = peerRefs.length ? authorizedPeer ?? await this.delegated.timeline(viewer, { ids: peerRefs.map(ref => ref.noteId), candidates: peerRefs, ...checkpoint.options, deadline }) : null;
		const items = new Map<string, TimelineItem>();
		for (const row of local) {
			const ref = selected.find(candidate => candidate.source === 'local' && candidate.noteId === row.reference.noteId)!;
			items.set(ref.canonicalUri, { key: ref.canonicalUri, sortKey: { sortAt: ref.sortAt, uri: ref.canonicalUri }, ref: this.referenceToken(viewer, checkpoint, ref), representation: 'normal', payload: row.payload, validForMs: row.validForMs == null ? null : Math.max(0, row.validForMs - (Date.now() - started)), nextPolicyCheckAt: row.nextPolicyCheckAt });
		}
		const publicRefs = peerRefs.filter(ref => remote?.references.some(allowed => allowed.noteId === ref.noteId && allowed.canonicalUri === ref.canonicalUri && allowed.public));
		if (publicRefs.length && (checkpoint.options.kind === 'profile' || checkpoint.options.kind === 'search')) {
			const imported = new Map<string, Awaited<ReturnType<GridspaceNoteService['historyNote']>>>();
			const budget = { remaining: 128, deadline };
			for (let offset = 0; offset < publicRefs.length; offset += 20) {
				const batch = await this.sharedNotes!.historyNotes(publicRefs.slice(offset, offset + 20).map(ref => ref.noteId), budget);
				for (const [id, note] of batch) imported.set(id, note);
			}
			const mapped = publicRefs.flatMap(ref => { const note = imported.get(ref.noteId); return note ? [{ ...ref, noteId: note.id, source: 'local' as const }] : []; });
			const hydrated = await this.lists!.hydrateImported(viewer, checkpoint.options as TimelineListOptions, mapped);
			const fresh = await this.delegated.timeline(viewer, { ids: publicRefs.map(ref => ref.noteId), ...checkpoint.options, deadline });
			for (const ref of publicRefs) {
				const note = imported.get(ref.noteId);
				const row = hydrated.find(candidate => candidate.reference.noteId === note?.id);
				if (!row || !fresh.references.some(allowed => allowed.noteId === ref.noteId && allowed.public && allowed.canonicalUri === ref.canonicalUri)) continue;
				items.set(ref.canonicalUri, { key: ref.canonicalUri, sortKey: { sortAt: ref.sortAt, uri: ref.canonicalUri }, ref: this.referenceToken(viewer, checkpoint, ref), representation: 'normal', payload: row.payload, validForMs: Math.max(0, Math.min(row.validForMs ?? TIMELINE_AUTHORIZATION_TTL_MS, fresh.validForMs) - (Date.now() - started)), nextPolicyCheckAt: row.nextPolicyCheckAt });
			}
		}
		for (const ref of peerRefs) {
			const body = remote?.notes.find(note => note.id === ref.noteId && canonicalGridspaceNoteUri(note.uri, this.peer!.peerOrigin) === ref.canonicalUri);
			if (body && remote!.validForMs > 0) items.set(ref.canonicalUri, { key: ref.canonicalUri, sortKey: { sortAt: ref.sortAt, uri: ref.canonicalUri }, ref: this.referenceToken(viewer, checkpoint, ref), representation: 'delegated', payload: body, validForMs: remote!.validForMs, nextPolicyCheckAt: null });
		}
		return selected.flatMap(ref => items.has(ref.canonicalUri) ? [items.get(ref.canonicalUri)!] : []);
	}
	private async assertOwners(viewer: MiLocalUser, checkpoint: Checkpoint, selected: TimelineReference[]) {
		const peerRefs = selected.filter(ref => ref.source === 'peer');
		if (!peerRefs.length) return;
		const owners = await this.localSource(checkpoint.options).ownerReferences(viewer, peerRefs.map(ref => ref.canonicalUri), checkpoint.merge.local.upper);
		if (owners.length) throw new GridspaceLinkError('INVALID_CURSOR');
	}
	private referenceToken(viewer: MiLocalUser, checkpoint: Checkpoint, reference: TimelineReference) {
		return sealGridspaceSecret(this.peer!, JSON.stringify(reference), `timeline-ref:${viewer.id}:${checkpoint.session}:${checkpoint.revision}`);
	}
	private updatesToken(viewer: MiLocalUser, checkpoint: Checkpoint) {
		return sealGridspaceSecret(this.peer!, JSON.stringify({ sequence: checkpoint.sequence, peerSequence: checkpoint.peerSequence, expires: checkpoint.expires }), `timeline-updates:${viewer.id}:${checkpoint.session}:${checkpoint.revision}`);
	}
	public async authorizeSubscription(viewer: { id: string }, session: string, revision: string, updatesCursor: string): Promise<boolean> {
		if (!this.peer) return false;
		try {
			const token = JSON.parse(openGridspaceSecret(this.peer, updatesCursor, `timeline-updates:${viewer.id}:${session}:${revision}`));
			return token.expires > Date.now() && await this.sessions.getSession(session) != null;
		} catch { return false; }
	}
	public async streamContext(viewer: { id: string }, session: string, revision: string): Promise<TimelineOptions | null> {
		const stored = await this.sessions.getSession(session);
		if (!stored) return null;
		const checkpoint = JSON.parse(stored) as Checkpoint;
		return checkpoint.revision === revision && checkpoint.expires > Date.now() && (checkpoint.viewerId == null || checkpoint.viewerId === viewer.id) ? checkpoint.options : null;
	}

	/** Native note-stream events contain an ID only; every body is re-authorized here. */
	public async streamNote(viewer: MiLocalUser, session: string, revision: string, event: TimelineStreamEvent): Promise<TimelineStreamResult> {
		const started = performance.now();
		const result: TimelineStreamResult = { session, revision, resetRequired: false };
		if (!this.peer || !/^[a-zA-Z0-9]{1,32}$/.test(event.noteId)) return result;
		const stored = await this.sessions.getSession(session);
		if (!stored) return { ...result, resetRequired: true };
		const checkpoint = JSON.parse(stored) as Checkpoint;
		if (checkpoint.revision !== revision || checkpoint.expires <= Date.now() || (checkpoint.viewerId != null && checkpoint.viewerId !== viewer.id)) return { ...result, resetRequired: true };
		if (event.source === 'peer' && checkpoint.mode === 'local-fallback') return result;
		const deadline = Date.now() + 8000;
		let candidate: TimelineReference | undefined;
		if (event.source === 'local') {
			const refs = await this.references.getMany([event.noteId]);
			if (!refs[0]) return result;
			const owners = await this.localSource(checkpoint.options).ownerReferences(viewer, [refs[0].canonicalUri]);
			candidate = owners[0];
		} else {
			const remote = await this.delegated.timeline(viewer, { ...checkpoint.options, ids: [event.noteId], deadline });
			const ref = remote.references.find(value => value.noteId === event.noteId);
			if (!ref) return result;
			const owners = await this.localSource(checkpoint.options).ownerReferences(viewer, [ref.canonicalUri]);
			candidate = owners[0] ?? ref;
		}
		if (!candidate) return result;
		const owner = checkpoint.merge.owners[candidate.canonicalUri];
		if (owner != null && owner !== candidate.source) return { ...result, resetRequired: true };
		const compare = this.compare(checkpoint.options);
		if (owner == null && checkpoint.windowHead && compare(candidate, checkpoint.windowHead) > 0) return { ...result, resetRequired: true };
		const items = await this.hydrate(viewer, checkpoint, [candidate], deadline);
		const item = items[0];
		if (!item || item.validForMs === 0) return result;
		// A concurrent import may have changed which representation owns this URI
		// while packing. Do not send a second representation at the wrong position.
		const currentOwners = await this.localSource(checkpoint.options).ownerReferences(viewer, [candidate.canonicalUri]);
		if ((candidate.source === 'peer' && currentOwners.length > 0) || (candidate.source === 'local' && !currentOwners.some(value => value.noteId === candidate!.noteId))) return { ...result, resetRequired: true };
		checkpoint.merge.owners[candidate.canonicalUri] = candidate.source;
		if (!checkpoint.windowHead || compare(candidate, checkpoint.windowHead) < 0) checkpoint.windowHead = candidate;
		try {
			const merged = JSON.parse(await this.sessions.putSession(session, JSON.stringify(checkpoint), checkpoint.expires)) as Checkpoint;
			if (merged.merge.owners[candidate.canonicalUri] !== candidate.source || (owner == null && merged.windowHead && compare(candidate, merged.windowHead) > 0)) return { ...result, resetRequired: true };
		} catch (error) {
			if (error instanceof GridspaceLinkError) return { ...result, resetRequired: true };
			throw error;
		}
		if (item.validForMs != null) item.validForMs = Math.max(0, item.validForMs - Math.ceil(performance.now() - started));
		return item.validForMs === 0 ? result : { ...result, item };
	}
	private async relevantChanges(viewer: MiLocalUser, checkpoint: Checkpoint, sequence: string, retained: TimelineReference[]) {
		const changes = await this.references.changes(sequence);
		const ids = [...new Set(changes.events.flatMap(event => event.noteId ? [event.noteId] : []))];
		const candidates = checkpoint.options.kind !== 'favorites' && ids.length ? (await this.references.getMany(ids)).map(ref => ({ ...ref, source: 'local' as const })) : [];
		const readable = await this.localSource(checkpoint.options).hydrate(viewer, candidates);
		const visible = new Set(readable.map(row => row.reference.noteId));
		const retainedIds = new Set(retained.filter(ref => ref.source === 'local').map(ref => ref.noteId));
		const policy = changes.events.some(event => !event.noteId && (!event.affectedUserId || event.affectedUserId === viewer.id));
		const updated = changes.events.some(event => event.noteId && (retainedIds.has(event.noteId) || visible.has(event.noteId)) && event.kind !== 'insert');
		const ownerChanged = changes.events.some(event => event.kind !== 'insert' && event.canonicalUri != null && Object.hasOwn(checkpoint.merge.owners, event.canonicalUri));
		const inserts = candidates.filter(ref => visible.has(ref.noteId) && changes.events.some(event => event.noteId === ref.noteId && event.kind === 'insert'));
		return { ...changes, resetRequired: changes.resetRequired || policy || updated || ownerChanged ||
			(checkpoint.nextPolicyCheckAt != null && checkpoint.nextPolicyCheckAt <= Date.now()), inserts };
	}

	public async page(viewer: MiLocalUser, options: TimelineOptions, limit: number, cursor?: string, mode: 'unified' | 'local-fallback' = 'unified', anchor?: string, retained?: { previousSession: string; previousRevision: string; refs: string[] }): Promise<TimelinePage> {
		const deadline = Date.now() + 8000;
		if (!this.peer) throw new GridspaceLinkError('UNAVAILABLE');
		if ((options.kind === 'channel') !== !!options.channelId || (options.kind === 'clip') !== !!options.clipId || (options.kind === 'antenna') !== !!options.antennaId ||
			(options.kind === 'profile' && !options.userId) || (options.kind === 'search' && !options.query?.trim()) ||
			(options.order === 'oldest' && options.kind !== 'clip') || (options.query && !['channel', 'clip', 'search'].includes(options.kind))) throw new GridspaceLinkError('INVALID_REQUEST');
		const status = await this.references.status();
		let position: Cursor;
		let checkpoint: Checkpoint;
		if (cursor) {
			position = this.decode(viewer, options, mode, cursor);
			const value = await this.sessions.getCheckpoint(position.session, position.id);
			if (!value) throw new GridspaceLinkError('INVALID_CURSOR');
			checkpoint = JSON.parse(value) as Checkpoint;
			const current = await this.sessions.getSession(checkpoint.session);
			if (current) {
				const shared = JSON.parse(current) as Checkpoint;
				checkpoint.merge.owners = shared.merge.owners;
				checkpoint.windowHead = shared.windowHead;
			}
			if (checkpoint.revision !== String(status.generation)) throw new GridspaceLinkError('INVALID_CURSOR');
			// Any committed mutation can change ownership of buffered/consumed rows.
			let sequence = checkpoint.checkedThrough ?? checkpoint.sequence;
			for (let batch = 0; batch < 8; batch++) {
				const events = await this.relevantChanges(viewer, checkpoint, sequence, [...(checkpoint.selected ?? []), ...checkpoint.merge.local.pending]);
				if (events.resetRequired) throw new GridspaceLinkError('INVALID_CURSOR');
				sequence = events.cursor;
				checkpoint.checkedThrough = sequence;
				await this.store(checkpoint, position.id);
				if (!events.hasMore) break;
				if (batch === 7) throw new GridspaceLinkError('UNAVAILABLE');
			}
			// Keep the original updates cursor; immutable history can advance through
			// unrelated event batches without declaring a false gap/reset.
		} else {
			position = { session: randomUUID(), id: randomUUID(), expires: Date.now() + 3600_000 };
			checkpoint = { options, mode, session: position.session, viewerId: viewer.id, expires: position.expires, revision: String(status.generation), merge: emptyTimelineMerge(mode === 'unified'), sequence: await this.references.currentPosition() };
			checkpoint.nextPolicyCheckAt = await this.local.nextViewerPolicyCheck(viewer.id);
			if (anchor) {
				const own = await this.localSource(options).ownerReferences(viewer, [anchor]);
				const ref = own[0] ?? (mode === 'unified' ? (await this.delegated.timeline(viewer, { anchor, ...options, deadline })).references[0] : undefined);
				if (ref) {
					if (options.kind === 'clip' && options.order === 'oldest') checkpoint.fromAt = Number(BigInt(ref.sortAt) / 1000n);
					else checkpoint.untilAt = Number(BigInt(ref.sortAt) / 1000n);
				}
			}
			await this.sessions.start(viewer.id, checkpoint.session, JSON.stringify(checkpoint), checkpoint.expires);
			await this.store(checkpoint, position.id, true);
		}
		const states: TimelineSourceState[] = [{ source: 'local', status: 'ok', retryable: false }, { source: 'peer', status: mode === 'unified' ? 'ok' : 'disabled', retryable: false }];
		if (!checkpoint.selected) {
			const working = structuredClone(checkpoint);
			try {
				working.selected = await mergeTimeline(working.merge, limit, async (source, state) => {
					if (source === 'local') {
						return this.localSource(options).readPage(viewer, { before: state.before ?? undefined, upper: state.upper ?? undefined, untilAt: working.untilAt, limit: 50 });
					}
					let page: Awaited<ReturnType<GridspacePrivateService['timeline']>>;
					try { page = await this.delegated.timeline(viewer, { before: state.before ?? undefined, upper: state.upper ?? undefined, untilAt: working.untilAt, fromAt: working.fromAt, ...options, deadline }); } catch (error) {
						if (!(error instanceof GridspaceLinkError) || !['AUTHORIZATION_REVOKED', 'LINK_REVOKED'].includes(error.code)) throw error;
						states[1] = { source: 'peer', status: 'unauthorized', retryable: false };
						return { references: [], next: null, upper: null, ended: true };
					}
					working.peerSequence ??= page.sequence;
					const owned = await this.localSource(options).ownerReferences(viewer, page.references.map(ref => ref.canonicalUri), working.merge.local.upper);
					for (const ref of owned) working.merge.owners[ref.canonicalUri] ??= 'local';
					const references = page.references.filter(ref => {
						working.merge.owners[ref.canonicalUri] ??= 'peer';
						return working.merge.owners[ref.canonicalUri] === 'peer';
					});
					return { references, next: page.next ?? null, upper: page.upper ?? null, ended: !page.next };
				}, () => Date.now() < deadline - 250, this.compare(options));
				working.nextId = working.merge.local.pending.length || working.merge.peer.pending.length || !working.merge.local.ended || !working.merge.peer.ended ? randomUUID() : null;
				working.windowHead ??= working.selected[0];
				// NX fixes both selection and next checkpoint for concurrent retries.
				const baseOwners = checkpoint.merge.owners;
				const deltaOwners = Object.fromEntries(Object.entries(working.merge.owners).filter(([key]) => !Object.hasOwn(baseOwners, key)));
				const committed = JSON.parse(await this.sessions.claimResult(position.session, position.id, JSON.stringify({ ...working, merge: { ...working.merge, owners: deltaOwners } }), checkpoint.expires)) as Checkpoint;
				checkpoint = { ...committed, merge: { ...committed.merge, owners: { ...baseOwners, ...committed.merge.owners } } };
				if (checkpoint.nextId) await this.store({ ...checkpoint, selected: undefined, nextId: undefined }, checkpoint.nextId, true);
				await this.store(checkpoint, position.id);
				await this.sessions.putSession(checkpoint.session, JSON.stringify(checkpoint), checkpoint.expires);
			} catch (error) {
				if (!(error instanceof GridspaceLinkError)) throw error;
				states[1] = { source: 'peer', status: ['AUTHORIZATION_REVOKED', 'LINK_REVOKED'].includes(error.code) ? 'unauthorized' : 'unavailable', retryable: true };
				const refs = (await this.localSource(options).readPage(viewer, { limit })).references;
				return { version: 1, session: checkpoint.session, revision: checkpoint.revision, items: await this.hydrate(viewer, checkpoint, refs.map(ref => ({ ...ref, source: 'local' }))), nextCursor: this.token(viewer, checkpoint, position.id), updatesCursor: this.updatesToken(viewer, checkpoint), complete: false, mode, sources: states, revalidateAfterMs: TIMELINE_REVALIDATE_MS };
			}
		}
		await this.assertOwners(viewer, checkpoint, checkpoint.selected!);
		const items = await this.hydrate(viewer, checkpoint, checkpoint.selected!, deadline);
		await this.assertOwners(viewer, checkpoint, checkpoint.selected!);
		let rebound: TimelineReference[] = [];
		if (retained?.refs.length) {
			try { rebound = retained.refs.map(value => JSON.parse(openGridspaceSecret(this.peer!, value, `timeline-ref:${viewer.id}:${retained.previousSession}:${retained.previousRevision}`)) as TimelineReference); } catch { throw new GridspaceLinkError('INVALID_CURSOR'); }
		}
		const reboundOwners = await this.localSource(options).ownerReferences(viewer, rebound.filter(ref => ref.source === 'peer').map(ref => ref.canonicalUri));
		rebound = rebound.map(ref => reboundOwners.find(owner => owner.canonicalUri === ref.canonicalUri) ?? ref);
		const retainedItems = await this.hydrate(viewer, checkpoint, rebound, deadline);
		const order = [...checkpoint.selected!, ...rebound].sort(this.compare(options)).map(ref => ref.canonicalUri).filter((key, index, all) => all.indexOf(key) === index);
		return { version: 1, session: checkpoint.session, revision: checkpoint.revision, items, retainedItems, order, nextCursor: checkpoint.nextId ? this.token(viewer, checkpoint, checkpoint.nextId) : null, updatesCursor: this.updatesToken(viewer, checkpoint), complete: true, mode, sources: states, revalidateAfterMs: TIMELINE_REVALIDATE_MS };
	}

	public async changes(viewer: MiLocalUser, input: { session: string; revision: string; updatesCursor: string; refs: string[]; phase: 'validate' | 'changes' }) {
		if (!this.peer) throw new GridspaceLinkError('UNAVAILABLE');
		let update: { sequence: string; peerSequence?: string; expires: number };
		let selected: TimelineReference[];
		try {
			update = JSON.parse(openGridspaceSecret(this.peer, input.updatesCursor, `timeline-updates:${viewer.id}:${input.session}:${input.revision}`));
			if (update.expires < Date.now()) throw new Error();
			selected = input.refs.map(ref => JSON.parse(openGridspaceSecret(this.peer!, ref, `timeline-ref:${viewer.id}:${input.session}:${input.revision}`)) as TimelineReference);
		} catch { throw new GridspaceLinkError('INVALID_CURSOR'); }
		// Retrieve the original conditions without trusting client-supplied kind/filters.
		const optionsValue = await this.sessions.getSession(input.session);
		if (!optionsValue) throw new GridspaceLinkError('INVALID_CURSOR');
		const checkpoint = JSON.parse(optionsValue) as Checkpoint;
		if (checkpoint.revision !== input.revision) throw new GridspaceLinkError('INVALID_CURSOR');
		if (checkpoint.viewerId != null && checkpoint.viewerId !== viewer.id) throw new GridspaceLinkError('INVALID_CURSOR');
		const events = input.phase === 'changes' ? await this.relevantChanges(viewer, checkpoint, update.sequence, selected) : null;
		const deadline = Date.now() + 8000;
		let authorizedPeer: Awaited<ReturnType<GridspacePrivateService['timeline']>> | undefined;
		let peerStartedAt = 0;
		let peerChanged = false;
		let peerInserts: TimelineReference[] = [];
		if (input.phase === 'changes' && update.peerSequence) {
			const peerRefs = selected.filter(ref => ref.source === 'peer');
			peerStartedAt = Date.now();
			const peer = await this.delegated.timeline(viewer, { ids: peerRefs.map(ref => ref.noteId), candidates: peerRefs, sequence: update.peerSequence, ...checkpoint.options, deadline });
			authorizedPeer = peer;
			peerChanged = peer.changed;
			peerInserts = peer.newReferences;
			checkpoint.peerSequence = peer.sequence;
		}
		const owners = await this.localSource(checkpoint.options).ownerReferences(viewer, selected.filter(ref => ref.source === 'peer').map(ref => ref.canonicalUri));
		const ownershipChanged = owners.length > 0;
		const compare = this.compare(checkpoint.options);
		if (authorizedPeer) authorizedPeer = { ...authorizedPeer, validForMs: Math.max(0, authorizedPeer.validForMs - (Date.now() - peerStartedAt)) };
		const items = await this.hydrate(viewer, checkpoint, selected.filter(ref => !owners.some(owner => owner.canonicalUri === ref.canonicalUri)).sort(compare), deadline, authorizedPeer);
		if (events) checkpoint.sequence = events.cursor;
		const locallyOwned = await this.localSource(checkpoint.options).ownerReferences(viewer, peerInserts.map(ref => ref.canonicalUri));
		const inserts = [...(events?.inserts ?? []), ...peerInserts.filter(ref => !locallyOwned.some(owner => owner.canonicalUri === ref.canonicalUri))].filter(ref => !selected.some(existing => existing.canonicalUri === ref.canonicalUri)).sort(compare);
		const head = checkpoint.windowHead;
		const late = inserts.some(ref => head && compare(ref, head) > 0);
		const newItems = late ? [] : await this.hydrate(viewer, checkpoint, inserts);
		if (!late && inserts[0] && (!checkpoint.windowHead || compare(inserts[0], checkpoint.windowHead) < 0)) checkpoint.windowHead = inserts[0];
		const mergedCheckpoint = JSON.parse(await this.sessions.putSession(checkpoint.session, JSON.stringify(checkpoint), checkpoint.expires)) as Checkpoint;
		checkpoint.windowHead = mergedCheckpoint.windowHead;
		const resetRequired = late || ownershipChanged || peerChanged || (events?.resetRequired ?? false) || String((await this.references.status()).generation) !== checkpoint.revision;
		return { version: 1, session: checkpoint.session, revision: checkpoint.revision, items, newItems, order: [...newItems, ...items].map(item => item.key), removed: selected.filter(ref => !items.some(item => item.key === ref.canonicalUri)).map(ref => ref.canonicalUri), nextCursor: null, updatesCursor: this.updatesToken(viewer, checkpoint), complete: true, mode: checkpoint.mode, sources: [{ source: 'local' as const, status: 'ok' as const, retryable: false }], revalidateAfterMs: TIMELINE_REVALIDATE_MS, replaceWindow: false, resetRequired };
	}
}
