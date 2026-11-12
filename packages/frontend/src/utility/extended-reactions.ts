/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { misskeyApi } from '@/utility/misskey-api.js';
import { noteEvents } from '@/composables/use-note-capture.js';
import type { entities } from 'misskey-js';

export function supportsExtendedReactions(note: entities.Note): boolean {
	return note.user.host == null || note.gridspaceReactions === true || (note.gridspaceShared === true && !note.channel && ['public', 'home'].includes(note.visibility));
}

export type ExtendedReactionState = {
	noteId: string;
	reactions: Record<string, number>;
	reactionEmojis: Record<string, string>;
	myReaction: string | null;
	myReactions: string[];
	shared?: boolean;
	push?: boolean;
	complete?: boolean;
	revision?: string;
};

const subscriptions = new Map<() => void, boolean>();
let refreshTimer: number | undefined;
const resume = () => {
	if (!window.document.hidden) for (const callback of subscriptions.keys()) callback();
};

/** Push-capable peers use note streams; polling remains only for older peers/modes. */
export function watchSharedReactions(refresh: () => void, push = false): () => void {
	if (subscriptions.size === 0) window.document.addEventListener('visibilitychange', resume);
	subscriptions.set(refresh, push);
	refreshTimer ??= window.setInterval(() => {
		if (!window.document.hidden) for (const [callback, usesPush] of subscriptions) if (!usesPush) callback();
	}, 10000);
	return () => {
		subscriptions.delete(refresh);
		if (subscriptions.size === 0) {
			window.clearInterval(refreshTimer); refreshTimer = undefined;
			window.document.removeEventListener('visibilitychange', resume);
		}
	};
}

// Batch timeline requests and share each response between repeated note views.
const pending = new Map<string, { resolve: (state: ExtendedReactionState | undefined) => void; reject: (reason: unknown) => void; }[]>();
let scheduled = false;

export function fetchExtendedReactions(noteId: string): Promise<ExtendedReactionState | undefined> {
	const promise = new Promise<ExtendedReactionState | undefined>((resolve, reject) => {
		const callbacks = pending.get(noteId) ?? [];
		callbacks.push({ resolve, reject });
		pending.set(noteId, callbacks);
	});
	if (!scheduled) {
		scheduled = true;
		queueMicrotask(async () => {
			scheduled = false;
			const requests = [...pending.entries()];
			pending.clear();
			for (let offset = 0; offset < requests.length; offset += 100) {
				const batch = requests.slice(offset, offset + 100);
				try {
					const states = await misskeyApi('notes/extended-reactions/show', { noteIds: batch.map(([id]) => id) });
					for (const [id, callbacks] of batch) {
						const state = states.find(item => item.noteId === id);
						for (const callback of callbacks) callback.resolve(state);
					}
				} catch (error) {
					for (const [, callbacks] of batch) for (const callback of callbacks) callback.reject(error);
				}
			}
		});
	}
	return promise;
}

export async function addExtendedReaction(noteId: string, reaction: string): Promise<void> {
	await misskeyApi('notes/extended-reactions/create', { noteId, reaction });
	noteEvents.emit(`extendedUpdated:${noteId}`);
}

export async function deleteExtendedReaction(noteId: string, reaction: string): Promise<void> {
	await misskeyApi('notes/extended-reactions/delete', { noteId, reaction });
	noteEvents.emit(`extendedUpdated:${noteId}`);
}
