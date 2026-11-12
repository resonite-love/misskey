/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { GridspacePeerLinkRequest } from './GridspaceLinkService.js';

export type ChannelOptions = { channelId?: string; query?: string; queryType?: 'nameOnly' | 'nameAndDescription'; list?: 'featured' | 'favorites' | 'following' | 'owned' | 'search'; followed?: boolean; before?: string; limit?: number };
export type ChannelPeerRequest = GridspacePeerLinkRequest & ChannelOptions;
export const channelOptionsSchema = {
	channelId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
	query: { type: 'string', maxLength: 100 }, followed: { type: 'boolean', default: false },
	queryType: { type: 'string', enum: ['nameOnly', 'nameAndDescription'], default: 'nameAndDescription' },
	list: { type: 'string', enum: ['featured', 'favorites', 'following', 'owned', 'search'] },
	before: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 12 },
} as const;
const text = { type: 'string', optional: false, nullable: false } as const;
const flag = { type: 'boolean', optional: false, nullable: false } as const;
export const channelResultSchema = {
	type: 'object', optional: false, nullable: false, properties: {
		origin: text, next: { ...text, nullable: true },
		channels: { type: 'array', optional: false, nullable: false, items: {
			type: 'object', optional: false, nullable: false, properties: {
				id: text, name: text, description: { ...text, nullable: true }, bannerUrl: { ...text, nullable: true }, color: text,
				isArchived: flag, isSensitive: flag, isFollowing: flag, notesCount: { type: 'integer', optional: false, nullable: false },
				isFavorited: flag, isOwned: flag, usersCount: { type: 'integer', optional: false, nullable: false },
				createdAt: text, lastNotedAt: { ...text, nullable: true },
			},
		} },
	},
} as const;
