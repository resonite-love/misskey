/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { url } from '@@/js/config.js';
import type { entities } from 'misskey-js';
import { buildRenoteMenu } from '@/utility/build-renote-menu.js';
import { favoritedChannelsCache } from '@/cache.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { renoteGridspaceChannel } from '@/utility/gridspace-channel-renote.js';
import { gridspacePost } from '@/utility/gridspace-post.js';
import { prefer } from '@/preferences.js';
import { store } from '@/store.js';
import { globalEvents } from '@/events.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';

type Destination = { id: string; name: string; peer: boolean };
type Note = entities.GridspacePrivateNotesResponse['notes'][number];

export function getGridspaceRenoteMenu(note: Note, accountId: string, active: () => boolean, changed: () => void) {
	const source = note.channelId!;
	const reference = `${url}/gridspace/private?noteId=${note.id}&channelId=${source}`;
	const run = async (action: () => Promise<unknown>) => {
		if (!active()) return;
		try { await action(); if (active()) { os.toast(i18n.ts.renoted); changed(); } } catch { if (active()) await os.alert({ type: 'error', text: i18n.ts._gridspace.replyUnavailable }); }
	};
	const localRenote = async (channelId?: string) => {
		const configured = prefer.s.rememberNoteVisibility ? store.s.visibility : prefer.s.defaultNoteVisibility;
		const visibility = channelId ? 'public' : configured === 'specified' || configured === 'followers' ? 'followers' : configured === 'home' || note.visibility === 'home' || note.channel?.isSensitive ? 'home' : 'public';
		const result = await misskeyApi('notes/create', { gridspaceQuote: reference, localOnly: true, visibility, channelId });
		globalEvents.emit('notePosted', result.createdNote);
	};
	return buildRenoteMenu<Destination>({
		inChannel: true, allowExternal: note.canQuoteOutside === true,
		renote: () => run(() => localRenote()),
		quote: () => { if (active()) void os.post({ gridspaceQuote: reference, initialLocalOnly: true }); },
		inChannelRenote: () => run(() => renoteGridspaceChannel(accountId, source, note.id, AbortSignal.timeout(20000))),
		inChannelQuote: () => { if (active()) void gridspacePost({ channelId: source, channel: note.channel ?? undefined, renote: note }, changed); },
		channels: async () => {
			const local: Destination[] = (await favoritedChannelsCache.fetch()).map(channel => ({ id: channel.id, name: channel.name, peer: false }));
			let before: string | undefined;
			for (let page = 0; page < 5; page++) {
				const result = await misskeyApi('gridspace/channels', { list: 'favorites', limit: 20, before });
				local.push(...result.channels.filter(channel => channel.id !== source && !channel.isArchived).map(channel => ({ id: channel.id, name: channel.name, peer: true })));
				if (!result.next) break;
				before = result.next;
			}
			return local;
		},
		renoteToChannel: channel => run(() => channel.peer
			? renoteGridspaceChannel(accountId, channel.id, note.id, AbortSignal.timeout(20000), source)
			: localRenote(channel.id)),
	});
}
