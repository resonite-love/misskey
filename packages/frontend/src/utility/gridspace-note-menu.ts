/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Ref } from 'vue';
import type { entities } from 'misskey-js';
import type { MenuItem } from '@/types/menu.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { getNoteMenu } from '@/utility/get-note-menu.js';
import { copyToClipboard } from '@/utility/copy-to-clipboard.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { url } from '@@/js/config.js';

type PrivateNote = entities.GridspacePrivateNotesResponse['notes'][number];

export async function getGridspaceNoteMenu(note: PrivateNote, detailPath: string, translation: Ref<entities.NotesTranslateResponse | null>, translating: Ref<boolean>) {
	// Only the server's independently checked normal note may enter ordinary APIs.
	// Never substitute the source ID or delegated body into a normal Note object.
	if (!note.channelId && ['public', 'home'].includes(note.visibility)) {
		try {
			const local = await misskeyApi('gridspace/renote-target', { noteId: note.id });
			return getNoteMenu({ note: local, translation, translating });
		} catch { /* Keep non-mutating actions available during an outage or changed visibility. */ }
	}
	let active = true;
	const menu: MenuItem[] = [{
		text: i18n.ts.details, icon: 'ti ti-info-circle', action: () => os.pageWindow(detailPath),
	}, {
		text: i18n.ts.copyContent, icon: 'ti ti-copy', action: () => copyToClipboard(note.text ?? ''),
	}, {
		text: i18n.ts.copyLink, icon: 'ti ti-link', action: () => copyToClipboard(`${url}${detailPath}`),
	}, {
		text: i18n.ts.showOnRemote, icon: 'ti ti-external-link', action: () => { window.open(note.uri, '_blank', 'noopener'); },
	}];
	for (const item of menu) {
		if (item && typeof item === 'object' && 'action' in item) {
			const action = item.action;
			item.action = event => { if (active) action(event); };
		}
	}
	return { menu, cleanup: () => { active = false; } };
}
