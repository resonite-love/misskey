/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type SearchOptions = {
	query: string;
	userId?: string;
	rangeStartAt?: number;
	rangeEndAt?: number;
};

/** This protocol never accepts an old account's delegated credentials. */
export type SearchPeerRequest = Omit<SearchOptions, 'userId'> & {
	kind: 'notes' | 'users';
	viewerId?: string;
	targetId?: string;
	link?: { id: string; generation: number; counterpartId: string };
	before?: string;
	head?: string;
	ids?: string[];
	limit: number;
};
