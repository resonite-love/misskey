/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { http, HttpResponse } from 'msw';
import MkGridspaceContentList from './MkGridspaceContentList.vue';
import { galleryPost } from '../../.storybook/fakes.js';

const local = { ...galleryPost(), id: 'local' };
const remote = { ...galleryPost(true), id: 'remote', gridspaceOrigin: 'https://r.example', user: { ...galleryPost().user, host: 'r.example' } };
export const Default = {
	render: args => ({ components: { MkGridspaceContentList }, setup: () => ({ args }), template: '<MkGridspaceContentList v-bind="args" />' }),
	args: { kind: 'gallery' },
	parameters: { msw: { handlers: [http.post('/api/gallery/posts', () => HttpResponse.json([local])), http.post('/api/gridspace/content', () => HttpResponse.json({ origin: 'https://r.example', pages: [], gallery: [remote], next: null }))] } },
} satisfies StoryObj<typeof MkGridspaceContentList>;
export const Unavailable = { ...Default, parameters: { msw: { handlers: [http.post('/api/gallery/posts', () => HttpResponse.json([local])), http.post('/api/gridspace/content', () => HttpResponse.error())] } } } satisfies StoryObj<typeof MkGridspaceContentList>;
export const Empty = { ...Default, parameters: { msw: { handlers: [http.post('/api/gallery/posts', () => HttpResponse.json([])), http.post('/api/gridspace/content', () => HttpResponse.json({ origin: null, pages: [], gallery: [], next: null }))] } } } satisfies StoryObj<typeof MkGridspaceContentList>;
