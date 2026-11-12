/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { HttpResponse, http } from 'msw';
import MkGridspaceSignupGuide from './MkGridspaceSignupGuide.vue';

export const Default = {
	render: args => ({ components: { MkGridspaceSignupGuide }, setup: () => ({ args }), template: '<MkGridspaceSignupGuide v-bind="args" />' }),
	parameters: { msw: { handlers: [http.post('/api/gridspace/link', () => HttpResponse.json({ enabled: true, state: 'unlinked', peerOrigin: 'https://resonite.love' }))] } },
} satisfies StoryObj<typeof MkGridspaceSignupGuide>;
export const Disabled = {
	...Default,
	parameters: { msw: { handlers: [http.post('/api/gridspace/link', () => HttpResponse.json({ enabled: false, state: 'unlinked', peerOrigin: null }))] } },
} satisfies StoryObj<typeof MkGridspaceSignupGuide>;
