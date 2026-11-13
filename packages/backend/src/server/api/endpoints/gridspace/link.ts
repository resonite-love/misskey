/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { GridspaceLinkError, GridspaceLinkService } from '@/core/gridspace/GridspaceLinkService.js';
import { ApiError } from '../../error.js';

const text = { type: 'string', optional: false, nullable: true } as const;
const count = { type: 'integer', optional: false, nullable: false } as const;

export const meta = {
	tags: ['account'], requireCredential: true, secure: true,
	limit: { duration: 60 * 60_000, max: 2000 },
	errors: {
		linkFailed: { message: 'Account linking could not be completed.', code: 'GRIDSPACE_LINK_FAILED', id: 'f85797fe-8228-4db6-a33a-296bad53d843' },
	},
	res: {
		type: 'object', optional: false, nullable: false,
		properties: {
			enabled: { type: 'boolean', optional: false, nullable: false },
			driveShared: { type: 'boolean', optional: false, nullable: false },
			driveSeeded: { type: 'boolean', optional: false, nullable: false },
			channelsEnabled: { type: 'boolean', optional: false, nullable: false },
			peerOrigin: text, state: { ...text, nullable: false }, peerUsername: text, peerUserId: text,
			initiator: { type: 'boolean', optional: false, nullable: false }, lastError: text,
			total: count, pending: count, done: count, requested: count, failed: count, skipped: count,
			authorizationUrl: text, clientKey: text,
			items: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false,
				properties: { uri: { ...text, nullable: false }, userId: text, state: { ...text, nullable: false }, reason: text } } },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		action: { type: 'string', enum: ['status', 'start', 'finish', 'revoke', 'retry'], default: 'status' },
		state: { type: 'string', minLength: 1, maxLength: 128 }, clientKey: { type: 'string', minLength: 1, maxLength: 128 },
		code: { type: 'string', minLength: 1, maxLength: 512 }, issuer: { type: 'string', maxLength: 512 },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private links: GridspaceLinkService) {
		super(meta, paramDef, async (ps, me) => {
			try {
				let authorization: { authorizationUrl: string; clientKey: string } | null = null;
				if (ps.action === 'start') authorization = await this.links.start(me);
				if (ps.action === 'finish') {
					if (!ps.state || !ps.code || !ps.clientKey || !ps.issuer) throw new GridspaceLinkError('INVALID_CALLBACK');
					await this.links.finish(me, { state: ps.state, code: ps.code, clientKey: ps.clientKey, issuer: ps.issuer });
				}
				if (ps.action === 'revoke') await this.links.revoke(me);
				if (ps.action === 'retry') await this.links.retry(me);
				return { ...await this.links.status(me), ...authorization };
			} catch (error) {
				if (error instanceof GridspaceLinkError) throw new ApiError(meta.errors.linkFailed, { reason: error.code });
				throw error;
			}
		});
	}
}
