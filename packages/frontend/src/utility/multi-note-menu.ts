/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import type { MenuItem } from '@/types/menu.js';
import type { NotePlacement } from '@/utility/multi-note.js';

export function getPlacementMenu(placements: readonly NotePlacement[] | null | undefined, canonicalUri: string, refresh?: () => void | Promise<void>): MenuItem[] {
	if (!placements?.length) return [];
	const children: MenuItem[] = [];
	for (const item of placements) {
		if (item.state === 'removed' || item.canRemove !== true) continue;
		const name = `${item.name ?? i18n.ts.channel} @${new URL(item.origin).host}`;
		children.push({
			text: i18n.tsx._multiNote.removePlacement({ name }),
			icon: 'ti ti-circle-minus',
			action: async () => {
				if ((await os.confirm({ type: 'warning', text: i18n.tsx._multiNote.confirmRemove({ name }) })).canceled) return;
				await os.apiWithDialog('gridspace/multi-note/remove', { canonicalUri, channelOrigin: item.origin, channelId: item.channelId });
				await refresh?.();
			},
		});
	}
	if (placements.some(item => item.canRetry && (item.state === 'failed' || item.state === 'pending'))) {
		children.push({
			text: i18n.ts._multiNote.retryPlacement,
			icon: 'ti ti-refresh',
			action: async () => {
				await os.apiWithDialog('gridspace/multi-note/retry', { canonicalUri });
				await refresh?.();
			},
		});
	}
	return children.length ? [{ type: 'parent', text: i18n.ts._multiNote.placements, icon: 'ti ti-device-tv', children }] : [];
}
