/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Display-only actors: remote identifiers never enter the local note API. */
export type ReactionActor = { uri: string; username: string; host: string; name: string | null; avatarUrl: string };
export type ReactionTransport = {
	canToggle: () => boolean;
	toggle: (reaction: string) => Promise<void>;
	previews: (reaction: string) => ReactionActor[];
	users: (reaction: string) => Promise<ReactionActor[]>;
	showUsers: (reaction: string) => void;
};
