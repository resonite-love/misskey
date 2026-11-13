/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { http, HttpResponse } from 'msw';
import MkGridspaceDrive from './MkGridspaceDrive.vue';
import { file, folder } from '../../.storybook/fakes.js';

const page = { enabled: true, granted: true, origin: 'https://r.example', files: [file()], folders: [folder()], path: [], filesNext: null, foldersNext: null };
export const Default = {
	render: args => ({ components: { MkGridspaceDrive }, setup: () => ({ args }), template: '<MkGridspaceDrive v-bind="args" />' }),
	args: { selected: [] },
	parameters: { msw: { handlers: [http.post('/api/gridspace/drive', () => HttpResponse.json(page))] } },
} satisfies StoryObj<typeof MkGridspaceDrive>;
export const NeedsGrant = { ...Default, parameters: { msw: { handlers: [http.post('/api/gridspace/drive', () => HttpResponse.json({ error: { code: 'GRIDSPACE_DRIVE_UNAVAILABLE', info: { reason: 'AUTHORIZATION_REVOKED' } } }, { status: 403 }))] } } } satisfies StoryObj<typeof MkGridspaceDrive>;
export const Failed = { ...Default, parameters: { msw: { handlers: [http.post('/api/gridspace/drive', () => HttpResponse.error())] } } } satisfies StoryObj<typeof MkGridspaceDrive>;
