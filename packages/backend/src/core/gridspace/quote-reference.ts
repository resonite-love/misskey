/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** The URL names a viewer route, whose IDs belong to the opposite server. */
export function parseChannelQuote(value: string, viewerOrigin: string) {
	const url = new URL(value);
	if (url.origin !== viewerOrigin || url.protocol !== 'https:' || url.username || url.password || url.hash || url.pathname !== '/gridspace/private' ||
		url.searchParams.getAll('noteId').length !== 1 || url.searchParams.getAll('channelId').length !== 1 ||
		[...url.searchParams.keys()].some(key => !['noteId', 'channelId'].includes(key))) throw new Error('Invalid channel quote');
	const noteId = url.searchParams.get('noteId')!;
	const channelId = url.searchParams.get('channelId')!;
	if (!/^[a-zA-Z0-9]{1,32}$/.test(noteId) || !/^[a-zA-Z0-9]{1,32}$/.test(channelId)) throw new Error('Invalid channel quote');
	return { noteId, channelId, url: `${viewerOrigin}/gridspace/private?noteId=${noteId}&channelId=${channelId}` };
}
