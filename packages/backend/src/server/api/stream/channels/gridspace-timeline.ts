/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { includesDefault } from '@/misc/note-distribution.js';
import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { InternalEventTypes, EventTypesToEventPayload } from '@/core/GlobalEventService.js';
import { GridspaceTimelineService } from '@/core/gridspace/timeline/GridspaceTimelineService.js';
import type { TimelineStreamEvent } from '@/core/gridspace/timeline/GridspaceTimelineService.js';
import type { Packed } from '@/misc/json-schema.js';
import type { MiLocalUser } from '@/models/User.js';
import { GridspaceIdentityService } from '@/core/gridspace/GridspaceIdentityService.js';
import type { TimelineOptions } from '@/core/gridspace/timeline/timeline-protocol.js';
import { resoniteRelayHosts } from '@/core/gridspace/timeline/relay-hosts.js';
import type { JsonObject } from '@/misc/json-value.js';
import { bindThis } from '@/decorators.js';
import Channel, { type ChannelRequest } from '../channel.js';

@Injectable({ scope: Scope.TRANSIENT })
export class GridspaceTimelineChannel extends Channel {
	public readonly chName = 'gridspaceTimeline';
	public static shouldShare = false;
	public static requireCredential = true as const;
	public static kind = null;
	private lastSent = 0;
	private invalidateTimer: ReturnType<typeof setTimeout> | undefined;
	private session = '';
	private revision = '';
	private leaseId = '';
	private streamStarted = 0;
	private disposed = false;
	private draining = false;
	private readonly pending = new Map<string, TimelineStreamEvent>();
	private options: TimelineOptions | null = null;
	private linkedUserId: string | null = null;
	constructor(@Inject(REQUEST) request: ChannelRequest, private timeline: GridspaceTimelineService, private identity: GridspaceIdentityService) { super(request); }
	@bindThis
	public async init(params: JsonObject): Promise<boolean> {
		this.streamStarted = performance.now();
		if (!this.user || this.connection.token || typeof params.session !== 'string' || typeof params.revision !== 'string' || typeof params.updatesCursor !== 'string' || typeof params.leaseId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(params.leaseId)) return false;
		if (!await this.timeline.authorizeSubscription(this.user, params.session, params.revision, params.updatesCursor)) return false;
		this.session = params.session;
		this.revision = params.revision;
		this.leaseId = params.leaseId;
		this.options = await this.timeline.streamContext(this.user, this.session, this.revision);
		if (!this.options) return false;
		this.linkedUserId = await this.identity.linkedUserId(this.user.id);
		this.subscriber.on('internal', this.onInternal);
		this.subscriber.on('notesStream', this.onNote);
		return true;
	}
	@bindThis
	private async onNote(note: Packed<'Note'>) {
		const options = this.options!;
		if (options.withFiles && !note.fileIds?.length) return;
		if (options.kind === 'home' || options.kind === 'social' || options.kind === 'relay-social') {
			const self = note.userId === this.user!.id || (note.userId === this.linkedUserId && (note.visibility === 'public' || note.visibility === 'home'));
			const relay = options.kind === 'relay-social' && note.visibility === 'public' && (note.user.host == null || resoniteRelayHosts.includes(note.user.host)) && (options.withLocalOnly !== false || !note.localOnly);
			const ordinary = includesDefault(note) && (self || Object.hasOwn(this.following, note.userId) ||
				relay || (options.kind === 'social' && note.visibility === 'public' && (note.user.host == null || note.gridspaceShared)));
			if (!ordinary && !await this.hasFollowedChannelPlacement(note)) return;
			if (!this.isNoteVisibleForMe(note) || this.isNoteMutedOrBlocked(note)) return;
		} else if (options.kind === 'channel') {
			if (!await this.hasLocalChannelPlacement(note, options.channelId ? [options.channelId] : [], true)) return;
		} else if (options.kind === 'mentions' || options.kind === 'direct') {
			if (!note.mentions?.includes(this.user!.id) && !note.visibleUserIds?.includes(this.user!.id)) return;
			if (options.kind === 'direct' && note.visibility !== 'specified') return;
		}
		this.enqueue({ source: 'local', noteId: note.id });
	}
	private enqueue(event: TimelineStreamEvent) {
		if (this.disposed || !/^[a-zA-Z0-9]{1,32}$/.test(event.noteId)) return;
		if (this.pending.size >= 100) { this.pending.clear(); this.send('invalidate', {}); return; }
		this.pending.set(`${event.source}:${event.noteId}`, event);
		void this.drain();
	}
	private async drain() {
		if (this.draining) return;
		this.draining = true;
		try {
			while (!this.disposed && this.pending.size) {
				const [key, event] = this.pending.entries().next().value!;
				try {
					const result = await this.timeline.streamNote(this.user! as MiLocalUser, this.session, this.revision, event);
					if (!this.disposed && (result.item || result.resetRequired)) this.send('note', { ...result, leaseId: this.leaseId, leaseElapsedMs: Math.floor(performance.now() - this.streamStarted) } as unknown as JsonObject);
				} catch {
					if (!this.disposed) this.send('invalidate', {});
				} finally { this.pending.delete(key); }
			}
		} finally { this.draining = false; }
	}
	@bindThis
	private onInternal(data: EventTypesToEventPayload<InternalEventTypes>) {
		if (data.type === 'gridspaceTimelineNote') { this.enqueue({ source: 'peer', noteId: data.body.noteId }); return; }
		if (data.type !== 'gridspaceTimelineChanged' || this.invalidateTimer || this.disposed) return;
		// Coalesce bursts, but preserve the trailing change instead of dropping it.
		this.invalidateTimer = setTimeout(() => {
			this.invalidateTimer = undefined;
			if (this.disposed) return;
			this.lastSent = Date.now();
			// No global position, source identity, body or private ref is sent.
			this.send('invalidate', {});
		}, Math.max(0, 1000 - (Date.now() - this.lastSent)));
	}
	@bindThis
	public dispose() { this.disposed = true; clearTimeout(this.invalidateTimer); this.pending.clear(); this.subscriber.off('internal', this.onInternal); this.subscriber.off('notesStream', this.onNote); }
}
