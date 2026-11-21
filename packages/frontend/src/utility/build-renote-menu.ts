/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { i18n } from '@/i18n.js';
import type { MenuItem } from '@/types/menu.js';

type Action = () => void | Promise<void>;

/** Native and paired notes share the same choices; only their actions differ. */
export function buildRenoteMenu<T extends { name: string }>(options: {
	inChannel: boolean;
	allowExternal: boolean;
	renote: Action;
	quote?: Action;
	inChannelRenote?: Action;
	inChannelQuote?: Action;
	channels?: () => Promise<T[]>;
	renoteToChannel?: (channel: T) => void | Promise<void>;
}): MenuItem[] {
	const items: MenuItem[] = [];
	if (options.allowExternal) {
		items.push({ text: i18n.ts.renote, icon: 'ti ti-repeat', action: options.renote });
		if (options.quote) items.push({ text: i18n.ts.quote, icon: 'ti ti-quote', action: options.quote });
	}
	if (options.inChannel && options.inChannelRenote && options.inChannelQuote) {
		if (items.length) items.push({ type: 'divider' });
		items.push({ text: i18n.ts.inChannelRenote, icon: 'ti ti-repeat', action: options.inChannelRenote },
			{ text: i18n.ts.inChannelQuote, icon: 'ti ti-quote', action: options.inChannelQuote });
	}
	if (options.allowExternal && options.channels && options.renoteToChannel) {
		if (items.length) items.push({ type: 'divider' });
		items.push({ type: 'parent', text: options.inChannel ? i18n.ts.renoteToOtherChannel : i18n.ts.renoteToChannel,
			icon: 'ti ti-repeat', children: async () => (await options.channels!()).map(channel => ({
				text: channel.name, action: () => options.renoteToChannel!(channel),
			})) });
	}
	return items;
}
