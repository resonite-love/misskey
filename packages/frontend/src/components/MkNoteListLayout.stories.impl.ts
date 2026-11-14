/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import MkNoteListLayout from './MkNoteListLayout.vue';
import type { StoryObj } from '@storybook/vue3';
export const Default = {
	render: args => ({ components: { MkNoteListLayout }, setup: () => ({ args }), template: '<MkNoteListLayout v-bind="args"><template #default="{ item }"><p style="padding: 24px">{{ item.id }}</p></template></MkNoteListLayout>' }),
	args: { items: [{ id: 'first', createdAt: '2026-11-15T01:00:00Z' }, { id: 'second', createdAt: '2026-11-13T01:00:00Z' }], getKey: (item: unknown) => (item as { id: string }).id, getDate: (item: unknown) => (item as { createdAt: string }).createdAt },
} satisfies StoryObj<typeof MkNoteListLayout>;
