/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { HttpResponse, http } from 'msw';
import MkGridspaceListImport from './MkGridspaceListImport.vue';

const link = http.post('/api/gridspace/link', () => HttpResponse.json({ channelsEnabled: true, initiator: true, state: 'active' }));
export const Complete = {
	render: args => ({ components: { MkGridspaceListImport }, setup: () => ({ args }), template: '<MkGridspaceListImport v-bind="args" />' }),
	args: {},
	parameters: { msw: { handlers: [link, http.post('/api/gridspace/list-import', () => HttpResponse.json({ started: true, complete: true, total: 4, done: 4, pending: 0, failed: 0 })), http.post('/api/users/lists/list', () => HttpResponse.json([]))] } },
} satisfies StoryObj<typeof MkGridspaceListImport>;
export const Failed = { ...Complete, parameters: { msw: { handlers: [link, http.post('/api/gridspace/list-import', () => HttpResponse.error())] } } } satisfies StoryObj<typeof MkGridspaceListImport>;
