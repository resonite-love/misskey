/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { entities } from 'misskey-js';

type Call = (path: string, data: Record<string, unknown>) => Promise<unknown>;
export type MenuClip = entities.Clip & { gridspaceOrigin?: string };

/** Fetch on opening: clips created in another tab/server must appear immediately. */
export async function loadClipMenu(call: Call): Promise<{ clips: MenuClip[]; peerUnavailable: boolean }> {
	let peerUnavailable = false;
	const [local, peer] = await Promise.all([
		call('clips/list', { limit: 100 }) as Promise<MenuClip[]>,
		call('gridspace/managed-resource', { kind: 'clip', action: 'list', data: { limit: 100 } })
			.then(value => (value as { items: MenuClip[] }).items)
			.catch(() => { peerUnavailable = true; return []; }),
	]);
	return { clips: [...local, ...peer], peerUnavailable };
}
