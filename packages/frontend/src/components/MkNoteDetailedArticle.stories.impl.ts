/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import MkNoteDetailedArticle from './MkNoteDetailedArticle.vue';
import type { StoryObj } from '@storybook/vue3';
export const Default = { render: args => ({ components: { MkNoteDetailedArticle }, setup: () => ({ args }), template: '<MkNoteDetailedArticle v-bind="args" />' }), args: {} } satisfies StoryObj<typeof MkNoteDetailedArticle>;
