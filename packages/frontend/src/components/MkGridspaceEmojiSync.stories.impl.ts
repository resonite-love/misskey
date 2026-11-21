/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { http, HttpResponse } from 'msw';
import MkGridspaceEmojiSync from './MkGridspaceEmojiSync.vue';
import type { StoryObj } from '@storybook/vue3';

export const Default = {
	render: () => ({ components: { MkGridspaceEmojiSync }, template: '<MkGridspaceEmojiSync/>' }),
	parameters: { msw: { handlers: [http.post('/api/admin/gridspace/emojis', () => HttpResponse.json({ enabled: true, originA: 'https://g.example', originB: 'https://r.example', checkedAt: null, lastError: null, counts: { pending: 0, synced: 2500, conflict: 0, failed: 0, ignored: 0 }, items: [], next: null }))] } },
} satisfies StoryObj<typeof MkGridspaceEmojiSync>;

export const Unavailable = {
	render: () => ({ components: { MkGridspaceEmojiSync }, template: '<MkGridspaceEmojiSync/>' }),
	parameters: { msw: { handlers: [http.post('/api/admin/gridspace/emojis', () => HttpResponse.error())] } },
} satisfies StoryObj<typeof MkGridspaceEmojiSync>;
