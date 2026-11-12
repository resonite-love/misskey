/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { HttpResponse, http } from 'msw';
import MkGridspacePostForm from './MkGridspacePostForm.vue';

const account = { name: 'ここあ', username: 'kokoa', host: 'peer.example', uri: 'https://peer.example/users/old', avatarUrl: '/static-assets/avatar.png' };
const prepared = { account, canReply: true, canAttach: true, visibility: 'public', localOnly: true, recipients: [], maxTextLength: 3000, createdNoteId: null };
export const Default = {
	render: args => ({ components: { MkGridspacePostForm }, setup: () => ({ args }), template: '<div class="_panel" style="max-width: 520px"><MkGridspacePostForm v-bind="args" /></div>' }),
	args: { channelId: 'channel1', channel: { name: '雑談', color: '#86b300' }, embedded: true },
	parameters: { msw: { handlers: [http.post('/api/gridspace/channel-post', () => HttpResponse.json(prepared))] } },
} satisfies StoryObj<typeof MkGridspacePostForm>;
export const ConsentRequired = {
	...Default,
	parameters: { msw: { handlers: [http.post('/api/gridspace/channel-post', () => HttpResponse.json({ ...prepared, canReply: false }))] } },
} satisfies StoryObj<typeof MkGridspacePostForm>;
