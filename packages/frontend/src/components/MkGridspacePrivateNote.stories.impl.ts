/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { HttpResponse, http } from 'msw';
import MkGridspacePrivateNote from './MkGridspacePrivateNote.vue';

export const Default = {
	render: args => ({ components: { MkGridspacePrivateNote }, setup: () => ({ args }), template: '<MkGridspacePrivateNote v-bind="args" />' }),
	args: {
		note: { id: 'privatenote1', uri: 'https://peer.example/notes/privatenote1', createdAt: '2026-11-12T00:00:00Z', origin: 'https://peer.example',
			text: '連携先で読める投稿です。', cw: null, visibility: 'followers', localOnly: true,
			author: { name: 'ここあ', username: 'kokoa', host: 'peer.example', uri: 'https://peer.example/users/author', avatarUrl: '/static-assets/avatar.png' },
			replyId: null, renoteId: null, files: [], poll: null },
	},
} satisfies StoryObj<typeof MkGridspacePrivateNote>;

export const ContentWarning = {
	...Default,
	args: { note: { ...Default.args.note, cw: '内容の説明', poll: { choices: [{ text: '一つ目', votes: 2 }, { text: '二つ目', votes: 1 }], multiple: false, expiresAt: null } } },
} satisfies StoryObj<typeof MkGridspacePrivateNote>;

export const Attachment = {
	...Default,
	args: { note: { ...Default.args.note, files: [{ id: 'file1', name: 'private.png', type: 'image/png', size: 68, comment: '限定投稿の画像', isSensitive: true }] } },
	parameters: { msw: { handlers: [http.post('/api/gridspace/private-file', () => HttpResponse.json({
		data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2rSAAAAAASUVORK5CYII=', type: 'image/png',
	}))] } },
} satisfies StoryObj<typeof MkGridspacePrivateNote>;

export const FileUnavailable = {
	...Attachment,
	parameters: { msw: { handlers: [http.post('/api/gridspace/private-file', () => HttpResponse.json({ error: { code: 'GRIDSPACE_PRIVATE_UNAVAILABLE' } }, { status: 403 }))] } },
} satisfies StoryObj<typeof MkGridspacePrivateNote>;

export const Formatted = {
	...Default,
	args: { note: { ...Default.args.note, text: '**MFM** :example: @kokoa', cw: 'CW :example:', emojis: { example: '/static-assets/avatar.png' } } },
} satisfies StoryObj<typeof MkGridspacePrivateNote>;

export const Channel = {
	...Default,
	args: { note: { ...Default.args.note, channelId: 'channel1', visibility: 'public', text: 'チャンネルへの投稿です。', reactions: { '👍': 2 } } },
} satisfies StoryObj<typeof MkGridspacePrivateNote>;
