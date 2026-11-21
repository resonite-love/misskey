/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { http, HttpResponse } from 'msw';
import type { StoryObj } from '@storybook/vue3';
import MkNoteClips from './MkNoteClips.vue';

export const Default = {
	component: MkNoteClips,
	args: { noteId: 'note' },
	parameters: { msw: { handlers: [http.post('/api/gridspace/note-clips', () => HttpResponse.json({ clips: [], partial: false }))] } },
} satisfies StoryObj<typeof MkNoteClips>;

export const Unavailable = {
	...Default,
	parameters: { msw: { handlers: [http.post('/api/gridspace/note-clips', () => HttpResponse.json({ clips: [], partial: true }))] } },
} satisfies StoryObj<typeof MkNoteClips>;
