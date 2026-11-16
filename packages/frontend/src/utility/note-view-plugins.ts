/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { entities } from 'misskey-js';
import { getPluginHandlers } from '@/plugin.js';
import { deepClone } from '@/utility/clone.js';

/** Run the same display hooks for normal notes and delegated note views. */
export function applyNoteViewPlugins(note: entities.Note): entities.Note | null {
	let result: entities.Note | null = deepClone(note);
	for (const interruptor of getPluginHandlers('note_view_interruptor')) {
		if (result == null) return null;
		try {
			result = interruptor.handler(result);
			if (result == null) return null;
		} catch (error) {
			console.error(error);
		}
	}
	return result;
}
