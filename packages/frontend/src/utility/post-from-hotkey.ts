/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { $i } from '@/i.js';
import { alert, post } from '@/os.js';
import { mainRouter } from '@/router.js';
import { i18n } from '@/i18n.js';
import { gridspacePost } from '@/utility/gridspace-post.js';
import { misskeyApi } from '@/utility/misskey-api.js';

export async function postFromHotkey(): Promise<void> {
	if ($i == null) return;

	const current = mainRouter.current;
	if (current.route.path === '/gridspace/channels/:channelId?') {
		const channelId = current.props.get('channelId');
		if (typeof channelId !== 'string') {
			await post();
			return;
		}

		try {
			const result = await misskeyApi('gridspace/channels', { channelId });
			if (mainRouter.current !== current) return;
			const channel = result.channels.find(item => item.id === channelId);
			if (!channel || channel.isArchived) {
				await alert({ type: 'error', text: channel?.isArchived ? i18n.ts.thisChannelArchived : i18n.ts._gridspace.channelsUnavailable });
				return;
			}
			await gridspacePost({ channelId, channel });
		} catch (err) {
			if (mainRouter.current === current) await alert({ type: 'error', text: (err as Error).message });
		}
		return;
	}
	if (current.route.path !== '/channels/:channelId') {
		await post();
		return;
	}

	const channelId = current.props.get('channelId');
	if (typeof channelId !== 'string') return;

	const channel = await misskeyApi('channels/show', { channelId }).catch(err => {
		alert({ type: 'error', text: err.message });
		return null;
	});
	if (channel == null || mainRouter.current !== current) return;

	await post({ channel });
}
