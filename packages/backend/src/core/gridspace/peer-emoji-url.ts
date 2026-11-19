/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { GridspacePeerConfig } from './peer-protocol.js';

/** Resolve only the configured peer's public emoji route, without an AP cache entry. */
export function peerEmojiUrl(peer: GridspacePeerConfig | null, name: string, host: string | undefined): string | null {
	if (!peer || host !== new URL(peer.peerOrigin).host || !/^[a-zA-Z0-9_-]+$/.test(name)) return null;
	return new URL(`/emoji/${name}.webp`, peer.peerOrigin).href;
}
