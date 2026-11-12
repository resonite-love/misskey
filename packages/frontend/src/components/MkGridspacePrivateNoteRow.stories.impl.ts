/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { ref } from 'vue';
import { Default as Note } from './MkGridspacePrivateNote.stories.impl.js';
import MkGridspacePrivateNoteRow from './MkGridspacePrivateNoteRow.vue';
import MkButton from './MkButton.vue';
import { suspendPrivateNotes } from '@/utility/gridspace-note-suspension.js';
import { i18n } from '@/i18n.js';

export const Default = {
	render: args => ({ components: { MkGridspacePrivateNoteRow }, setup: () => ({ args }), template: '<MkGridspacePrivateNoteRow v-bind="args" />' }),
	args: { note: Note.args.note },
} satisfies StoryObj<typeof MkGridspacePrivateNoteRow>;

export const Reauthorizing = {
	...Default,
	render: args => ({
		components: { MkGridspacePrivateNoteRow, MkButton },
		setup: () => {
			const note = ref(args.note);
			return { note, i18n, suspend: () => { note.value = suspendPrivateNotes([note.value])[0]; }, resume: () => { note.value = args.note; } };
		},
		template: '<div><MkButton @click="suspend">{{ i18n.ts.hide }}</MkButton><MkButton @click="resume">{{ i18n.ts.reload }}</MkButton><MkGridspacePrivateNoteRow :note="note" /></div>',
	}),
} satisfies StoryObj<typeof MkGridspacePrivateNoteRow>;
