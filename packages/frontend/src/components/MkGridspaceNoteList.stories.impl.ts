/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { HttpResponse, http } from 'msw';
import MkGridspaceNoteList from './MkGridspaceNoteList.vue';
import { Default as Private } from './MkGridspacePrivateNote.stories.impl.js';
import { note } from '../../.storybook/fakes.js';

const normal = { ...note(), createdAt: '2026-11-12T00:00:01Z' };
const grant = http.post('/api/gridspace/private-grant', () => HttpResponse.json({ available: true, granted: true }));
const ordinary = http.post('/api/gridspace/search', () => HttpResponse.json({ notes: [normal], users: [], cursor: null, peerAvailable: true }));
const privatePage = (notes: unknown[]) => ({ notes, cursor: null, scannedThrough: null, observedAt: '2026-11-12T00:01:00Z' });
export const Default = {
	render: args => ({ components: { MkGridspaceNoteList }, setup: () => ({ args }), template: '<MkGridspaceNoteList v-bind="args" />' }),
	args: { source: { kind: 'search', query: 'notes' } },
	parameters: { msw: { handlers: [grant, ordinary, http.post('/api/gridspace/private-notes', () => HttpResponse.json(privatePage([Private.args.note])))] } },
} satisfies StoryObj<typeof MkGridspaceNoteList>;

export const NoPrivateMatches = {
	...Default,
	parameters: { msw: { handlers: [grant, ordinary, http.post('/api/gridspace/private-notes', () => HttpResponse.json(privatePage([])))] } },
} satisfies StoryObj<typeof MkGridspaceNoteList>;

export const Unavailable = {
	...Default,
	parameters: { msw: { handlers: [grant, ordinary, http.post('/api/gridspace/private-notes', () => HttpResponse.error())] } },
} satisfies StoryObj<typeof MkGridspaceNoteList>;

export const Empty = {
	...Default,
	parameters: { msw: { handlers: [grant,
		http.post('/api/gridspace/search', () => HttpResponse.json({ notes: [], users: [], cursor: null, peerAvailable: true })),
		http.post('/api/gridspace/private-notes', () => HttpResponse.json(privatePage([]))),
	] } },
} satisfies StoryObj<typeof MkGridspaceNoteList>;
