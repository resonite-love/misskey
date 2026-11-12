/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { HttpResponse, http } from 'msw';
import { Default as Note } from './MkGridspacePrivateNote.stories.impl.js';
import MkGridspacePrivateNotes from './MkGridspacePrivateNotes.vue';

const grant = http.post('/api/gridspace/private-grant', () => HttpResponse.json({ enabled: true, granted: true, available: true, peerOrigin: 'https://peer.example', authorizationUrl: null, clientKey: null }));
export const Default = {
	render: args => ({ components: { MkGridspacePrivateNotes }, setup: () => ({ args }), template: '<MkGridspacePrivateNotes v-bind="args" />' }),
	args: { params: { mode: 'home' }, alwaysShow: true },
	parameters: { msw: { handlers: [grant, http.post('/api/gridspace/private-notes', () => HttpResponse.json({ notes: [Note.args.note], cursor: null }))] } },
} satisfies StoryObj<typeof MkGridspacePrivateNotes>;

export const Unavailable = {
	...Default,
	parameters: { msw: { handlers: [grant, http.post('/api/gridspace/private-notes', () => HttpResponse.json({ error: { code: 'GRIDSPACE_PRIVATE_UNAVAILABLE' } }, { status: 403 }))] } },
} satisfies StoryObj<typeof MkGridspacePrivateNotes>;

export const ConsentRequired = {
	...Default,
	parameters: { msw: { handlers: [http.post('/api/gridspace/private-grant', () => HttpResponse.json({ enabled: true, granted: false, available: true, peerOrigin: 'https://peer.example', authorizationUrl: null, clientKey: null }))] } },
} satisfies StoryObj<typeof MkGridspacePrivateNotes>;
