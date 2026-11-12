/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { HttpResponse, http } from 'msw';
import MkGridspaceNoteActions from './MkGridspaceNoteActions.vue';
import { ContentWarning } from './MkGridspacePrivateNote.stories.impl.js';

const note = ContentWarning.args.note;
export const Default = {
	render: args => ({ components: { MkGridspaceNoteActions }, setup: () => ({ args }), template: '<MkGridspaceNoteActions v-bind="args" />' }),
	args: { note },
	parameters: { msw: { handlers: [http.post('/api/gridspace/private-action', () => HttpResponse.json({ canInteract: true, note, account: note.author }))] } },
} satisfies StoryObj<typeof MkGridspaceNoteActions>;
export const ConsentRequired = {
	...Default,
	parameters: { msw: { handlers: [http.post('/api/gridspace/private-action', () => HttpResponse.json({ canInteract: false, note, account: note.author }))] } },
} satisfies StoryObj<typeof MkGridspaceNoteActions>;
export const Unavailable = {
	...Default,
	parameters: { msw: { handlers: [http.post('/api/gridspace/private-action', () => HttpResponse.error())] } },
} satisfies StoryObj<typeof MkGridspaceNoteActions>;
