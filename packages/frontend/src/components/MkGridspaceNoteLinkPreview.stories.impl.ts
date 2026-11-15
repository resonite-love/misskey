/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { http, HttpResponse } from 'msw';
import Preview from './MkGridspaceNoteLinkPreview.vue';
import { ContentWarning } from './MkGridspacePrivateNote.stories.impl.js';
export const Default = { render: args => ({ components: { Preview }, setup: () => ({ args }), template: '<Preview v-bind="args" />' }), args: { url: 'https://example.com/gridspace/private?noteId=note' }, parameters: { msw: { handlers: [http.post('/api/gridspace/note-link', () => HttpResponse.json({ note: ContentWarning.args.note, localNote: null }))] } } } satisfies StoryObj<typeof Preview>;
export const Unavailable = { ...Default, parameters: { msw: { handlers: [http.post('/api/gridspace/note-link', () => HttpResponse.error())] } } } satisfies StoryObj<typeof Preview>;
