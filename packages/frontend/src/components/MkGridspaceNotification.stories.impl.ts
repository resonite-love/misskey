/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { HttpResponse, http } from 'msw';
import MkGridspaceNotification from './MkGridspaceNotification.vue';
import type { NotificationGroup } from '@/utility/use-gridspace-notifications.js';
const user = { id: 'peeruser', username: 'kokoa', name: 'Kokoa', host: 'peer.example', avatarUrl: '/static-assets/avatar.png', avatarBlurhash: null, avatarDecorations: [], isCat: false, emojis: {}, onlineStatus: 'unknown' as const };
export const row: NotificationGroup & { source: 'peer' } = {
	key: 'peer:request', id: 'notice', source: 'peer', origin: 'https://peer.example', recipientId: 'recipient', createdAt: '2026-11-13T00:00:00Z', isRead: false, members: [],
	remote: { id: 'notice', createdAt: '2026-11-13T00:00:00Z', type: 'receiveFollowRequest', isRead: false, note: null, body: null, reaction: null, user: { ...user, uri: 'https://peer.example/users/peeruser' },
		presentation: { user, recipient: user, noteUser: null, header: null, icon: null, achievement: null, roleName: null, roleIcon: null, roomName: null, exportedEntity: null, fileId: null, reactionUrl: null, followRequestId: 'request', canManageFollowRequest: true } },
};
const { members: _, ...member } = row;
row.members = [member];
export const Default = {
	render: args => ({ components: { MkGridspaceNotification }, setup: () => ({ args }), template: '<MkGridspaceNotification v-bind="args" />' }),
	args: { row },
	parameters: { msw: { handlers: [http.post('/api/gridspace/notifications/follow-request', () => HttpResponse.json({ done: true }))] } },
} satisfies StoryObj<typeof MkGridspaceNotification>;
export const PermissionRequired = { ...Default, args: { row: { ...row, remote: { ...row.remote, presentation: { ...row.remote.presentation!, canManageFollowRequest: false } } } } } satisfies StoryObj<typeof MkGridspaceNotification>;
export const Failure = { ...Default, parameters: { msw: { handlers: [http.post('/api/gridspace/notifications/follow-request', () => HttpResponse.error())] } } } satisfies StoryObj<typeof MkGridspaceNotification>;
