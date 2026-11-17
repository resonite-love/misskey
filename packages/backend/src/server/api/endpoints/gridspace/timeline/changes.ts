/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspaceTimelineService } from '@/core/gridspace/timeline/GridspaceTimelineService.js';
import { timelineItemSchema, timelinePageProperties } from '@/core/gridspace/timeline/timeline-protocol.js';

const text = { type: 'string', optional: false, nullable: false } as const;
export const meta = {
	tags: ['notes'], requireCredential: true, secure: true,
	limit: { duration: 60000, max: 180 },
	errors: { unavailable: { message: 'Unified timeline session is unavailable.', code: 'GRIDSPACE_TIMELINE_SESSION_UNAVAILABLE', id: '2cc195e6-3156-4ed5-84cb-bdca1d8199a1' } },
	res: { type: 'object', optional: false, nullable: false, properties: {
		...timelinePageProperties,
		newItems: { type: 'array', optional: false, nullable: false, items: timelineItemSchema },
		removed: { type: 'array', optional: false, nullable: false, items: text }, order: { type: 'array', optional: false, nullable: false, items: text },
		replaceWindow: { type: 'boolean', optional: false, nullable: false }, resetRequired: { type: 'boolean', optional: false, nullable: false },
	} },
} as const;
export const paramDef = { type: 'object', properties: {
	session: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' }, revision: { type: 'string', maxLength: 32 }, updatesCursor: { type: 'string', minLength: 1, maxLength: 4096 },
	refs: { type: 'array', maxItems: 100, uniqueItems: true, default: [], items: { type: 'string', minLength: 1, maxLength: 4096 } },
	phase: { type: 'string', enum: ['validate', 'changes'], default: 'changes' },
}, required: ['session', 'revision', 'updatesCursor'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private timeline: GridspaceTimelineService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await this.timeline.changes(me, { ...ps, refs: ps.refs ?? [] }); } catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
