/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { GridspacePeerConfig } from '@/core/gridspace/peer-protocol.js';
import { peerEmojiUrl } from '@/core/gridspace/peer-emoji-url.js';

/** A paired local-only emoji need not have an ActivityPub emoji cache entry. */
export function peerEmojiFallback(peer: GridspacePeerConfig | null, name: string, host: string | undefined, options: { static?: unknown; badge?: unknown; fallback?: unknown }): string | null {
	const endpoint = peerEmojiUrl(peer, name, host);
	if (!endpoint) return null;
	const url = new URL(endpoint);
	if ('static' in options) url.searchParams.set('static', '1');
	if ('badge' in options) url.searchParams.set('badge', '1');
	if ('fallback' in options) url.searchParams.set('fallback', '1');
	return url.href;
}
