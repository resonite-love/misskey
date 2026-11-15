/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { http, HttpResponse } from 'msw';
import MkGridspaceNoteDetail from './MkGridspaceNoteDetail.vue';

export const Default = {
	render: args => ({ components: { MkGridspaceNoteDetail }, setup: () => ({ args }), template: '<MkGridspaceNoteDetail v-bind="args"/>' }),
	args: { noteId: 'note2', channelId: 'channel1' },
	parameters: { msw: { handlers: [
		http.post('/api/gridspace/channels', () => HttpResponse.json({ channels: [{ id: 'channel1', name: '雑談', color: '#86b300' }] })),
		http.post('/api/gridspace/private-notes', async ({ request }) => {
			const params = await request.json() as { mode: string; order?: string };
			const id = params.mode === 'show' ? 'note2' : params.order === 'oldest' ? 'note3' : 'note1';
			return HttpResponse.json({ notes: [{ id, uri: `https://peer.example/notes/${id}`, origin: 'https://peer.example', createdAt: '2026-11-15T00:00:00Z', text: '前後のチャンネル投稿', cw: null, visibility: 'public', localOnly: true, channelId: 'channel1', channel: { id: 'channel1', name: '雑談', color: '#86b300' }, author: { name: 'ここあ', username: 'kokoa', host: 'peer.example', uri: 'https://peer.example/users/author', avatarUrl: '/static-assets/avatar.png' }, files: [], poll: null, replyId: null, renoteId: null }], cursor: null, observedAt: new Date().toISOString(), scannedThrough: null });
		}),
	] } },
} satisfies StoryObj<typeof MkGridspaceNoteDetail>;
