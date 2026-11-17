/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { AutoTranslationService } from '@/core/auto-translation/AutoTranslationService.js';
import { translationErrors, translationFailure } from '@/server/api/auto-translation.js';

export const meta = {
	tags: ['notes'], requireCredential: true, kind: 'read:account',
	limit: { duration: 60_000, max: 12_000 },
	errors: translationErrors,
	res: {
		type: 'object', optional: false, nullable: false,
		properties: {
			status: { type: 'string', enum: ['translated', 'sameLanguage', 'skipped'], optional: false, nullable: false },
			sourceLang: { type: 'string', optional: false, nullable: true },
			targetLang: { type: 'string', optional: false, nullable: false },
			text: { type: 'string', optional: false, nullable: true },
			cw: { type: 'string', optional: false, nullable: true },
		},
	},
} as const;
export const paramDef = {
	type: 'object',
	properties: { noteId: { type: 'string', format: 'misskey:id' }, targetLang: { type: 'string', minLength: 2, maxLength: 32 } },
	required: ['noteId', 'targetLang'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(service: AutoTranslationService) {
		super(meta, paramDef, async (ps, me) => service.translateNote(ps.noteId, ps.targetLang, me).catch(translationFailure));
	}
}
