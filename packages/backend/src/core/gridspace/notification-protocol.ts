/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Packed } from '@/misc/json-schema.js';
import { privateNoteSchema, type PrivateActor, type PrivateNote, type PrivateWireNote } from './private-protocol.js';
import type { GridspacePeerLinkRequest } from './GridspaceLinkService.js';

export type NotificationOptions = { before?: string; since?: string; ids?: string[]; excludeTypes?: string[]; limit?: number; countOnly?: boolean };
export type NotificationPeerRequest = GridspacePeerLinkRequest & NotificationOptions;
export type PeerNotification = { id: string; createdAt: string; type: string; isRead: boolean; user: PrivateActor | null; note: PrivateNote | null; body: string | null; reaction: string | null };
export type WireNotification = Omit<PeerNotification, 'note'> & { note: PrivateWireNote | null };
export type NotificationPage<T> = { items: T[]; next: string | null; newest: string | null; boundary: string | null; unreadCount: number; origin: string; recipientId: string };
export type LocalNotification = { id: string; createdAt: string; isRead: boolean; notification: Packed<'Notification'> };

const text = { type: 'string', optional: false, nullable: false } as const;
const nullableText = { ...text, nullable: true } as const;
export const peerNotificationSchema = { type: 'object', optional: false, nullable: false, properties: {
	id: text, createdAt: text, type: text, isRead: { type: 'boolean', optional: false, nullable: false },
	user: { type: 'object', optional: false, nullable: true, properties: { name: nullableText, username: text, host: text, uri: text } },
	note: { ...privateNoteSchema, nullable: true }, body: nullableText, reaction: nullableText,
} } as const;
const id = { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' } as const;
export const notificationOptionsSchema = {
	before: id, since: id, ids: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: id },
	excludeTypes: { type: 'array', maxItems: 40, uniqueItems: true, items: { type: 'string', maxLength: 64 } },
	limit: { type: 'integer', minimum: 1, maximum: 40, default: 20 }, countOnly: { type: 'boolean', default: false },
} as const;
