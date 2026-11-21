/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { update } from 'idb-keyval';
import type { entities } from 'misskey-js';

export type PostingChannel = {
	origin: string;
	channelId: string;
	name: string;
	color: string;
	isSensitive?: boolean;
	allowRenoteToExternal?: boolean;
};

export type ChannelRoute = Pick<PostingChannel, 'origin' | 'channelId'>;

export type NotePlacement = {
	canonicalUri?: string;
	isArchived?: boolean;
	isSensitive?: boolean;
	allowRenoteToExternal?: boolean;
	origin: string;
	channelId: string;
	name?: string | null;
	color?: string | null;
	state: 'active' | 'pending' | 'failed' | 'removed' | 'unavailable';
	canRemove?: boolean;
	canRetry?: boolean;
};

export type NoteDestinations = {
	includeDefault: boolean;
	channels: PostingChannel[];
};

export type PendingNoteCreate = {
	accountId: string;
	clientRequestId: string;
	inputHash: string;
	input: entities.NotesCreateRequest;
	retried?: boolean;
	draftSnapshot: string;
};

// Every writer of the localStorage draft map must hold the same lock, even for different draft keys.
export async function withDraftLock<T>(action: () => T, requireAtomic = false): Promise<T> {
	if (navigator.locks) return await navigator.locks.request('misskey.noteDrafts', action);
	let result: T;
	let entered = false;
	try {
		// An IndexedDB read/write transaction also serializes callbacks across tabs.
		await update('misskey.noteDrafts.lock', () => {
			entered = true;
			result = action();
			return true;
		});
		return result!;
	} catch (error) {
		if (requireAtomic || entered) throw error;
		return action();
	}
}

export function initialDestinations(channel?: PostingChannel | null): NoteDestinations {
	return { includeDefault: channel == null, channels: channel ? [channel] : [] };
}

export function sameChannel(a: ChannelRoute, b: ChannelRoute): boolean {
	return a.origin === b.origin && a.channelId === b.channelId;
}

export function placementParams(destinations: NoteDestinations, localOrigin: string) {
	const local = destinations.channels.filter(channel => channel.origin === localOrigin);
	const peers = destinations.channels.filter(channel => channel.origin !== localOrigin);
	return {
		includeDefault: destinations.includeDefault,
		channelIds: local.map(channel => channel.channelId).sort(),
		channelTargets: peers.map(({ origin, channelId }) => ({ origin, channelId }))
			.sort((a, b) => a.origin.localeCompare(b.origin) || a.channelId.localeCompare(b.channelId)),
	};
}

export function canUseDestinations(destinations: NoteDestinations, visibility: string): boolean {
	if (!destinations.channels.length) return destinations.includeDefault;
	return visibility === 'public' && (!destinations.includeDefault || destinations.channels.every(channel => channel.allowRenoteToExternal !== false));
}

export async function startNoteCreate(accountId: string, input: entities.NotesCreateRequest, draftSnapshot: string): Promise<PendingNoteCreate> {
	// Capture the exact JSON payload. Vue refs, plugins and the API client's token injection must not mutate a retry.
	const snapshot = JSON.parse(JSON.stringify(input)) as entities.NotesCreateRequest;
	Reflect.deleteProperty(snapshot, 'i');
	return { accountId, clientRequestId: crypto.randomUUID(), input: snapshot, inputHash: await noteInputHash(snapshot), draftSnapshot };
}

export async function recoverNoteCreate<T>(
	pending: PendingNoteCreate,
	status: (clientRequestId: string) => Promise<{ status: 'missing' | 'created' | 'deleted'; createdNote: T | null }>,
	draftHash: () => Promise<string>,
) {
	const result = await status(pending.clientRequestId);
	if (result.status === 'missing') return null;
	return { ...result, clearDraft: pending.draftSnapshot === await draftHash() };
}

export async function noteInputHash(input: object): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(input));
	const hash = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
