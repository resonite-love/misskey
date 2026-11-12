/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { entities } from 'misskey-js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { noteEvents } from '@/composables/use-note-capture.js';

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
	reactionVersions?: Record<string, string>;
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
const inFlight = new Map<string, Promise<ExtendedReactionState | undefined>>();

export function fetchExtendedReactions(noteId: string): Promise<ExtendedReactionState | undefined> {
	const existing = inFlight.get(noteId);
	if (existing) return existing;
	const promise = new Promise<ExtendedReactionState | undefined>((resolve, reject) => {
		const callbacks = pending.get(noteId) ?? [];
		callbacks.push({ resolve, reject });
		pending.set(noteId, callbacks);
	});
	inFlight.set(noteId, promise);
	const clear = () => { inFlight.delete(noteId); };
	void promise.then(clear, clear);
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

// Repeated note views and hover tooltips share the same short-lived reactor page.
// The revision is part of the key, so changes never reuse an earlier page.
const reactorPages = new Map<string, { expires: number; promise: Promise<entities.NoteReaction[]> }>();
export function fetchReactionUsers(noteId: string, type: string, extended: boolean, count: number, version?: string | number): Promise<entities.NoteReaction[]> {
	const now = Date.now();
	for (const [key, entry] of reactorPages) if (entry.expires <= now) reactorPages.delete(key);
	const key = JSON.stringify([noteId, type, extended, count, version]);
	const cached = reactorPages.get(key);
	if (cached) return cached.promise;
	const promise = misskeyApi(extended ? 'notes/extended-reactions/list' : 'notes/reactions', { noteId, type, limit: 10 });
	if (reactorPages.size >= 500) reactorPages.delete(reactorPages.keys().next().value!);
	const entry = { expires: Infinity, promise };
	reactorPages.set(key, entry);
	void promise.then(() => { entry.expires = Date.now() + 1000; }, () => { if (reactorPages.get(key) === entry) reactorPages.delete(key); });
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
