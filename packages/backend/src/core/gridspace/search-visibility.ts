/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { SelectQueryBuilder } from 'typeorm';
import type { MiNote } from '@/models/Note.js';

export function noteNewerThanPolicySql(noteTime: string, field: 'makeNotesHiddenBefore' | 'makeNotesFollowersOnlyBefore'): string {
	return `("user"."${field}" IS NULL OR ${noteTime} > CASE WHEN "user"."${field}" > 0 THEN "user"."${field}"::bigint * 1000 ELSE :nowMs::bigint + "user"."${field}"::bigint * 1000 END)`;
}

/** Apply author policies before selection so hidden matches do not leak through IDs/cursors. */
export function filterNoteVisibility(query: SelectQueryBuilder<MiNote>, noteTime: string, viewer: { id: string } | null, source: boolean, authenticated = viewer != null): void {
	const newerThan = (field: 'makeNotesHiddenBefore' | 'makeNotesFollowersOnlyBefore') => noteNewerThanPolicySql(noteTime, field);
	query.setParameters({ nowMs: Date.now(), privacyViewer: viewer?.id ?? null });
	if (!authenticated) query.andWhere('user.requireSigninToViewContents = false');
	// Source responses populate a shared cache, never an individual viewer's private cache.
	query.andWhere(source ? newerThan('makeNotesHiddenBefore') : `(note.userId = :privacyViewer OR ${newerThan('makeNotesHiddenBefore')})`);
	query.andWhere(source ? newerThan('makeNotesFollowersOnlyBefore') : `(note.visibility NOT IN ('public', 'home') OR ${newerThan('makeNotesFollowersOnlyBefore')}
		OR note.userId = :privacyViewer OR note.replyUserId = :privacyViewer OR :privacyViewer = ANY(note.mentions)
		OR EXISTS (SELECT 1 FROM following f WHERE f."followerId" = :privacyViewer AND f."followeeId" = note."userId"))`);
}

/** Decode the timestamp just as IdService.parse does, before applying SQL search/pagination.
 * Only fixed SQL fragments are returned; neither identifiers nor values come from the request.
 */
export function searchNoteTimeSql(method: string): string {
	let alphabet = '0123456789abcdef'; let start = 1; let length = 12; let offset = 0; let factor = 1;
	switch (method.toLowerCase()) {
		case 'aid': case 'aidx': alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'; length = 8; offset = 946684800000; break;
		case 'meid': offset = -0x800000000000; break;
		case 'meidg': start = 2; length = 11; break;
		case 'objectid': length = 8; factor = 1000; break;
		case 'ulid': alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; length = 10; break;
		default: throw new Error('Unsupported search ID method');
	}
	const digits = Array.from({ length }, (_, index) => `(strpos('${alphabet}', substring(note.id, ${start + index}, 1)) - 1)::bigint * ${alphabet.length ** (length - index - 1)}`);
	return `((${digits.join(' + ')}) * ${factor} + ${offset})`;
}
