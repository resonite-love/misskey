/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import MkNoteInfo from './MkNoteInfo.vue';
import type { StoryObj } from '@storybook/vue3';
export const Default = { render: args => ({ components: { MkNoteInfo }, setup: () => ({ args }), template: '<MkNoteInfo v-bind="args" />' }), args: { 'to': '/notes/example', 'createdAt': '2026-11-14T00:00:00Z', 'visibility': 'public' } } satisfies StoryObj<typeof MkNoteInfo>;
