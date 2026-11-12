/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

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
