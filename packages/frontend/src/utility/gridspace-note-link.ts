/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { misskeyApi } from '@/utility/misskey-api.js';

export function isGridspaceNoteLink(value: string): boolean {
	try {
		const link = new URL(value);
		return link.protocol === 'https:' && !link.username && !link.password && link.pathname === '/gridspace/private' &&
			link.searchParams.getAll('noteId').length === 1 && /^[a-zA-Z0-9]{1,32}$/.test(link.searchParams.get('noteId')!) &&
			link.searchParams.getAll('channelId').length <= 1 && (!link.searchParams.has('channelId') || /^[a-zA-Z0-9]{1,32}$/.test(link.searchParams.get('channelId')!)) &&
			[...link.searchParams.keys()].every(key => ['noteId', 'channelId'].includes(key));
	} catch { return false; }
}

export type LinkedQuoteAttachment = { file: File; isSensitive?: boolean; caption?: string | null };

let origins: Promise<string[]> | undefined;
export async function isConfiguredGridspaceOrigin(value: string): Promise<boolean | null> {
	origins ??= misskeyApi('gridspace/search-info', {}).then(info => info.enabled ? info.origins : []).catch(() => { origins = undefined; throw new Error('Configuration unavailable'); });
	try { return (await origins).includes(new URL(value).origin); } catch { return null; }
}

export async function isConfiguredGridspaceNoteLink(value: string): Promise<boolean | null> {
	if (!isGridspaceNoteLink(value)) return false;
	return isConfiguredGridspaceOrigin(value);
}
