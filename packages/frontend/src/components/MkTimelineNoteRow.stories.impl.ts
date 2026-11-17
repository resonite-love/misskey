/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { StoryObj } from '@storybook/vue3';
import { Default as Note } from './MkGridspacePrivateNote.stories.impl.js';
import MkTimelineNoteRow from './MkTimelineNoteRow.vue';

export const Default = {
	render: args => ({ components: { MkTimelineNoteRow }, setup: () => ({ args }), template: '<MkTimelineNoteRow v-bind="args" />' }),
	args: { row: { key: Note.args.note.uri, createdAt: Note.args.note.createdAt, kind: 'private', note: Note.args.note, leased: true } },
} satisfies StoryObj<typeof MkTimelineNoteRow>;

export const Reauthorizing = {
	...Default,
	args: { row: { key: 'https://example.test/notes/reauthorizing', createdAt: '2026-11-17T00:00:00.000Z', kind: 'placeholder', leased: true } },
} satisfies StoryObj<typeof MkTimelineNoteRow>;
