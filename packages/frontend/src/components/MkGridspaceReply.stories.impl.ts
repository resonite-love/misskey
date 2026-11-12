/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { HttpResponse, http } from 'msw';
import MkGridspaceReply from './MkGridspaceReply.vue';

const account = { name: 'ここあ', username: 'kokoa', host: 'peer.example', uri: 'https://peer.example/users/old', avatarUrl: '/static-assets/avatar.png' };
const prepared = { account, canReply: true, visibility: 'followers', localOnly: true, recipients: [], maxTextLength: 3000, createdNoteId: null };
export const Default = {
	render: args => ({ components: { MkGridspaceReply }, setup: () => ({ args }), template: '<MkGridspaceReply v-bind="args" />' }),
	args: { noteId: 'private1' },
	parameters: { msw: { handlers: [http.post('/api/gridspace/private-reply', async ({ request }) => {
		const body = await request.json() as { action: string };
		return HttpResponse.json({ ...prepared, createdNoteId: body.action === 'send' ? 'reply1' : null });
	})] } },
} satisfies StoryObj<typeof MkGridspaceReply>;

export const ConsentRequired = {
	...Default,
	parameters: { msw: { handlers: [http.post('/api/gridspace/private-reply', () => HttpResponse.json({ ...prepared, canReply: false }))] } },
} satisfies StoryObj<typeof MkGridspaceReply>;

export const DirectConversation = {
	...Default,
	parameters: { msw: { handlers: [http.post('/api/gridspace/private-reply', () => HttpResponse.json({ ...prepared, visibility: 'specified', recipients: [account] }))] } },
} satisfies StoryObj<typeof MkGridspaceReply>;

export const UncertainDelivery = {
	...Default,
	parameters: { msw: { handlers: [http.post('/api/gridspace/private-reply', async ({ request }) => {
		const body = await request.json() as { action: string };
		return body.action === 'send' ? HttpResponse.error() : HttpResponse.json(prepared);
	})] } },
} satisfies StoryObj<typeof MkGridspaceReply>;
