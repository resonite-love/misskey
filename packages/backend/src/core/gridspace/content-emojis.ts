/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as mfm from 'mfm-js';
import { extractCustomEmojisFromMfm } from '@/misc/extract-custom-emojis-from-mfm.js';
import type { CustomEmojiService } from '@/core/CustomEmojiService.js';

export type ContentEmojiCarrier = {
	user: { name?: string | null; username: string; emojis?: Record<string, string> };
	content?: unknown;
	summary?: string | null;
	description?: string | null;
	gridspaceEmojis?: Record<string, string>;
};

function contentText(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(contentText);
	if (!value || typeof value !== 'object') return [];
	const block = value as Record<string, unknown>;
	return [...(typeof block.text === 'string' ? [block.text] : []), ...contentText(block.children)];
}

/** Native local users omit emoji URLs. A paired server needs these URLs explicitly. */
export async function attachContentEmojis(item: ContentEmojiCarrier, service: Pick<CustomEmojiService, 'populateEmojis' | 'localEmojisCache'>, origin: string): Promise<void> {
	const names = (text: string[]) => [...new Set(text.flatMap(value => extractCustomEmojisFromMfm(mfm.parse(value))))];
	const authorNames = names([item.user.name ?? item.user.username]);
	const bodyNames = names([...contentText(item.content), item.summary ?? '', item.description ?? '']);
	const allNames = [...new Set([...authorNames, ...bodyNames])];
	const urls = await service.populateEmojis(allNames, null);
	const local = await service.localEmojisCache.fetch();
	const host = new URL(origin).host;
	for (const name of allNames) {
		const suffix = name.lastIndexOf('@');
		const localName = suffix < 0 ? name : ['.', host].includes(name.slice(suffix + 1)) ? name.slice(0, suffix) : null;
		const emoji = localName ? local.get(localName) : undefined;
		const value = emoji?.publicUrl || emoji?.originalUrl || urls[name];
		if (!value) continue;
		const url = new URL(value, origin);
		if (url.protocol === 'https:' || url.protocol === 'http:') urls[name] = url.href;
		else delete urls[name];
	}
	item.user = { ...item.user, emojis: { ...item.user.emojis, ...Object.fromEntries(authorNames.filter(name => urls[name]).map(name => [name, urls[name]])) } };
	item.gridspaceEmojis = Object.fromEntries(bodyNames.filter(name => urls[name]).map(name => [name, urls[name]]));
}
