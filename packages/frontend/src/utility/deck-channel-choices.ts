/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { favoritedChannelsCache } from '@/cache.js';
import { misskeyApi } from '@/utility/misskey-api.js';

const sharedPrefix = 'gridspace:channel:';

export function getSharedDeckChannelId(id: string | undefined): string | null {
	return id?.startsWith(sharedPrefix) ? id.slice(sharedPrefix.length) : null;
}

/** Keep native channel IDs distinct from IDs on the paired server. */
export async function getDeckChannelChoices() {
	return (await getFavoriteChannelChoices()).map(({ id, name, label }) => ({ id, name, label }));
}

type FavoriteChannelChoice = { id: string; name: string; label: string; to: string; lastReadKey: `channelLastReadedAt:${string}`; lastNotedAt: string | null };

/** Shared by the timeline menu and Deck so both include paired favorites. */
export async function getFavoriteChannelChoices(): Promise<FavoriteChannelChoice[]> {
	const [local, shared] = await Promise.all([
		favoritedChannelsCache.fetch(),
		getSharedFavorites(),
	]);
	return [
		...local.map(channel => ({ id: channel.id, name: channel.name, label: channel.name, to: `/channels/${channel.id}`, lastReadKey: `channelLastReadedAt:${channel.id}` as const, lastNotedAt: channel.lastNotedAt ?? null })),
		...shared,
	];
}

async function getSharedFavorites() {
	const channels: FavoriteChannelChoice[] = [];
	try {
		const link = await misskeyApi('gridspace/link', {});
		if (!link.channelsEnabled) return channels;
		let before: string | undefined;
		const seen = new Set<string>();
		do {
			const page = await misskeyApi('gridspace/channels', { list: 'favorites', limit: 20, before });
			const host = new URL(page.origin).host;
			for (const channel of page.channels) {
				const id = sharedPrefix + channel.id;
				if (!channels.some(item => item.id === id)) {
					channels.push({ id, name: channel.name, label: `${channel.name} (${host})`, to: `/gridspace/channels/${channel.id}`, lastReadKey: `channelLastReadedAt:${new URL(page.origin).origin}:${channel.id}`, lastNotedAt: channel.lastNotedAt ?? null });
				}
			}
			before = page.next ?? undefined;
			if (!before || seen.has(before)) break;
			seen.add(before);
		} while (true);
	} catch (error) {
		// A peer outage must not prevent selecting this server's channels.
		console.warn('Failed to fetch paired channel favorites:', error);
	}
	return channels;
}
