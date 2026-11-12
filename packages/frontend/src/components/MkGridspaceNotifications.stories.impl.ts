/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { http, HttpResponse } from 'msw';
import MkGridspaceNotifications from './MkGridspaceNotifications.vue';
import { Default as Private } from './MkGridspacePrivateNote.stories.impl.js';
import type { StoryObj } from '@storybook/vue3';

const remote = { id: 'peerNotification', createdAt: '2026-11-12T01:00:00Z', type: 'mention', isRead: false, user: Private.args.note.author, note: Private.args.note, body: null, reaction: null };
const page = { origin: 'https://resonite.love', recipientId: 'oldAccount', local: [], remote: [remote], next: null, newest: remote.id, boundary: null, unreadCount: 1 };
export const Default = {
	render: args => ({ components: { MkGridspaceNotifications }, setup: () => ({ args }), template: '<MkGridspaceNotifications v-bind="args" />' }),
	args: {},
	parameters: { msw: { handlers: [http.post('/api/gridspace/notifications', async ({ request }) => {
		const input = await request.json() as { source: string };
		return HttpResponse.json(input.source === 'peer' ? page : { ...page, origin: 'https://grid-space.io', recipientId: 'newAccount', remote: [], unreadCount: 0 });
	}), http.post('/api/gridspace/notifications/read', () => HttpResponse.json({ unreadCount: 0 }))] } },
} satisfies StoryObj<typeof MkGridspaceNotifications>;

export const Unavailable = { ...Default, parameters: { msw: { handlers: [http.post('/api/gridspace/notifications', () => HttpResponse.error())] } } } satisfies StoryObj<typeof MkGridspaceNotifications>;
export const Empty = { ...Default, parameters: { msw: { handlers: [http.post('/api/gridspace/notifications', () => HttpResponse.json({ ...page, remote: [], unreadCount: 0 }))] } } } satisfies StoryObj<typeof MkGridspaceNotifications>;
