/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { GridspaceTimelineService } from '@/core/gridspace/timeline/GridspaceTimelineService.js';
import { timelineFilterSchema, timelinePageProperties, timelineItemSchema } from '@/core/gridspace/timeline/timeline-protocol.js';

export const meta = {
	tags: ['notes'], requireCredential: true, secure: true,
	limit: { duration: 60000, max: 180 },
	errors: { unavailable: { message: 'Unified timeline is unavailable.', code: 'GRIDSPACE_TIMELINE_UNAVAILABLE', id: '318f0c1b-2e94-44b9-854c-21a7337f7a60' } },
	res: { type: 'object', optional: false, nullable: false, properties: { ...timelinePageProperties,
		retainedItems: { type: 'array', optional: true, nullable: false, items: timelineItemSchema },
		order: { type: 'array', optional: true, nullable: false, items: { type: 'string', optional: false, nullable: false } },
	} },
} as const;
export const paramDef = {
	type: 'object', properties: {
		...timelineFilterSchema,
		limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
		cursor: { type: 'string', minLength: 1, maxLength: 4096 },
		mode: { type: 'string', enum: ['unified', 'local-fallback'], default: 'unified' },
		anchor: { type: 'string', maxLength: 1024 },
		anchorRef: { type: 'string', minLength: 1, maxLength: 4096 },
		previousSession: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' }, previousRevision: { type: 'string', maxLength: 32 },
		retainedRefs: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 4096 } },
	}, required: ['kind'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private timeline: GridspaceTimelineService) {
		super(meta, paramDef, async (ps, me) => {
			try {
				const { limit, cursor, mode, anchor, anchorRef, previousSession, previousRevision, retainedRefs, ...options } = ps;
				if (anchorRef && (!previousSession || !previousRevision)) throw new GridspaceLinkError('INVALID_CURSOR');
				return await this.timeline.page(me, options, limit, cursor, mode, anchor, previousSession && previousRevision ? { previousSession, previousRevision, refs: retainedRefs ?? [], anchorRef } : undefined);
			} catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
