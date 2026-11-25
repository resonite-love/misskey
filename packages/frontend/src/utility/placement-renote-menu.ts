/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { url } from '@@/js/config.js';
import type { MenuItem } from '@/types/menu.js';
import type { ChannelRoute, NotePlacement, PostingChannel } from '@/utility/multi-note.js';
import { buildRenoteMenu } from '@/utility/build-renote-menu.js';
import { sameChannel, placementParams } from '@/utility/multi-note.js';
import { forgetReplyRequest, rememberReplyRequest } from '@/utility/gridspace-reply-request.js';
import { placementReferenceUri } from '@/utility/gridspace-note-link.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { globalEvents } from '@/events.js';
import { i18n } from '@/i18n.js';
import { renoteChannelChoices } from '@/utility/renote-channel-choices.js';
import { prefer } from '@/preferences.js';
import { store } from '@/store.js';
import * as os from '@/os.js';

type Source = NotePlacement & { canonicalUri: string };
type Note = { channelPlacements?: readonly NotePlacement[] | null; visibility: string };
type PublicActions = { renote: () => void; quote: () => void };
const localOrigin = new URL(url).origin;

export function placementSources(note: Note, channel?: ChannelRoute | null): Source[] {
	return (note.channelPlacements ?? []).filter((placement): placement is Source =>
		placement.state === 'active' && placement.isArchived === false && !!placement.canonicalUri && (!channel || sameChannel(placement, channel)));
}

function label(channel: ChannelRoute & { name?: string | null }) {
	return `${channel.name ?? i18n.ts.channel} · ${channel.origin === localOrigin ? i18n.ts._multiNote.localSiteName : i18n.ts._multiNote.peerSiteName}`;
}

export function placementRenoteMenu(note: Note, accountId: string, context: ChannelRoute | null, active: () => boolean, changed: () => void, publicActions?: PublicActions): MenuItem[] {
	const sources = placementSources(note, context);
	const menu = (source: Source): MenuItem[] => {
		const target = { origin: source.origin, channelId: source.channelId, name: source.name ?? i18n.ts.channel, color: source.color ?? '' };
		const reference = placementReferenceUri(source.canonicalUri, source);
		const create = async (destination?: PostingChannel) => {
			if (!active()) return;
			const configured = prefer.s.rememberNoteVisibility ? store.s.visibility : prefer.s.defaultNoteVisibility;
			const visibility = destination ? 'public' : configured === 'specified' || configured === 'followers' ? 'followers' : configured === 'home' || note.visibility === 'home' || source.isSensitive ? 'home' : 'public';
			const key = JSON.stringify(['placement-renote', reference, destination?.origin, destination?.channelId]);
			try {
				const requestId = destination ? rememberReplyRequest(accountId, key, crypto.randomUUID()) : undefined;
				const result = await misskeyApi('notes/create', {
					gridspaceQuote: reference, localOnly: true, visibility,
					...(destination ? { ...placementParams({ includeDefault: false, channels: [destination] }, localOrigin), clientRequestId: requestId } : {}),
				}, undefined, AbortSignal.timeout(30000));
				if (requestId) forgetReplyRequest(accountId, key, requestId);
				globalEvents.emit('notePosted', result.createdNote);
				if (active()) { os.toast(i18n.ts.renoted); changed(); }
			} catch { if (active()) await os.alert({ type: 'error', text: i18n.ts._gridspace.replyUncertain }); }
		};
		return buildRenoteMenu({
			inChannel: true, allowExternal: publicActions != null || source.allowRenoteToExternal === true,
			renote: publicActions ? () => { if (active()) publicActions.renote(); } : () => create(),
			quote: publicActions ? () => { if (active()) publicActions.quote(); } : () => { if (active()) void os.post({ gridspaceQuote: reference, initialLocalOnly: true }); },
			inChannelRenote: () => create(target),
			inChannelQuote: () => {
				if (!active()) return;
				void os.post({ gridspaceQuote: reference, fixedQuoteDestination: target, initialLocalOnly: true, initialVisibility: 'public' });
			},
			channels: () => renoteChannelChoices(source),
			renoteToChannel: destination => create(destination.channel),
		});
	};
	return sources.length === 1 ? menu(sources[0]) : sources.map(source => ({
		type: 'parent', text: label(source), children: () => Promise.resolve(menu(source)),
	}));
}
