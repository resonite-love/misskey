/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GridspaceLinkError, GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';

const text = { type: 'string', optional: false, nullable: true } as const;
const flag = { type: 'boolean', optional: false, nullable: false } as const;
export const meta = {
	tags: ['account'], requireCredential: true, secure: true,
	limit: { duration: 60000, max: 30 },
	errors: { unavailable: { message: 'Private reading authorization is unavailable.', code: 'GRIDSPACE_PRIVATE_UNAVAILABLE', id: 'b5a87ddd-39f1-4e4c-a962-eacbbdb045bf' } },
	res: { type: 'object', optional: false, nullable: false, properties: {
		enabled: flag, granted: flag, available: flag, peerOrigin: text, authorizationUrl: text, clientKey: text,
	} },
} as const;
export const paramDef = {
	type: 'object', properties: {
		action: { type: 'string', enum: ['status', 'start', 'finish', 'revoke'], default: 'status' },
		state: { type: 'string', minLength: 1, maxLength: 128 }, clientKey: { type: 'string', minLength: 1, maxLength: 128 },
		code: { type: 'string', minLength: 1, maxLength: 512 }, issuer: { type: 'string', maxLength: 512 },
	}, required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private links: GridspaceLinkService) {
		super(meta, paramDef, async (ps, me) => {
			try {
				let authorization: { authorizationUrl: string; clientKey: string } | null = null;
				if (ps.action === 'start') authorization = await this.links.start(me, 'private');
				if (ps.action === 'finish') {
					if (!ps.state || !ps.code || !ps.issuer || !ps.clientKey) throw new GridspaceLinkError('INVALID_CALLBACK');
					await this.links.finishPrivate(me, { state: ps.state, code: ps.code, issuer: ps.issuer, clientKey: ps.clientKey });
				}
				if (ps.action === 'revoke') await this.links.revokePrivate(me);
				return { ...await this.links.privateStatus(me), ...authorization };
			} catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.unavailable, { reason: error.code });
				throw error;
			}
		});
	}
}
