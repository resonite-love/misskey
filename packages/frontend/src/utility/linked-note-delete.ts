/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { entities } from 'misskey-js';
import type { MenuButton } from '@/types/menu.js';
import { $i } from '@/i.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { globalEvents } from '@/events.js';

export function getLinkedNoteDeleteMenu(note: entities.Note, state: entities.NotesStateResponse): MenuButton | null {
	const target = state.gridspaceDeleteTarget;
	if (!target || !$i) return null;
	const viewerId = $i.id;
	const account = `@${note.user.username}@${note.user.host}`;
	return {
		icon: 'ti ti-trash', text: i18n.ts.delete, danger: true, caption: account,
		action: async () => {
			const { canceled } = await os.confirm({ type: 'warning', title: account, text: i18n.ts.noteDeleteConfirm });
			if (canceled || $i?.id !== viewerId) return;
			const result = await os.apiWithDialog('gridspace/note-menu', { noteId: target.noteId, channelId: target.channelId, expectedActorUri: target.actorUri, action: 'delete' });
			if (result.deleted) {
				globalEvents.emit('noteDeleted', note.id);
				globalEvents.emit('gridspaceNoteDeleted', target.noteId);
			}
		},
	};
}
