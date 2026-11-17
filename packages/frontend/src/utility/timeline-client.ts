/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, ref, shallowRef } from 'vue';
import type { Endpoints, entities } from 'misskey-js';
import type { GridspaceNoteEntry, GridspacePrivateNote } from '@/utility/gridspace-note-suspension.js';
import { isVisiblePrivateNote } from '@/utility/gridspace-note-suspension.js';
import { misskeyApi } from '@/utility/misskey-api.js';

export type TimelineQuery = { kind: string; [key: string]: unknown };
export type TimelineItem = {
	key: string;
	sortKey: { sortAt: string; uri: string };
	ref: string;
	representation: 'normal' | 'delegated';
	payload: entities.Note | GridspacePrivateNote;
	validForMs: number | null;
	nextPolicyCheckAt?: string | null;
};
export type TimelineSource = { source: 'local' | 'peer'; status: 'ok' | 'unavailable' | 'unauthorized' | 'disabled'; retryable: boolean };
export type TimelineResponse = {
	version: 1;
	session: string;
	revision: string;
	items: TimelineItem[];
	nextCursor: string | null;
	updatesCursor: string;
	complete: boolean;
	mode: 'unified' | 'local-fallback';
	sources: TimelineSource[];
	revalidateAfterMs: number;
	resetRequired?: boolean;
	replaceWindow?: boolean;
	removed?: string[];
	newItems?: TimelineItem[];
	order?: string[];
	retainedItems?: TimelineItem[];
};
export type TimelineStreamEvent = { session: string; revision: string; item?: TimelineItem; resetRequired?: boolean; leaseElapsedMs?: number; leaseId?: string; leaseStartedAt?: number };
type RowBase = { key: string; createdAt: string; leased: boolean };
export type TimelineDisplayRow = RowBase & (
	| { kind: 'normal'; note: entities.Note & { _shouldInsertAd_?: boolean } }
	| { kind: 'private'; note: GridspaceNoteEntry }
	| { kind: 'placeholder' }
);
type RetainedItem = Omit<TimelineItem, 'payload'> & {
	id: string;
	createdAt: string;
	payload?: TimelineItem['payload'];
	expiresAt: number | null;
	visible: boolean;
	displayPayload?: TimelineItem['payload'];
};
type StreamArrival = { version: number; item: RetainedItem; session: string; revision: string };
type Request = (endpoint: 'gridspace/timeline' | 'gridspace/timeline/changes', params: Record<string, unknown>, signal: AbortSignal) => Promise<TimelineResponse>;

const request: Request = (endpoint, params, signal) => misskeyApi(endpoint as keyof Endpoints, params as never, undefined, signal) as Promise<TimelineResponse>;

/** Owns server cursors and authorization leases, but never combines source timelines. */
export class TimelineClient {
	private visibleItems: RetainedItem[] = [];
	private queuedItems: RetainedItem[] = [];
	private session: string | null = null;
	private revision: string | null = null;
	private nextCursor: string | null = null;
	private updatesCursor: string | null = null;
	private generation = 0;
	private controller = new AbortController();
	private active = true;
	private disposed = false;
	private expireTimer: number | null = null;
	private refreshTimer: number | null = null;
	private refreshAt = Infinity;
	private lastRequestStartedAt = -Infinity;
	private lastCycleDuration = 0;
	private refreshRequested = false;
	private refreshDelay = 30000;
	private invalidationAt = Infinity;
	private pending: Promise<void> | null = null;
	private streamVersion = 0;
	private streamDuringRequest = new Map<string, StreamArrival>();
	private streamResetRequested = false;
	private queuedRelease = false;
	private queueOverflow = false;
	private degraded = false;
	private mode: 'unified' | 'local-fallback' = 'unified';
	private noteAdvertisements = new Map<string, boolean>();
	private unsubscribe: (() => void) | null = null;
	private streamLeaseStartedAt = 0;
	private resumeDisplayUntil = 0;
	public rows = shallowRef<TimelineDisplayRow[]>([]);
	private displayItems(items: RetainedItem[]): TimelineDisplayRow[] {
		return items.filter(item => item.visible).map(item => {
			const base = { key: item.key, createdAt: item.createdAt, leased: item.expiresAt !== null };
			if (item.representation === 'normal') return item.payload ? { ...base, kind: 'normal', note: (item.displayPayload ?? item.payload) as entities.Note } : { ...base, kind: 'placeholder' };
			const note: GridspaceNoteEntry = (item.displayPayload ?? item.payload) as GridspacePrivateNote | undefined ?? {
				id: item.id, uri: item.key, createdAt: item.createdAt, suspended: true, visible: item.visible,
			};
			return { ...base, kind: 'private', note };
		});
	}
	public queuedCount = ref(0);
	public loading = ref(false);
	public busy = ref(false);
	public error = ref(false);
	public failed = ref(false);
	public hasMore = ref(false);
	public pagingKey = ref(0);
	public sources = shallowRef<TimelineSource[]>([]);
	public needsAuthorization = computed(() => this.sources.value.some(source => source.status === 'unauthorized'));

	constructor(private query: TimelineQuery, private options: {
		isTop?: () => boolean;
		isPaused?: () => boolean;
		withSensitive?: () => boolean;
		request?: Request;
		now?: () => number;
		onNewItems?: (items: TimelineDisplayRow[]) => void;
		prepareNote?: (note: entities.Note) => entities.Note;
		anchor?: () => string | undefined;
		beforeReplace?: () => void;
		afterReplace?: () => void;
		subscribe?: (params: { session: string; revision: string; updatesCursor: string }, invalidate: () => void, reconnect: () => void, note: (event: TimelineStreamEvent) => void) => () => void;
	} = {}) {}

	private now() { return this.options.now?.() ?? performance.now(); }
	private usable() { return this.active && !this.disposed && !window.document.hidden; }
	private publish() {
		this.queuedCount.value = this.queuedItems.filter(item => item.visible).length || (this.queueOverflow ? 1 : 0);
		this.rows.value = this.displayItems(this.visibleItems);
		this.scheduleExpiry();
	}
	private queue(items: RetainedItem[]) {
		this.queueOverflow ||= items.length > 100;
		this.queuedItems = items.slice(0, 100);
	}
	private retain(item: TimelineItem, startedAt: number): RetainedItem {
		// Missing delegated leases fail closed. Never extend a lease by response latency.
		const lifetime = item.validForMs === null && item.representation === 'normal' ? null :
			Number.isFinite(item.validForMs) ? Math.max(0, item.validForMs!) : 0;
		const expiresAt = lifetime === null ? null : startedAt + lifetime;
		const { payload, ...reference } = item;
		const accepted = expiresAt === null || expiresAt > this.now();
		let displayPayload: entities.Note | undefined;
		if (accepted && item.representation === 'normal' && this.options.prepareNote) {
			displayPayload = structuredClone(payload as entities.Note);
			if (!this.noteAdvertisements.has(item.key)) {
				displayPayload = this.options.prepareNote(displayPayload);
				this.noteAdvertisements.set(item.key, (displayPayload as entities.Note & { _shouldInsertAd_?: boolean })._shouldInsertAd_ === true);
			} else if (this.noteAdvertisements.get(item.key)) (displayPayload as entities.Note & { _shouldInsertAd_?: boolean })._shouldInsertAd_ = true;
		}
		return {
			...reference, id: payload.id, createdAt: (payload as { collectionAt?: string }).collectionAt ?? payload.createdAt, expiresAt,
			visible: item.representation === 'normal' || isVisiblePrivateNote(payload as GridspacePrivateNote, this.options.withSensitive?.() ?? true),
			...(accepted ? { payload } : {}),
			...(displayPayload ? { displayPayload } : {}),
		};
	}
	private scheduleExpiry() {
		if (this.expireTimer !== null) window.clearTimeout(this.expireTimer);
		this.expireTimer = null;
		const deadlines = [...this.visibleItems, ...this.queuedItems, ...[...this.streamDuringRequest.values()].map(event => event.item)].filter(item => item.payload && item.expiresAt !== null).map(item => Math.max(item.expiresAt!, this.resumeDisplayUntil));
		if (!deadlines.length || this.disposed || !this.active || window.document.hidden) return;
		this.expireTimer = window.setTimeout(() => this.expire(), Math.max(0, Math.min(...deadlines) - this.now()));
	}
	private expire(all = false) {
		if (!all && (!this.active || window.document.hidden)) { this.scheduleExpiry(); return; }
		let changed = false;
		for (const item of [...this.visibleItems, ...this.queuedItems]) {
			if (item.payload && item.expiresAt !== null && (all || Math.max(item.expiresAt, this.resumeDisplayUntil) <= this.now())) {
				delete item.payload;
				delete item.displayPayload;
				changed = true;
			}
		}
		for (const event of this.streamDuringRequest.values()) {
			if (event.item.expiresAt !== null && (all || Math.max(event.item.expiresAt, this.resumeDisplayUntil) <= this.now())) {
				delete event.item.payload; delete event.item.displayPayload;
			}
		}
		if (changed) this.publish();
		else this.scheduleExpiry();
	}
	private scheduleRefresh(delay: number) {
		if (!this.usable()) return;
		this.refreshDelay = Number.isFinite(delay) ? Math.max(1000, Math.min(30000, delay)) : 30000;
		this.refreshRequested = true;
		if (this.pending) return;
		this.armRefresh();
	}
	private armRefresh() {
		if (!this.usable() || !this.refreshRequested) return;
		// Push invalidations run promptly; the timer only recovers lost events.
		// Keep enough room for both validation and a replacement-window request.
		const deadline = Math.min(...[...this.visibleItems, ...this.queuedItems].filter(item => item.payload && item.expiresAt !== null).map(item => item.expiresAt!));
		const margin = Math.max(2000, this.lastCycleDuration * 2 + 1000);
		const at = Math.max(this.now(), Math.min(this.invalidationAt, this.lastRequestStartedAt + this.refreshDelay, this.failed.value ? Infinity : deadline - margin));
		if (this.refreshTimer !== null && this.refreshAt <= at) return;
		this.clearScheduledRefresh();
		this.refreshAt = at;
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null; this.refreshAt = Infinity;
			this.refreshRequested = false;
			this.invalidationAt = Infinity;
			void this.refresh();
		}, Math.max(0, at - this.now()));
	}
	private clearScheduledRefresh() {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = null; this.refreshAt = Infinity;
	}
	private async fetch(endpoint: Parameters<Request>[0], params: Record<string, unknown>) {
		this.clearScheduledRefresh();
		const startedAt = this.now();
		this.lastRequestStartedAt = startedAt;
		this.refreshRequested = false;
		this.invalidationAt = Infinity;
		const streamVersion = this.streamVersion;
		const result = await (this.options.request ?? request)(endpoint, params, AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]));
		if (result.version !== 1 || !Array.isArray(result.items)) throw new Error('Unsupported timeline response');
		return { result, startedAt, streamVersion };
	}
	private acceptHeader(result: TimelineResponse, updateCursor = true) {
		const changedSession = this.session !== result.session || this.revision !== result.revision;
		this.session = result.session; this.revision = result.revision;
		if (updateCursor) this.updatesCursor = result.updatesCursor;
		this.sources.value = result.sources;
		this.mode = result.mode;
		this.degraded = !result.complete || result.mode === 'local-fallback';
		this.error.value = this.degraded;
		this.failed.value = false;
		if (changedSession) { this.unsubscribe?.(); this.unsubscribe = null; }
		if (!this.unsubscribe && this.options.subscribe && this.usable()) {
			this.streamLeaseStartedAt = this.now();
			this.unsubscribe = this.options.subscribe({ session: result.session, revision: result.revision, updatesCursor: result.updatesCursor }, () => {
				this.invalidationAt = Math.min(this.invalidationAt, this.now() + 100);
				this.refreshRequested = true;
				if (!this.pending) this.armRefresh();
			}, () => { void this.refresh(); }, this.receive);
		}
		this.scheduleRefresh(result.revalidateAfterMs);
	}
	private async run(action: (generation: number) => Promise<void>) {
		if (this.pending || !this.usable()) return this.pending ?? Promise.resolve();
		const current = this.generation;
		const startedAt = this.now();
		this.busy.value = true;
		const pending = action(current).catch(async error => {
			if (current !== this.generation) return;
			let reason = (error as { info?: { reason?: string } } | null)?.info?.reason;
			if (reason === 'INVALID_CURSOR' || reason === 'CURSOR_EXPIRED') {
				try { await this.readWindow(current, true); return; } catch (recoveryError) {
					reason = (recoveryError as { info?: { reason?: string } } | null)?.info?.reason;
				}
			}
			if (current !== this.generation) return;
			this.error.value = true;
			this.failed.value = true;
			// A connection failure is not revocation. Retain already-authorized
			// bodies until their bounded lease expires; actual revocation is immediate.
			this.expire(reason === 'AUTHORIZATION_REVOKED' || reason === 'LINK_REVOKED');
			this.scheduleRefresh(8000);
		}).finally(() => {
			if (this.pending !== pending) return;
			this.pending = null; this.busy.value = false; this.loading.value = false;
			this.lastCycleDuration = this.now() - startedAt;
			this.streamDuringRequest.clear();
			if (this.streamResetRequested) {
				this.streamResetRequested = false; void this.refresh();
			}
			this.armRefresh();
			this.pagingKey.value++;
		});
		this.pending = pending;
		return pending;
	}
	private async readWindow(current: number, preserve: boolean, mode: 'unified' | 'local-fallback' = 'unified') {
		if (preserve && this.queueOverflow && (this.queuedRelease || (this.options.isTop?.() ?? true))) {
			await this.readWindow(current, false, mode); return;
		}
		const previous = new Set(this.visibleItems.map(item => item.key));
		const windowStreamVersion = this.streamVersion;
		const restoreHistory = preserve && mode === 'unified' && this.visibleItems.length > 1;
		const historyStart = restoreHistory ? this.visibleItems[0] : undefined;
		const historyEnd = restoreHistory ? this.visibleItems.at(-1) : undefined;
		let anchor = historyStart?.key ?? this.options.anchor?.() ?? this.visibleItems[0]?.key;
		const retained = preserve && this.session && this.revision && (this.queuedItems.length || historyStart) ? {
			previousSession: this.session, previousRevision: this.revision, retainedRefs: this.queuedItems.slice(0, 100).map(item => item.ref),
			...(historyStart ? { anchorRef: historyStart.ref } : {}),
		} : {};
		let response = await this.fetch('gridspace/timeline', { ...this.query, mode, ...retained, ...(preserve && anchor ? { anchor } : {}), limit: 30 });
		let reboundStartedAt = response.startedAt;
		const windowRows = response.result.items.map(item => ({ item, startedAt: response.startedAt }));
		if (historyEnd) {
			const initial = response.result;
			const requireComplete = () => {
				if (response.result.sources.some(source => source.status === 'unauthorized')) throw Object.assign(new Error('Timeline authorization revoked'), { info: { reason: 'AUTHORIZATION_REVOKED' } });
				if (!response.result.complete) throw new Error('Incomplete history restoration');
			};
			requireComplete();
			const cursors = new Set<string>();
			const ascending = this.query.kind === 'clip' && this.query.order === 'oldest';
			const complete = () => windowRows.some(row => row.item.key === historyEnd.key) ||
				windowRows.some(row => ascending ? BigInt(row.item.sortKey.sortAt) > BigInt(historyEnd.sortKey.sortAt) : BigInt(row.item.sortKey.sortAt) < BigInt(historyEnd.sortKey.sortAt));
			while (response.result.nextCursor && !complete()) {
				if (current !== this.generation || !this.usable()) return;
				if (cursors.size >= 64 || cursors.has(response.result.nextCursor)) throw new Error('Incomplete history restoration');
				cursors.add(response.result.nextCursor);
				response = await this.fetch('gridspace/timeline', { ...this.query, mode, cursor: response.result.nextCursor, limit: 30 });
				requireComplete();
				if (response.result.session !== initial.session || response.result.revision !== initial.revision) throw new Error('History changed during restoration');
				windowRows.push(...response.result.items.map(item => ({ item, startedAt: response.startedAt })));
			}
			// Publish atomically only after the old range has been reauthorized.
			// Pagination continues after its oldest page, not the viewport's anchor.
			response = { ...response, result: { ...initial, nextCursor: response.result.nextCursor,
				order: [...new Set([...(initial.order ?? initial.items.map(item => item.key)), ...windowRows.map(row => row.item.key)])],
			} };
		}
		// Do not replace the window the user scrolled into while the request was
		// pending. Re-anchor once; continued scrolling keeps the old window intact.
		if (preserve && !restoreHistory && current === this.generation && this.usable()) {
			const liveAnchor = this.options.anchor?.();
			if (liveAnchor && liveAnchor !== anchor && !response.result.items.some(item => item.key === liveAnchor)) {
				anchor = liveAnchor;
				response = await this.fetch('gridspace/timeline', { ...this.query, mode, ...retained, anchor, limit: 30 });
				reboundStartedAt = response.startedAt;
				windowRows.splice(0, windowRows.length, ...response.result.items.map(item => ({ item, startedAt: response.startedAt })));
				const latestAnchor = this.options.anchor?.();
				if (latestAnchor && latestAnchor !== anchor && !response.result.items.some(item => item.key === latestAnchor)) {
					this.scheduleRefresh(1000); return;
				}
			}
		}
		const { result } = response;
		if (current !== this.generation || !this.usable()) return;
		if (preserve) this.options.beforeReplace?.();
		const seen = new Set<string>();
		const items = windowRows.flatMap(row => {
			if (seen.has(row.item.key)) return [];
			seen.add(row.item.key);
			return [this.retain(row.item, row.startedAt)];
		});
		const rebound = (result.retainedItems ?? []).map(item => this.retain(item, reboundStartedAt));
		const reboundKeys = new Set(rebound.map(item => item.key));
		const firstKnown = items.findIndex(item => previous.has(item.key));
		if (preserve && !(this.options.isTop?.() ?? true) && firstKnown > 0) {
			const queued = new Map([...rebound, ...items.slice(0, firstKnown)].map(item => [item.key, item]));
			this.queue(result.order ? result.order.flatMap(key => queued.has(key) ? [queued.get(key)!] : []) : [...queued.values()]);
			this.visibleItems = items.slice(firstKnown).filter(item => !reboundKeys.has(item.key));
		} else if (preserve && !(this.options.isTop?.() ?? true)) {
			this.queue(rebound);
			this.visibleItems = items.filter(item => !reboundKeys.has(item.key));
		} else {
			this.visibleItems = items; this.queuedItems = [];
			this.queueOverflow = false; this.queuedRelease = false;
		}
		if (preserve && !restoreHistory) {
			const incoming = items.filter(item => !previous.has(item.key));
			if (incoming.length) this.options.onNewItems?.(this.displayItems(incoming));
		}
		this.nextCursor = result.nextCursor; this.hasMore.value = this.nextCursor !== null;
		this.acceptHeader(result); this.publish();
		for (const event of this.streamDuringRequest.values()) {
			if (event.version <= windowStreamVersion) continue;
			if (event.session === result.session && event.revision === result.revision) this.insertStreamItem(event.item);
			else if (!items.some(item => item.key === event.item.key)) {
				this.queueOverflow = true;
				if ((this.options.isTop?.() ?? true) && !this.options.isPaused?.()) { this.queuedRelease = true; this.streamResetRequested = true; }
			}
		}
		this.publish();
		if (preserve) this.options.afterReplace?.();
	}
	public reload = async () => {
		this.cancel();
		this.noteAdvertisements.clear();
		this.queueOverflow = false; this.queuedRelease = false;
		this.visibleItems = []; this.queuedItems = []; this.session = null; this.revision = null;
		this.nextCursor = null; this.updatesCursor = null; this.error.value = false; this.failed.value = false; this.hasMore.value = false;
		this.publish(); this.loading.value = true;
		await this.run(current => this.readWindow(current, false));
	};
	public load = async () => {
		if (!this.nextCursor) return;
		await this.run(async current => {
			if (this.degraded && this.mode === 'unified') { await this.readWindow(current, true, 'local-fallback'); return; }
			const { result, startedAt } = await this.fetch('gridspace/timeline', { ...this.query, mode: this.mode, cursor: this.nextCursor, limit: 30 });
			if (current !== this.generation || !this.usable()) return;
			if (result.session !== this.session || result.revision !== this.revision || result.resetRequired) {
				await this.readWindow(current, true); return;
			}
			const retained = new Set([...this.visibleItems, ...this.queuedItems].map(item => item.key));
			this.visibleItems.push(...result.items.filter(item => !retained.has(item.key)).map(item => this.retain(item, startedAt)));
			this.nextCursor = result.nextCursor; this.hasMore.value = this.nextCursor !== null;
			this.acceptHeader(result, false); this.publish();
		});
	};
	public refresh = async () => {
		if (!this.session || !this.updatesCursor) { await this.reload(); return; }
		await this.run(async current => {
			if (this.queueOverflow && this.queuedRelease) { await this.readWindow(current, false); return; }
			if (this.degraded) { await this.readWindow(current, true); return; }
			const retained = [...this.visibleItems, ...this.queuedItems].map(item => item.ref);
			for (let offset = 0; offset < Math.max(1, retained.length); offset += 100) {
				const final = offset + 100 >= retained.length;
				const { result, startedAt, streamVersion } = await this.fetch('gridspace/timeline/changes', {
					session: this.session, revision: this.revision, updatesCursor: this.updatesCursor,
					refs: retained.slice(offset, offset + 100), phase: final ? 'changes' : 'validate',
				});
				if (current !== this.generation || !this.usable()) return;
				if (result.session !== this.session || result.revision !== this.revision) {
					await this.readWindow(current, true); return;
				}
				const replacements = new Map(result.items.map(item => [item.key, this.retain(item, startedAt)]));
				const removed = new Set(result.removed ?? []);
				const update = (items: RetainedItem[]) => items.flatMap(item => {
					if ((this.streamDuringRequest.get(item.key)?.version ?? 0) > streamVersion) return [item];
					return removed.has(item.key) ? [] : [replacements.get(item.key) ?? item];
				});
				this.visibleItems = update(this.visibleItems); this.queuedItems = update(this.queuedItems);
				// Reset requests still contain freshly authorized retained rows. Apply
				// removals and renewed leases before waiting for the replacement window.
				if (result.resetRequired) {
					this.publish();
					await this.readWindow(current, true); return;
				}
				if (final) {
					const known = new Set([...this.visibleItems, ...this.queuedItems].map(item => item.key));
					const incoming = (result.newItems ?? []).filter(item => !known.has(item.key)).map(item => this.retain(item, startedAt));
					if (incoming.length && this.streamVersion > streamVersion) {
						// HTTP rows and later stream rows do not carry a shared insertion
						// position. Let a fresh server window establish their order.
						await this.readWindow(current, true); return;
					}
					if (incoming.length) this.options.onNewItems?.(this.displayItems(incoming));
					if (this.options.isTop?.() ?? true) this.visibleItems = [...incoming, ...this.visibleItems];
					else this.queue([...incoming, ...this.queuedItems]);
					this.acceptHeader(result);
				}
				this.publish();
			}
			if (this.queuedRelease) this.releaseQueue();
		});
	};
	private insertStreamItem(item: RetainedItem) {
		if (item.expiresAt !== null && item.expiresAt <= this.now()) { delete item.payload; delete item.displayPayload; }
		const visible = this.visibleItems.findIndex(row => row.key === item.key);
		if (visible >= 0) { this.visibleItems[visible] = item; return; }
		const queued = this.queuedItems.findIndex(row => row.key === item.key);
		if (queued >= 0) { this.queuedItems[queued] = item; return; }
		if ((this.options.isTop?.() ?? true) && !this.options.isPaused?.()) this.visibleItems.unshift(item);
		else this.queue([item, ...this.queuedItems]);
	}
	public receive = (event: TimelineStreamEvent) => {
		if (!this.usable() || event.session !== this.session || event.revision !== this.revision) return;
		if (event.resetRequired) {
			if (this.pending) this.streamResetRequested = true;
			else void this.refresh();
			return;
		}
		if (!event.item) return;
		const known = [...this.visibleItems, ...this.queuedItems].some(item => item.key === event.item!.key);
		const clockBase = event.leaseStartedAt ?? this.streamLeaseStartedAt;
		const startedAt = Number.isFinite(event.leaseElapsedMs) && event.leaseElapsedMs! >= 0 ? Math.min(this.now(), clockBase + event.leaseElapsedMs!) : -Infinity;
		const item = this.retain(event.item, startedAt);
		this.streamVersion++;
		if (this.pending) {
			this.streamDuringRequest.set(item.key, { version: this.streamVersion, item, session: event.session, revision: event.revision });
			if (this.streamDuringRequest.size > 100) {
				this.streamDuringRequest.delete(this.streamDuringRequest.keys().next().value!);
				this.queueOverflow = true;
			}
		}
		this.insertStreamItem(item);
		if (!known) this.options.onNewItems?.(this.displayItems([item]));
		this.publish();
	};
	public retry = () => this.session ? this.refresh() : this.reload();
	public releaseQueue = async () => {
		if (!this.usable()) return;
		if (this.queueOverflow) {
			// The update cursor has passed rows beyond the bounded queue. Start a
			// fresh history session at the head so its pages recover those rows.
			this.queuedRelease = true;
			if (this.pending) await this.pending;
			if (!this.usable() || !this.queueOverflow) return;
			await this.run(current => this.readWindow(current, false));
			return;
		}
		this.expire();
		if (this.queuedItems.some(item => item.expiresAt !== null && !item.payload)) {
			this.queuedRelease = true; void this.refresh(); return;
		}
		this.queuedRelease = false;
		this.visibleItems = [...this.queuedItems, ...this.visibleItems]; this.queuedItems = [];
		this.publish();
	};
	public removeNormal = (id: string) => this.remove(item => item.representation === 'normal' && item.id === id);
	public removePrivate = (id: string) => this.remove(item => item.representation === 'delegated' && item.id === id);
	private remove(predicate: (item: RetainedItem) => boolean) {
		this.visibleItems = this.visibleItems.filter(item => !predicate(item)); this.queuedItems = this.queuedItems.filter(item => !predicate(item)); this.publish();
	}
	private cancel() {
		this.unsubscribe?.(); this.unsubscribe = null;
		this.generation++; this.controller.abort(); this.controller = new AbortController(); this.pending = null;
		this.busy.value = false; this.loading.value = false;
		this.refreshRequested = false;
		this.streamDuringRequest.clear(); this.streamResetRequested = false;
		this.clearScheduledRefresh();
	}
	public suspend = () => { this.active = false; this.cancel(); this.scheduleExpiry(); };
	public resume = async () => {
		// Keep the last rendered snapshot while the foreground check runs. This
		// is display-only: new responses and explicit revocations still apply
		// immediately, and an unavailable server cannot prolong it past 15s.
		if (!this.active) this.resumeDisplayUntil = this.now() + 15000;
		this.active = true; this.expire();
		try { await this.refresh(); } finally { this.resumeDisplayUntil = 0; this.expire(); }
	};
	public fail = () => { this.error.value = true; this.failed.value = true; this.expire(true); };
	public dispose = () => {
		this.suspend(); this.expire(true); this.disposed = true;
		if (this.expireTimer !== null) window.clearTimeout(this.expireTimer);
		this.visibleItems = []; this.queuedItems = []; this.publish();
		this.noteAdvertisements.clear();
	};
}
