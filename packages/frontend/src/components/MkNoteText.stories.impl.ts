/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import MkNoteText from './MkNoteText.vue';
import type { StoryObj } from '@storybook/vue3';
export const Default = { render: args => ({ components: { MkNoteText }, setup: () => ({ args }), template: '<MkNoteText v-bind="args" />' }), args: { 'text': 'Shared note :smile:' } } satisfies StoryObj<typeof MkNoteText>;
