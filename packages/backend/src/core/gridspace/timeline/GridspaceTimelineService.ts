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
import { GridspaceClipReferenceService } from '../GridspaceClipReferenceService.js';
import { TimelineFavoriteSource, type FavoriteReference } from './TimelineFavoriteSource.js';
import { TimelineReferenceService } from './TimelineReferenceService.js';
import { TimelinePlacementSource, comparePlacementPosition } from './TimelinePlacementSource.js';
import { TimelineLocalSource } from './TimelineLocalSource.js';
import { TimelineSessionStore } from './TimelineSessionStore.js';
import { GridspaceTimelineListSourceService } from './GridspaceTimelineListSourceService.js';
import { emptyTimelineMerge, mergeTimeline, type TimelineMergeState } from './TimelineMergeService.js';
import { TIMELINE_AUTHORIZATION_TTL_MS, TIMELINE_REVALIDATE_MS, compareTimelinePosition, type TimelineItem, type TimelineOptions, type TimelinePage, type TimelinePosition, type TimelineReference, type TimelineSourceState } from './timeline-protocol.js';
import type { TimelineLocalOptions } from './TimelineLocalSource.js';
import type { TimelineListOptions } from './GridspaceTimelineListSourceService.js';

type Checkpoint = {
	options: TimelineOptions; mode: 'unified' | 'local-fallback'; revision: string; expires: number; session: string;
	viewerId?: string;
	merge: TimelineMergeState; selected?: TimelineReference[]; nextId?: string | null; sequence: string; peerSequence?: string; placementSequence?: string;
	untilAt?: number;
	fromAt?: number;
	windowHead?: TimelineReference;
	nextPolicyCheckAt?: number | null;
	checkedThrough?: string;
	clipRevision?: string;
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
		private placements?: TimelinePlacementSource,
		private clipReferences?: GridspaceClipReferenceService,
	) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
		this.enabled = config.gridspace?.timelineEnabled === true;
	}

	public async capability() {
		if (!this.peer) return { version: 1, enabled: false, kinds: ['home', 'social'] };
		return { version: 1, enabled: this.enabled, channelPlacements: this.enabled && await this.placements?.supportHome() === true, kinds: ['home', 'social', 'relay-social', 'profile', 'search', 'mentions', 'direct', 'favorites', 'channel', 'antenna', 'clip'] };
	}

	private localSource(options: TimelineOptions) {
		if (options.kind === 'clip' && this.clipReferences) return {
			readPage: (viewer: MiLocalUser, position: Parameters<TimelineLocalSource['readPage']>[2]) => this.clipReferences!.readPage(viewer, options, 'local', position),
			hydrate: async (_viewer: MiLocalUser, _refs: TimelineReference[]) => [],
			ownerReferences: (viewer: MiLocalUser, uris: string[]) => this.clipReferences!.ownerReferences(viewer, options, uris),
			ownerCandidates: (viewer: MiLocalUser, uris: string[]) => this.clipReferences!.ownerReferences(viewer, options, uris),
		};
		if (options.kind === 'home' || options.kind === 'social' || options.kind === 'relay-social') return {
			readPage: (viewer: MiLocalUser, position: Parameters<TimelineLocalSource['readPage']>[2]) => this.local.readPage(viewer, options as TimelineLocalOptions, position),
			hydrate: (viewer: MiLocalUser, refs: TimelineReference[]) => this.local.hydrate(viewer, options as TimelineLocalOptions, refs),
			ownerReferences: (viewer: MiLocalUser, uris: string[], upper?: Parameters<TimelineLocalSource['ownerReferences']>[3]) => this.local.ownerReferences(viewer, options as TimelineLocalOptions, uris, upper),
			ownerCandidates: (viewer: MiLocalUser, uris: string[]) => this.local.ownerCandidates(viewer, options as TimelineLocalOptions, uris, undefined, true),
		};
		if (options.kind === 'mentions' || options.kind === 'direct' || options.kind === 'profile' || options.kind === 'search') return {
			readPage: (viewer: MiLocalUser, position: Parameters<TimelineLocalSource['readPage']>[2]) => this.lists!.readPage(viewer, options as TimelineListOptions, position),
			hydrate: (viewer: MiLocalUser, refs: TimelineReference[]) => this.lists!.hydrate(viewer, options as TimelineListOptions, refs),
			ownerReferences: (viewer: MiLocalUser, uris: string[], upper?: Parameters<TimelineLocalSource['ownerReferences']>[3]) => this.lists!.ownerReferences(viewer, options as TimelineListOptions, uris, upper),
			ownerCandidates: (viewer: MiLocalUser, uris: string[]) => this.lists!.ownerCandidates(viewer, options as TimelineListOptions, uris),
		};
		if (options.kind === 'favorites') return {
			readPage: (viewer: MiLocalUser, position: Parameters<TimelineLocalSource['readPage']>[2]) => this.favorites!.readPage(viewer, position),
			hydrate: (viewer: MiLocalUser, refs: TimelineReference[]) => this.favorites!.hydrate(viewer, refs as FavoriteReference[]),
			ownerReferences: (viewer: MiLocalUser, uris: string[], upper?: Parameters<TimelineLocalSource['ownerReferences']>[3]) => this.favorites!.ownerReferences(viewer, uris, upper),
			ownerCandidates: (viewer: MiLocalUser, uris: string[]) => this.favorites!.ownerCandidates(viewer, uris),
		};
		// Linked channels are authored on the source server; the destination's
		// normal note store is not an alternative channel source.
		return {
			readPage: async (_viewer: MiLocalUser, _position: Parameters<TimelineLocalSource['readPage']>[2]) => ({ references: [] as TimelineReference[], next: null, upper: null, ended: true }),
			hydrate: async (_viewer: MiLocalUser, _refs: TimelineReference[]) => [],
			ownerReferences: async (_viewer: MiLocalUser, _uris: string[], _upper?: Parameters<TimelineLocalSource['ownerReferences']>[3]) => [],
			ownerCandidates: async (_viewer: MiLocalUser, _uris: string[]): Promise<TimelineReference[]> => [],
		};
	}

	private compare(options: TimelineOptions) {
		if (options.channelOrigin) return comparePlacementPosition;
		return options.kind === 'clip' && options.order === 'oldest'
			? (a: TimelinePosition, b: TimelinePosition) => -compareTimelinePosition(a, b)
			: compareTimelinePosition;
	}

	private context(viewer: MiLocalUser, options: TimelineOptions, mode: string) { return `timeline-v${options.channelOrigin ? 2 : 1}:${viewer.id}:${mode}:${JSON.stringify(options)}`; }
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
	private async hydratePlacements(viewer: MiLocalUser, checkpoint: Checkpoint, selected: TimelineReference[], deadline: number): Promise<TimelineItem[]> {
		if (!selected.length) return [];
		const { channelOrigin, channelId, pinnedOnly, withFiles } = checkpoint.options;
		const origins = channelOrigin ? [...new Set(selected.map(ref => ref.source === 'peer' ? this.peer!.peerOrigin : this.peer!.origin))] : [this.peer!.origin, ...(checkpoint.mode === 'unified' ? [this.peer!.peerOrigin] : [])];
		const request = { channelId, pinnedOnly, followed: !channelOrigin, uris: selected.map(ref => ref.canonicalUri), limit: selected.length };
		const read = async () => (await Promise.all(origins.map(origin => this.placements!.read(viewer, origin, channelOrigin && origin !== channelOrigin ? { ...request, replyChannelOrigin: channelOrigin } : request, deadline)))).flatMap(page => page.references);
		const active = await read();
		const unique = new Map(active.map(ref => [ref.canonicalUri, ref]));
		const bodies = await this.placements!.bodies(viewer, [...unique.values()], deadline, checkpoint.options);
		if (!bodies.size) return [];
		const recheckStarted = Date.now();
		const fresh = await read();
		return selected.flatMap(ref => {
			const body = bodies.get(ref.canonicalUri);
			if (body?.validForMs != null) body.validForMs = Math.max(0, body.validForMs - (Date.now() - recheckStarted));
			const paths = fresh.filter(r => r.canonicalUri === ref.canonicalUri);
			if (!body || !paths.length || body.validForMs === 0 || (withFiles && !body.payload.files?.length)) return [];
			const chips = new Map((body.payload.channelPlacements ?? []).map(chip => [JSON.stringify([chip.origin, chip.channelId]), chip]));
			for (const path of paths) {
				for (const chip of path.placement!.chips ?? []) {
					const key = JSON.stringify([chip.origin, chip.channelId]);
					chips.set(key, { ...chips.get(key), ...chip });
				}
			}
			if (chips.size) {
				body.payload.channelPlacements = [...chips.values()];
				body.payload.includeDefault = paths[0].placement!.includeDefault;
				if (body.payload.multiNoteKind !== 'conversation-reply') body.payload.multiNoteKind = 'root';
			}
			const routes = paths.map(r => ({ origin: r.placement!.channelOrigin, channelIds: r.placement!.channelIds ?? [r.placement!.channelId] }));
			return [{ key: ref.canonicalUri, sortKey: { sortAt: ref.sortAt, uri: ref.canonicalUri },
													ref: this.referenceToken(viewer, checkpoint, { ...paths[0], placement: { ...paths[0].placement!, chips: undefined }, routes }), ...body }];
		});
	}
	private async hydrate(viewer: MiLocalUser, checkpoint: Checkpoint, selected: TimelineReference[], deadline = Date.now() + 8000, authorizedPeer?: Awaited<ReturnType<GridspacePrivateService['timeline']>>, singleLocal = false): Promise<TimelineItem[]> {
		if (checkpoint.options.kind === 'clip' && this.clipReferences) {
			const rows = await this.clipReferences.hydrate(viewer, checkpoint.options, selected, deadline);
			return rows.map(({ reference, ...body }) => ({ key: reference.canonicalUri, sortKey: { sortAt: reference.sortAt, uri: reference.canonicalUri }, ref: this.referenceToken(viewer, checkpoint, reference), ...body }));
		}
		if (checkpoint.options.channelOrigin) return this.hydratePlacements(viewer, checkpoint, selected, deadline);
		const native = selected.filter(ref => !ref.placement);
		const placements = checkpoint.merge.localPlacement && !singleLocal ? await this.hydratePlacements(viewer, checkpoint, selected, deadline) : [];
		// A removed or muted channel can leave the author's home route intact.
		const fallbackUris = selected.filter(ref => ref.placement && !placements.some(item => item.key === ref.canonicalUri)).map(ref => ref.canonicalUri);
		if (fallbackUris.length) native.push(...await this.localSource(checkpoint.options).ownerReferences(viewer, fallbackUris));
		const started = Date.now();
		const local = singleLocal
			? await this.local.hydrateSingle(viewer, checkpoint.options as TimelineLocalOptions, selected[0])
			: await this.localSource(checkpoint.options).hydrate(viewer, native.filter(ref => ref.source === 'local'));
		const peerRefs = native.filter(ref => ref.source === 'peer');
		const remote = peerRefs.length ? authorizedPeer ?? await this.delegated.timeline(viewer, { ids: peerRefs.map(ref => ref.noteId), candidates: peerRefs, ...checkpoint.options, deadline }) : null;
		const items = new Map<string, TimelineItem>();
		for (const row of local) {
			const ref = native.find(candidate => candidate.source === 'local' && candidate.noteId === row.reference.noteId)!;
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
			const fallback = publicRefs.filter(ref => !imported.has(ref.noteId) && fresh.references.some(allowed => allowed.noteId === ref.noteId && allowed.public && allowed.canonicalUri === ref.canonicalUri));
			if (fallback.length) {
				// Keep source IDs/body ephemeral. The source rechecks the public list
				// ACL and strips all nested content, including for unlinked viewers.
				const page = await this.delegated.timeline(viewer, { ...checkpoint.options, ids: fallback.map(ref => ref.noteId), candidates: fallback, includePublicBodies: true, deadline });
				for (const ref of fallback) {
					const body = page.notes.find(note => note.id === ref.noteId && canonicalGridspaceNoteUri(note.uri, this.peer!.peerOrigin) === ref.canonicalUri);
					if (body) items.set(ref.canonicalUri, { key: ref.canonicalUri, sortKey: { sortAt: ref.sortAt, uri: ref.canonicalUri }, ref: this.referenceToken(viewer, checkpoint, ref), representation: 'delegated', payload: body,
																																													validForMs: Math.max(0, Math.min(page.validForMs, fresh.validForMs) - (Date.now() - started)), nextPolicyCheckAt: null });
				}
			}
		}
		for (const ref of peerRefs) {
			const body = remote?.notes.find(note => note.id === ref.noteId && canonicalGridspaceNoteUri(note.uri, this.peer!.peerOrigin) === ref.canonicalUri);
			if (body && remote!.validForMs > 0) items.set(ref.canonicalUri, { key: ref.canonicalUri, sortKey: { sortAt: ref.sortAt, uri: ref.canonicalUri }, ref: this.referenceToken(viewer, checkpoint, ref), representation: 'delegated', payload: body, validForMs: remote!.validForMs, nextPolicyCheckAt: null });
		}
		for (const item of placements) items.set(item.key, item);
		return selected.flatMap(ref => items.has(ref.canonicalUri) ? [items.get(ref.canonicalUri)!] : []);
	}
	private async partialPage(viewer: MiLocalUser, checkpoint: Checkpoint, id: string, limit: number, states: TimelineSourceState[]): Promise<TimelinePage> {
		const deadline = Date.now() + 8000;
		let items: TimelineItem[] = [];
		const options = checkpoint.options;
		if (options.channelOrigin === this.peer!.origin) {
			const request = { channelId: options.channelId, pinnedOnly: options.pinnedOnly, upper: checkpoint.merge.local.upper ?? undefined, limit };
			const page = await this.placements!.read(viewer, this.peer!.origin, request, deadline);
			const localRefs = page.references.filter(ref => ref.placement?.noteOrigin === this.peer!.origin);
			items = await this.hydratePlacements(viewer, checkpoint, localRefs, deadline);
		} else if (!options.channelOrigin) {
			const refs = (await this.localSource(options).readPage(viewer, { limit })).references;
			const fallback = { ...checkpoint, merge: { ...checkpoint.merge, localPlacement: undefined, peerPlacement: undefined } };
			items = await this.hydrate(viewer, fallback, refs.map(ref => ({ ...ref, source: 'local' })), deadline);
		}
		return { version: 1, session: checkpoint.session, revision: checkpoint.revision, items, nextCursor: this.token(viewer, checkpoint, id),
											updatesCursor: this.updatesToken(viewer, checkpoint), complete: false, mode: checkpoint.mode, sources: states, revalidateAfterMs: TIMELINE_REVALIDATE_MS };
	}
	private async assertOwners(viewer: MiLocalUser, checkpoint: Checkpoint, selected: TimelineReference[]) {
		const peerRefs = selected.filter(ref => ref.source === 'peer');
		if (checkpoint.options.channelOrigin || checkpoint.merge.localPlacement || !peerRefs.length) return;
		const owners = await this.localSource(checkpoint.options).ownerReferences(viewer, peerRefs.map(ref => ref.canonicalUri), checkpoint.merge.local.upper);
		if (owners.length) throw new GridspaceLinkError('INVALID_CURSOR');
	}
	private referenceToken(viewer: MiLocalUser, checkpoint: Checkpoint, reference: TimelineReference) {
		return sealGridspaceSecret(this.peer!, JSON.stringify(reference), `timeline-ref:${viewer.id}:${checkpoint.session}:${checkpoint.revision}`);
	}
	private async restoreOwners(checkpoint: Checkpoint, uris: string[]) {
		const known = await this.sessions.getReferences(checkpoint.session, [...new Set(uris)]);
		for (const [uri, value] of Object.entries(known)) if (value.source) checkpoint.merge.owners[uri] = value.source;
	}
	private updatesToken(viewer: MiLocalUser, checkpoint: Checkpoint) {
		return sealGridspaceSecret(this.peer!, JSON.stringify({ sequence: checkpoint.sequence, peerSequence: checkpoint.peerSequence, placementSequence: checkpoint.placementSequence, expires: checkpoint.expires }), `timeline-updates:${viewer.id}:${checkpoint.session}:${checkpoint.revision}`);
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
		// Placement events carry a committed URI and use changes(). Native note IDs
		// alone cannot identify the channel or the origin on the other server.
		if (checkpoint.options.channelOrigin || checkpoint.options.kind === 'clip') return result;
		if (event.source === 'peer' && checkpoint.mode === 'local-fallback') return result;
		const deadline = Date.now() + 8000;
		const source = this.localSource(checkpoint.options);
		let candidate: TimelineReference | undefined;
		const singleLocal = event.source === 'local' && (checkpoint.options.kind === 'home' || checkpoint.options.kind === 'social' || checkpoint.options.kind === 'relay-social');
		if (event.source === 'local') {
			const refs = await this.references.getMany([event.noteId]);
			if (!refs[0]) return result;
			// hydrateSingle checks the exact note's live ACL before packing. No
			// separate ownership/body read is necessary before that check.
			candidate = singleLocal ? { ...refs[0], source: 'local' } : (await source.ownerCandidates(viewer, [refs[0].canonicalUri]))[0];
		} else {
			const remote = await this.delegated.timeline(viewer, { ...checkpoint.options, ids: [event.noteId], deadline });
			const ref = remote.references.find(value => value.noteId === event.noteId);
			if (!ref) return result;
			// A cached candidate must still produce an authorized body before it
			// can replace the freshly authorized peer representation.
			const owners = await source.ownerReferences(viewer, [ref.canonicalUri]);
			candidate = owners[0] ?? ref;
		}
		if (!candidate) return result;
		await this.restoreOwners(checkpoint, [candidate.canonicalUri]);
		const owner = checkpoint.merge.owners[candidate.canonicalUri];
		if (owner != null && owner !== candidate.source) return { ...result, resetRequired: true };
		const compare = this.compare(checkpoint.options);
		if (owner == null && checkpoint.windowHead && compare(candidate, checkpoint.windowHead) > 0) return { ...result, resetRequired: true };
		const items = await this.hydrate(viewer, checkpoint, [candidate], deadline, undefined, singleLocal);
		const item = items[0];
		if (!item || item.validForMs === 0) return result;
		// A concurrent import may have changed which representation owns this URI
		// while packing. Do not send a second representation at the wrong position.
		// Hydration already rebuilt the root and nested ACL after packing. Keep
		// the final live root/ownership check, without packing the body again.
		const currentOwners = await source.ownerCandidates(viewer, [candidate.canonicalUri]);
		if ((candidate.source === 'peer' && currentOwners.length > 0) || (candidate.source === 'local' && !currentOwners.some(value => value.noteId === candidate!.noteId))) return { ...result, resetRequired: true };
		checkpoint.merge.owners[candidate.canonicalUri] = candidate.source;
		if (!checkpoint.windowHead || compare(candidate, checkpoint.windowHead) < 0) checkpoint.windowHead = candidate;
		try {
			const merged = JSON.parse(await this.sessions.putSession(session, JSON.stringify(checkpoint), checkpoint.expires)) as Checkpoint;
			await this.restoreOwners(merged, [candidate.canonicalUri]);
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
		if (checkpoint.options.channelOrigin) {
			const selected = new Set(retained.map(ref => ref.canonicalUri));
			const relevant = changes.events.some(event => event.channelId ?
				(event.channelId === checkpoint.options.channelId && event.channelOrigin === checkpoint.options.channelOrigin) :
				(event.canonicalUri ? selected.has(event.canonicalUri) : !event.affectedUserId || event.affectedUserId === viewer.id));
			return { ...changes, resetRequired: changes.resetRequired || relevant || (!checkpoint.options.pinnedOnly &&
				await this.placements!.changedReplies(checkpoint.options.channelOrigin, checkpoint.options.channelId!,
					changes.events.flatMap(e => !e.channelId && e.noteId ? [e.noteId] : []), viewer.id)), inserts: [] as TimelineReference[] };
		}
		const channels = changes.events.flatMap(event => event.channelId && event.channelOrigin === this.peer?.origin ? [event.channelId] : []);
		const placementChanged = (checkpoint.options.kind === 'home' || checkpoint.options.kind === 'social' || checkpoint.options.kind === 'relay-social') && channels.length > 0 &&
			await this.placements?.followsAny(viewer.id, channels) === true;
		const ids = [...new Set(changes.events.flatMap(event => event.noteId ? [event.noteId] : []))];
		const candidates = checkpoint.options.kind !== 'favorites' && ids.length ? (await this.references.getMany(ids)).map(ref => ({ ...ref, source: 'local' as const })) : [];
		const readable = await this.localSource(checkpoint.options).hydrate(viewer, candidates);
		const visible = new Set(readable.map(row => row.reference.noteId));
		const retainedIds = new Set(retained.filter(ref => ref.source === 'local').map(ref => ref.noteId));
		const policy = changes.events.some(event => !event.channelId && !event.noteId && (!event.affectedUserId || event.affectedUserId === viewer.id));
		const updated = changes.events.some(event => event.noteId && (retainedIds.has(event.noteId) || visible.has(event.noteId)) && event.kind !== 'insert');
		await this.restoreOwners(checkpoint, changes.events.flatMap(event => event.kind !== 'insert' && event.canonicalUri ? [event.canonicalUri] : []));
		const ownerChanged = changes.events.some(event => event.kind !== 'insert' && event.canonicalUri != null && Object.hasOwn(checkpoint.merge.owners, event.canonicalUri));
		const inserts = candidates.filter(ref => visible.has(ref.noteId) && changes.events.some(event => event.noteId === ref.noteId && event.kind === 'insert'));
		return { ...changes, resetRequired: changes.resetRequired || placementChanged || policy || updated || ownerChanged ||
			(checkpoint.nextPolicyCheckAt != null && checkpoint.nextPolicyCheckAt <= Date.now()), inserts };
	}

	public async page(viewer: MiLocalUser, options: TimelineOptions, limit: number, cursor?: string, mode: 'unified' | 'local-fallback' = 'unified', anchor?: string, retained?: { previousSession: string; previousRevision: string; refs: string[]; anchorRef?: string }): Promise<TimelinePage> {
		const deadline = Date.now() + 8000;
		if (!this.peer) throw new GridspaceLinkError('UNAVAILABLE');
		if ((options.kind === 'channel') !== !!options.channelId || (options.kind === 'clip') !== !!options.clipId || (options.kind === 'antenna') !== !!options.antennaId ||
			(options.kind === 'profile' && !options.userId) || (options.kind === 'search' && !options.query?.trim()) ||
			(options.order === 'oldest' && options.kind !== 'clip') || (options.query && !['channel', 'clip', 'search'].includes(options.kind))) throw new GridspaceLinkError('INVALID_REQUEST');
		if (options.clipOrigin && (options.kind !== 'clip' || ![this.peer.origin, this.peer.peerOrigin].includes(options.clipOrigin))) throw new GridspaceLinkError('INVALID_REQUEST');
		if (options.channelOrigin && (options.kind !== 'channel' || !this.enabled ||
			![this.peer.origin, this.peer.peerOrigin].includes(options.channelOrigin))) throw new GridspaceLinkError('INVALID_REQUEST');
		if (options.channelOrigin && (options.query || options.rangeStartAt || options.rangeEndAt)) throw new GridspaceLinkError('INVALID_REQUEST');
		if (options.pinnedOnly && !options.channelOrigin) throw new GridspaceLinkError('INVALID_REQUEST');
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
			if ((options.kind === 'home' || options.kind === 'social' || options.kind === 'relay-social') && await this.placements?.supportHome()) {
				checkpoint.merge.localPlacement = { before: null, upper: null, ended: false, pending: [] };
				checkpoint.merge.peerPlacement = { before: null, upper: null, ended: mode !== 'unified', pending: [] };
			}
			checkpoint.nextPolicyCheckAt = await this.local.nextViewerPolicyCheck(viewer.id);
			let ref: TimelineReference | undefined;
			if (retained?.anchorRef) {
				try { ref = JSON.parse(openGridspaceSecret(this.peer, retained.anchorRef, `timeline-ref:${viewer.id}:${retained.previousSession}:${retained.previousRevision}`)); } catch { throw new GridspaceLinkError('INVALID_CURSOR'); }
				if (!ref || ref.canonicalUri !== anchor || !/^\d+$/.test(ref.sortAt)) throw new GridspaceLinkError('INVALID_CURSOR');
				const previous = await this.sessions.getSession(retained.previousSession);
				if (previous) {
					const prior = JSON.parse(previous) as Checkpoint;
					const orderedOptions = (value: TimelineOptions) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
					if (prior.viewerId !== viewer.id || prior.revision !== retained.previousRevision || prior.mode !== mode || orderedOptions(prior.options) !== orderedOptions(options)) throw new GridspaceLinkError('INVALID_CURSOR');
				}
			} else if (anchor && options.channelOrigin) {
				const page = await this.placements!.read(viewer, options.channelOrigin, { channelId: options.channelId, pinnedOnly: options.pinnedOnly, uris: [anchor], limit: 1 }, deadline);
				ref = page.references.find(row => row.canonicalUri === anchor);
				if (!ref && !options.pinnedOnly && mode === 'unified') {
					const other = options.channelOrigin === this.peer.origin ? this.peer.peerOrigin : this.peer.origin;
					const replies = await this.placements!.read(viewer, other, { channelId: options.channelId, replyChannelOrigin: options.channelOrigin, uris: [anchor], limit: 1 }, deadline);
					ref = replies.references.find(row => row.canonicalUri === anchor);
				}
			} else if (anchor && options.kind === 'clip' && this.clipReferences) {
				const pages = await Promise.all((['local', 'peer'] as const).map(source => this.clipReferences!.readPage(viewer, options, source, { limit: 1, uris: [anchor], deadline })));
				ref = pages.flatMap(page => page.references).find(row => row.canonicalUri === anchor);
			} else if (anchor) {
				const own = await this.localSource(options).ownerReferences(viewer, [anchor]);
				ref = own[0] ?? (mode === 'unified' ? (await this.delegated.timeline(viewer, { anchor, ...options, deadline })).references[0] : undefined);
			}
			// Retain only the listing position. Every page rechecks access to each body.
			if (ref && options.channelOrigin) {
				if (ref.placement?.channelOrigin !== options.channelOrigin || ref.placement.channelId !== options.channelId ||
					(options.pinnedOnly && ref.pinRank == null)) throw new GridspaceLinkError('INVALID_CURSOR');
				const upper = { sortAt: ref.sortAt, canonicalUri: ref.canonicalUri, pinRank: ref.pinRank };
				checkpoint.merge.local.upper = upper;
				checkpoint.merge.peer.upper = upper;
			} else if (ref) {
				const anchorAt = Number(BigInt(ref.sortAt) / 1000n);
				if (!Number.isSafeInteger(anchorAt) || anchorAt < 0 || anchorAt >= 4102444800000) throw new GridspaceLinkError('INVALID_CURSOR');
				if (options.kind === 'clip' && options.order === 'oldest') checkpoint.fromAt = anchorAt;
				else checkpoint.untilAt = anchorAt;
			}
			await this.sessions.start(viewer.id, checkpoint.session, JSON.stringify(checkpoint), checkpoint.expires);
			await this.store(checkpoint, position.id, true);
		}
		const states: TimelineSourceState[] = [{ source: 'local', status: 'ok', retryable: false }, { source: 'peer', status: mode === 'unified' ? 'ok' : 'disabled', retryable: false }];
		if (!checkpoint.selected) {
			const working = structuredClone(checkpoint);
			try {
				working.selected = await mergeTimeline(working.merge, limit, async (source, state) => {
					if (options.channelOrigin) {
						const expected = options.channelOrigin === this.peer!.origin ? 'local' : 'peer';
						if (source !== expected && (options.pinnedOnly || mode !== 'unified')) return { references: [], next: null, upper: null, ended: true };
						const origin = source === 'local' ? this.peer!.origin : this.peer!.peerOrigin;
						const page = await this.placements!.read(viewer, origin, { channelId: options.channelId!, pinnedOnly: options.pinnedOnly,
																																																																	...(source === expected ? {} : { replyChannelOrigin: options.channelOrigin }),
																																																																	before: state.before ?? undefined, upper: state.upper ?? undefined, limit: 50 }, deadline);
						if (source === 'peer') working.placementSequence ??= page.sequence;
						return { ...page, ended: !page.next };
					}
					if (options.kind === 'clip' && this.clipReferences) {
						const page = await this.clipReferences.readPage(viewer, options, source, { before: state.before ?? undefined, upper: state.upper ?? undefined, untilAt: working.untilAt, fromAt: working.fromAt, limit: 50, deadline });
						working.clipRevision ??= page.revision;
						return page;
					}
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
				}, () => Date.now() < deadline - 250, this.compare(options), async (source, state) => {
					const page = await this.placements!.read(viewer, source === 'local' ? this.peer!.origin : this.peer!.peerOrigin, {
						followed: true, before: state.before ?? undefined, upper: state.upper ?? undefined, untilAt: working.untilAt, limit: 50,
					}, deadline);
					if (source === 'peer') working.placementSequence ??= page.sequence;
					return { ...page, ended: !page.next };
				}, uris => this.sessions.getReferences(checkpoint.session, uris));
				working.nextId = [working.merge.local, working.merge.peer, working.merge.localPlacement, working.merge.peerPlacement]
					.some(lane => lane && (lane.pending.length || !lane.ended)) ? randomUUID() : null;
				working.windowHead ??= working.selected[0];
				// NX fixes both selection and next checkpoint for concurrent retries.
				checkpoint = JSON.parse(await this.sessions.claimResult(position.session, position.id, JSON.stringify(working), checkpoint.expires)) as Checkpoint;
				await this.restoreOwners(checkpoint, [...(checkpoint.selected ?? []), ...[checkpoint.merge.local, checkpoint.merge.peer, checkpoint.merge.localPlacement, checkpoint.merge.peerPlacement].flatMap(state => state?.pending ?? [])].map(ref => ref.canonicalUri));
				if (checkpoint.nextId) await this.store({ ...checkpoint, selected: undefined, nextId: undefined }, checkpoint.nextId, true);
				await this.store(checkpoint, position.id);
				await this.sessions.putSession(checkpoint.session, JSON.stringify(checkpoint), checkpoint.expires);
			} catch (error) {
				if (!(error instanceof GridspaceLinkError)) throw error;
				// A local checkpoint limit/expiry is recoverable with a fresh cursor;
				// it must not disable the peer source or discard its search results.
				if (error.code === 'INVALID_CURSOR' || error.code === 'CURSOR_EXPIRED') throw error;
				states[1] = { source: 'peer', status: ['AUTHORIZATION_REVOKED', 'LINK_REVOKED'].includes(error.code) ? 'unauthorized' : 'unavailable', retryable: true };
				return this.partialPage(viewer, checkpoint, position.id, limit, states);
			}
		}
		await this.assertOwners(viewer, checkpoint, checkpoint.selected!);
		let items: TimelineItem[];
		try { items = await this.hydrate(viewer, checkpoint, checkpoint.selected!, deadline); } catch (error) {
			if (!(error instanceof GridspaceLinkError) || error.code !== 'PEER_UNAVAILABLE' || (!options.channelOrigin && !checkpoint.merge.localPlacement)) throw error;
			states[1] = { source: 'peer', status: 'unavailable', retryable: true };
			return this.partialPage(viewer, checkpoint, position.id, limit, states);
		}
		await this.assertOwners(viewer, checkpoint, checkpoint.selected!);
		let rebound: TimelineReference[] = [];
		if (retained?.refs.length) {
			try { rebound = retained.refs.map(value => JSON.parse(openGridspaceSecret(this.peer!, value, `timeline-ref:${viewer.id}:${retained.previousSession}:${retained.previousRevision}`)) as TimelineReference); } catch { throw new GridspaceLinkError('INVALID_CURSOR'); }
		}
		const reboundOwners = await this.localSource(options).ownerReferences(viewer, rebound.filter(ref => ref.source === 'peer').map(ref => ref.canonicalUri));
		rebound = rebound.map(ref => reboundOwners.find(owner => owner.canonicalUri === ref.canonicalUri) ?? ref);
		const retainedItems = await this.hydrate(viewer, checkpoint, rebound, deadline);
		const visible = new Set([...items, ...retainedItems].map(item => item.key));
		const order = [...checkpoint.selected!, ...rebound].filter(ref => visible.has(ref.canonicalUri)).sort(this.compare(options)).map(ref => ref.canonicalUri).filter((key, index, all) => all.indexOf(key) === index);
		return { version: 1, session: checkpoint.session, revision: checkpoint.revision, items, retainedItems, order, nextCursor: checkpoint.nextId ? this.token(viewer, checkpoint, checkpoint.nextId) : null, updatesCursor: this.updatesToken(viewer, checkpoint), complete: true, mode, sources: states, revalidateAfterMs: TIMELINE_REVALIDATE_MS };
	}

	public async changes(viewer: MiLocalUser, input: { session: string; revision: string; updatesCursor: string; refs: string[]; phase: 'validate' | 'changes' }) {
		if (!this.peer) throw new GridspaceLinkError('UNAVAILABLE');
		let update: { sequence: string; peerSequence?: string; placementSequence?: string; expires: number };
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
		if (checkpoint.options.kind === 'clip' && this.clipReferences && input.phase === 'changes') {
			const page = await this.clipReferences.readPage(viewer, checkpoint.options, 'local', { limit: 1, deadline });
			peerChanged = checkpoint.clipRevision != null && page.revision != null && checkpoint.clipRevision !== page.revision;
			checkpoint.clipRevision = page.revision;
		}
		if (update.placementSequence && input.phase === 'changes') {
			const peer = await this.placements!.read(viewer, this.peer.peerOrigin, { channelId: checkpoint.options.channelId,
																																																																												followed: !checkpoint.options.channelOrigin, pinnedOnly: checkpoint.options.pinnedOnly,
																																																																												...(checkpoint.options.channelOrigin === this.peer.origin ? { replyChannelOrigin: this.peer.origin } : {}), uris: [], limit: 1, after: update.placementSequence }, deadline);
			peerChanged = peer.changed === true;
			checkpoint.placementSequence = peer.sequence;
		}
		if (!checkpoint.options.channelOrigin && checkpoint.options.kind !== 'clip' && input.phase === 'changes' && update.peerSequence) {
			const peerRefs = selected.filter(ref => ref.source === 'peer' && !ref.placement);
			peerStartedAt = Date.now();
			const peer = await this.delegated.timeline(viewer, { ids: peerRefs.map(ref => ref.noteId), candidates: peerRefs, sequence: update.peerSequence, ...checkpoint.options, deadline });
			authorizedPeer = peer;
			peerChanged ||= peer.changed;
			peerInserts = peer.newReferences;
			checkpoint.peerSequence = peer.sequence;
		}
		const owners = await this.localSource(checkpoint.options).ownerReferences(viewer, selected.filter(ref => ref.source === 'peer' && !ref.placement).map(ref => ref.canonicalUri));
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
