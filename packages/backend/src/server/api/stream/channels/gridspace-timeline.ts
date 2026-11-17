/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { InternalEventTypes, EventTypesToEventPayload } from '@/core/GlobalEventService.js';
import { GridspaceTimelineService } from '@/core/gridspace/timeline/GridspaceTimelineService.js';
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
	constructor(@Inject(REQUEST) request: ChannelRequest, private timeline: GridspaceTimelineService) { super(request); }
	@bindThis
	public async init(params: JsonObject): Promise<boolean> {
		if (!this.user || this.connection.token || typeof params.session !== 'string' || typeof params.revision !== 'string' || typeof params.updatesCursor !== 'string') return false;
		if (!await this.timeline.authorizeSubscription(this.user, params.session, params.revision, params.updatesCursor)) return false;
		this.subscriber.on('internal', this.onInternal);
		return true;
	}
	@bindThis
	private onInternal(data: EventTypesToEventPayload<InternalEventTypes>) {
		if (data.type !== 'gridspaceTimelineChanged' || Date.now() - this.lastSent < 8000) return;
		this.lastSent = Date.now();
		// A hint only. No global position, source identity, body or private ref is sent.
		this.send('invalidate', {});
	}
	@bindThis
	public dispose() { this.subscriber.off('internal', this.onInternal); }
}
