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

export function placementReferenceUri(canonicalUri: string, channel: { origin: string; channelId: string }): string {
	const reference = new URL(canonicalUri);
	reference.searchParams.set('gridspaceChannelOrigin', channel.origin);
	reference.searchParams.set('gridspaceChannelId', channel.channelId);
	return reference.href;
}

export function parsePlacementReference(value: string) {
	try {
		const reference = new URL(value);
		const origin = reference.searchParams.get('gridspaceChannelOrigin');
		const channelId = reference.searchParams.get('gridspaceChannelId');
		if (!origin || !channelId || !/^[a-zA-Z0-9]{1,32}$/.test(channelId) || !/^\/notes\/[a-zA-Z0-9]{1,32}$/.test(reference.pathname)) return null;
		const owner = new URL(origin);
		if (!['https:', 'http:'].includes(reference.protocol) || reference.username || reference.password || reference.hash ||
			!['https:', 'http:'].includes(owner.protocol) || owner.origin !== origin) return null;
		reference.search = '';
		const canonicalUri = reference.href;
		return placementReferenceUri(canonicalUri, { origin, channelId }) === value ? { canonicalUri, origin, channelId } : null;
	} catch { return null; }
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
