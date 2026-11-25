/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { url } from '@@/js/config.js';
import { favoritedChannelsCache } from '@/cache.js';
import { instance } from '@/instance.js';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { sameChannel } from '@/utility/multi-note.js';
import type { ChannelRoute, PostingChannel } from '@/utility/multi-note.js';

const localOrigin = new URL(url).origin;

/** Keep origin and ID together: a favorite on each server can have the same ID. */
export async function renoteChannelChoices(source?: ChannelRoute | null, includePeer = true) {
	const [local, peer] = await Promise.all([
		favoritedChannelsCache.fetch(),
		includePeer && instance.features?.multiNotePeer ? peerFavorites() : [],
	]);
	const channels: PostingChannel[] = [
		...local.filter(channel => !channel.isArchived).map(channel => ({ ...channel, origin: localOrigin, channelId: channel.id })),
		...peer,
	];
	const seen = new Set<string>();
	return channels.filter(channel => {
		const key = JSON.stringify([channel.origin, channel.channelId]);
		if (seen.has(key) || (source && sameChannel(source, channel))) return false;
		seen.add(key);
		return true;
	}).map(channel => ({ channel, name: channel.origin === localOrigin ? channel.name : `${channel.name} · ${i18n.ts._multiNote.peerSiteName}` }));
}

async function peerFavorites(): Promise<PostingChannel[]> {
	const legacy = async () => {
		try {
			return (await misskeyApi('gridspace/link', {}, undefined, AbortSignal.timeout(10000))).channelsEnabled ? await peerFavoritePages('gridspace/channels') : [];
		} catch (error) { console.warn('Failed to fetch linked-account renote destinations:', error); return []; }
	};
	const pages = await Promise.all([peerFavoritePages('gridspace/multi-note/channels'), legacy()]);
	return pages.flat();
}

async function peerFavoritePages(endpoint: 'gridspace/multi-note/channels' | 'gridspace/channels'): Promise<PostingChannel[]> {
	const channels: PostingChannel[] = [];
	const seen = new Set<string>();
	let before: string | undefined;
	try {
		do {
			const page = await misskeyApi(endpoint, { list: 'favorites', limit: 20, before }, undefined, AbortSignal.timeout(10000));
			channels.push(...page.channels.filter(channel => !channel.isArchived).map(channel => ({ ...channel, origin: page.origin, channelId: channel.id })));
			before = page.next ?? undefined;
			if (!before || seen.has(before)) break;
			seen.add(before);
		} while (true);
	} catch (error) {
		// A peer outage must not remove the native destinations.
		console.warn('Failed to fetch paired renote destinations:', error);
	}
	return channels;
}
