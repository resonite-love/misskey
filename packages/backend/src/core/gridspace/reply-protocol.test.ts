/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { replyAudience, replyOptionsSchema } from './reply-protocol.js';

describe('old-account reply audience', () => {
	test('compiles and validates with the actual REST endpoint validator', async () => {
		class TestEndpoint extends Endpoint<{ requireCredential: false }, { type: 'object'; properties: typeof replyOptionsSchema; required: ['noteId'] }> {
			constructor() { super({ requireCredential: false }, { type: 'object', properties: replyOptionsSchema, required: ['noteId'] }, async () => ({})); }
		}
		const endpoint = new TestEndpoint();
		await expect(endpoint.exec({ noteId: 'parent', action: 'status', requestId: '00000000-0000-4000-8000-000000000001' }, null, null)).resolves.toEqual({});
		await expect(endpoint.exec({ noteId: 'parent', requestId: 'bad' }, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
	});
	test('keeps direct conversation participants and its author without widening mentions', () => {
		expect(replyAudience({ visibility: 'specified', visibleUserIds: ['old', 'author', 'old'], userId: 'author', localOnly: true }))
			.toEqual({ visibility: 'specified', visibleUserIds: ['old', 'author'], localOnly: true });
	});
	test.each(['followers', 'public', 'home'])('never publishes a private-path %s reply publicly', visibility => {
		expect(replyAudience({ visibility, visibleUserIds: [], userId: 'author', localOnly: false }))
			.toEqual({ visibility: 'followers', visibleUserIds: [], localOnly: false });
	});
});
