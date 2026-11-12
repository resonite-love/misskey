/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { HttpResponse, http } from 'msw';
import MkGridspaceClips from './MkGridspaceClips.vue';

export const Empty = {
	render: args => ({ components: { MkGridspaceClips }, setup: () => ({ args }), template: '<MkGridspaceClips v-bind="args" />' }),
	args: {},
	parameters: { msw: { handlers: [http.post('/api/clips/list', () => HttpResponse.json([])), http.post('/api/gridspace/collections', () => HttpResponse.json({ enabled: false }))] } },
} satisfies StoryObj<typeof MkGridspaceClips>;
export const PeerUnavailable = { ...Empty, parameters: { msw: { handlers: [http.post('/api/clips/list', () => HttpResponse.json([])), http.post('/api/gridspace/collections', () => HttpResponse.error())] } } } satisfies StoryObj<typeof MkGridspaceClips>;
