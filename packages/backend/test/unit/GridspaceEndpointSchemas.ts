/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { Endpoint } from '@/server/api/endpoint-base.js';
import TimelineEndpoint, { meta as timelineMeta, paramDef as timelineParams } from '@/server/api/endpoints/gridspace/timeline.js';
import type { GridspaceTimelineService } from '@/core/gridspace/timeline/GridspaceTimelineService.js';
import { meta as changesMeta, paramDef as changesParams } from '@/server/api/endpoints/gridspace/timeline/changes.js';
import { meta as notificationsMeta, paramDef as notificationParams } from '@/server/api/endpoints/gridspace/notifications/timeline.js';

/** Use the actual Endpoint constructor, including its deliberately small Ajv format registry. */
class SchemaProbe extends Endpoint<typeof timelineMeta, typeof timelineParams> {
	constructor() { super(timelineMeta, timelineParams, async () => undefined as never); }
}
class ChangesProbe extends Endpoint<typeof changesMeta, typeof changesParams> {
	constructor() { super(changesMeta, changesParams, async () => undefined as never); }
}
class NotificationsProbe extends Endpoint<typeof notificationsMeta, typeof notificationParams> {
	constructor() { super(notificationsMeta, notificationParams, async () => undefined as never); }
}

describe('GridSpace endpoint startup schemas', () => {
	test('timeline, changes and notifications compile with the production Endpoint Ajv registry', () => {
		expect(() => new SchemaProbe()).not.toThrow();
		expect(() => new ChangesProbe()).not.toThrow();
		expect(() => new NotificationsProbe()).not.toThrow();
	});
	test('malformed session IDs fail normal input validation', async () => {
		const probe = new ChangesProbe();
		await expect(probe.exec({ session: '../another-user', revision: '1', updatesCursor: 'opaque', refs: [] }, {} as never, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
	});
	test('requires an anchor reference to include the previous session binding', async () => {
		const service = { page: vi.fn().mockResolvedValue({}) };
		const endpoint = new TimelineEndpoint(service as unknown as GridspaceTimelineService);
		await expect(endpoint.exec({ kind: 'home', anchorRef: 'opaque' }, {} as never, null)).rejects.toMatchObject({
			code: 'GRIDSPACE_TIMELINE_UNAVAILABLE', info: { reason: 'INVALID_CURSOR' },
		});
		expect(service.page).not.toHaveBeenCalled();
		await endpoint.exec({ kind: 'home', anchor: 'https://example.test/notes/first', anchorRef: 'opaque', previousSession: '11111111-1111-4111-8111-111111111111', previousRevision: '1' }, {} as never, null);
		expect(service.page.mock.calls[0][6]).toMatchObject({ anchorRef: 'opaque', previousRevision: '1', refs: [] });
	});
});
