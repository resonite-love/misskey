/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type HomeRow<N, P> = { key: string; createdAt: string } & ({ kind: 'normal'; note: N } | { kind: 'private'; note: P });

/** Only release the common scanned prefix; equal-time rows may span pages. */
export function mergeHomeRows<N extends { id: string; uri?: string | null; createdAt: string; collectionAt?: string; isHidden?: boolean }, P extends { uri: string; createdAt: string; collectionAt?: string }>(
	normal: N[], delegated: P[], origin: string, normalBoundary: number, privateBoundary: number,
): HomeRow<N, P>[] {
	const rows = new Map<string, HomeRow<N, P>>();
	for (const note of delegated) rows.set(note.uri, { kind: 'private', key: note.uri, createdAt: note.collectionAt ?? note.createdAt, note });
	for (const note of normal) {
		const key = note.uri || `${origin}/notes/${note.id}`;
		if (!note.isHidden || !rows.has(key)) rows.set(key, { kind: 'normal', key, createdAt: note.collectionAt ?? note.createdAt, note });
	}
	const boundary = Math.max(normalBoundary, privateBoundary);
	return [...rows.values()].filter(row => Date.parse(row.createdAt) > boundary)
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
