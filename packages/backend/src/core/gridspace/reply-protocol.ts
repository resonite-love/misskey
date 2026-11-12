/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { MAX_NOTE_TEXT_LENGTH } from '@/const.js';
import type { GridspacePeerLinkRequest } from './GridspaceLinkService.js';
import { privateNoteSchema } from './private-protocol.js';

export type ReplyOptions = { action: 'prepare' | 'send' | 'status'; noteId: string; requestId?: string; text?: string; cw?: string | null; fileIds?: string[] };
export type ReplyPeerRequest = GridspacePeerLinkRequest & ReplyOptions;
export const replyOptionsSchema = {
	action: { type: 'string', enum: ['prepare', 'send', 'status'], default: 'prepare' },
	noteId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	requestId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$' },
	text: { type: 'string', maxLength: MAX_NOTE_TEXT_LENGTH },
	fileIds: { type: 'array', maxItems: 16, uniqueItems: true, items: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' } },
	cw: { type: 'string', nullable: true, maxLength: 100 },
} as const;
const text = { type: 'string', optional: false, nullable: false } as const;
export const replyResultSchema = { type: 'object', optional: false, nullable: false, properties: {
	canAttach: { type: 'boolean', optional: false, nullable: false },
	canReply: { type: 'boolean', optional: false, nullable: false },
	account: privateNoteSchema.properties.author,
	visibility: { ...text, enum: ['followers', 'specified'] },
	localOnly: { type: 'boolean', optional: false, nullable: false },
	recipients: { type: 'array', optional: false, nullable: false, items: privateNoteSchema.properties.author },
	maxTextLength: { type: 'integer', optional: false, nullable: false },
	createdNoteId: { ...text, nullable: true },
} } as const;

export function replyAudience(parent: { visibility: string; visibleUserIds: string[]; userId: string; localOnly: boolean }) {
	return {
		visibility: parent.visibility === 'specified' ? 'specified' as const : 'followers' as const,
		visibleUserIds: parent.visibility === 'specified' ? [...new Set([...parent.visibleUserIds, parent.userId])] : [],
		localOnly: parent.localOnly,
	};
}
