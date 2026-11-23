/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

type Distribution = {
	channelId?: string | null;
	includeDefault?: boolean | null;
	multiNoteKind?: 'root' | 'conversation-reply' | null;
};

export function isConversationOnly(note: Distribution): boolean {
	return note.multiNoteKind === 'conversation-reply';
}

export function includesDefault(note: Distribution): boolean {
	return !isConversationOnly(note) && (note.includeDefault ?? (note.channelId == null));
}

export function defaultNoteCondition(alias = 'note'): string {
	return `(${alias}."multiNoteKind" IS DISTINCT FROM 'conversation-reply' AND
		(${alias}."includeDefault" IS TRUE OR (${alias}."includeDefault" IS NULL AND ${alias}."channelId" IS NULL)))`;
}

// A peer placement refers to a real ordinary mirror by URI. Legacy Announce rows can use /activity.
export function mirrorPlacementCondition(alias: string): string {
	return `${defaultNoteCondition(alias)} AND ${alias}."gridspaceShared" AND ${alias}."userHost" IS NOT NULL AND peer_placement."includeDefault"
		AND ${alias}.visibility IN ('public', 'home') AND peer_placement.state = 'active'
		AND peer_placement."canonicalUri" = CASE WHEN right(${alias}.uri, 9) = '/activity' THEN left(${alias}.uri, -9) ELSE ${alias}.uri END
		AND (${alias}.uri = peer_placement."canonicalUri" OR NOT EXISTS (SELECT 1 FROM note canonical_note WHERE canonical_note.uri = peer_placement."canonicalUri" COLLATE "default"))`;
}

/** The argument and alias must be trusted SQL expressions. Bind channel IDs with query parameters. */
export function channelPlacementCondition(channelSQL: string, alias = 'note', includeConversation = false): string {
	const direct = `(${alias}."multiNoteKind" IS DISTINCT FROM 'conversation-reply' AND (
		EXISTS (SELECT 1 FROM note_channel_placement placement WHERE placement."noteId" = ${alias}.id
			AND placement."channelId" = ${channelSQL} AND placement.state = 'active')
		OR EXISTS (SELECT 1 FROM gridspace_channel_placement peer_placement WHERE peer_placement."channelId" = ${channelSQL} AND ${mirrorPlacementCondition(alias)})
		OR (${alias}."channelId" = ${channelSQL} AND NOT EXISTS (
			SELECT 1 FROM note_channel_placement placement WHERE placement."noteId" = ${alias}.id
				AND placement."channelId" = ${alias}."channelId" AND placement.state <> 'active'))))`;
	if (!includeConversation) return direct;
	return `(${direct} OR (${alias}."multiNoteKind" = 'conversation-reply' AND ${alias}."includeDefault" = false AND ${alias}.uri IS NULL AND EXISTS (
		SELECT 1 FROM note conversation_root JOIN note_channel_placement conversation_placement ON conversation_placement."noteId" = conversation_root.id
		WHERE conversation_root.id = ${alias}."multiNoteRootId" AND ${alias}."threadId" = conversation_root.id
			AND conversation_root."multiNoteKind" = 'root' AND conversation_root."includeDefault" = false
			AND conversation_placement."channelId" = ${channelSQL} AND conversation_placement.state = 'active')))`;
}

export function activeChannelIdsQuery(alias = 'note'): string {
	return `SELECT placement."channelId" FROM note_channel_placement placement
		WHERE placement."noteId" = ${alias}.id AND placement.state = 'active'
		UNION ALL SELECT peer_placement."channelId" FROM gridspace_channel_placement peer_placement WHERE ${mirrorPlacementCondition(alias)}
		UNION ALL SELECT ${alias}."channelId" WHERE ${alias}."channelId" IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM note_channel_placement placement WHERE placement."noteId" = ${alias}.id
				AND placement."channelId" = ${alias}."channelId")`;
}

export type NoteListing =
	| { kind: 'default' }
	| { kind: 'channel'; channelId: string }
	| { kind: 'profile'; viewerId?: string }
	| { kind: 'home' | 'social'; viewerId: string; linkedUserId: string | null }
	| { kind: 'relay-social'; viewerId: string; linkedUserId?: string | null; withLocalOnly: boolean; relayHosts: string[] };

/** An active route must satisfy the policies of the list being read, including reads of stale fanout IDs. */
export function noteListingCondition(list: NoteListing): [string, Record<string, unknown>] {
	const ordinary = defaultNoteCondition();
	if (list.kind === 'default') return [ordinary, {}];
	if (list.kind === 'channel') return [channelPlacementCondition(':routeChannel', 'note', true), { routeChannel: list.channelId }];

	const placed = `note."multiNoteKind" IS DISTINCT FROM 'conversation-reply' AND route.id IN (${activeChannelIdsQuery()})`;
	const unmuted = `NOT EXISTS (SELECT 1 FROM channel_muting cm
		WHERE cm."channelId" = route.id AND cm."userId" = :routeViewer AND (cm."expiresAt" IS NULL OR cm."expiresAt" > CURRENT_TIMESTAMP))`;
	if (list.kind === 'profile') {
		const target = `EXISTS (SELECT 1 FROM channel route WHERE ${placed}
			AND (route."isSensitive" = false OR note."userId" = :routeViewer) AND ${unmuted})`;
		return [`(${ordinary} OR ${target})`, { routeViewer: list.viewerId ?? null }];
	}

	const followedChannel = `EXISTS (SELECT 1 FROM channel_following cf JOIN channel route ON route.id = cf."followeeId"
		WHERE cf."followerId" = :routeViewer AND ${placed} AND ${unmuted})`;
	const authors = [`note."userId" = :routeViewer`, `EXISTS (SELECT 1 FROM following f WHERE f."followerId" = :routeViewer AND f."followeeId" = note."userId")`];
	const params: Record<string, unknown> = { routeViewer: list.viewerId };
	if (list.kind === 'relay-social') {
		params.routeHosts = list.relayHosts;
		authors.push(`(note.visibility = 'public' AND (note."userHost" IS NULL OR note."userHost" = ANY(:routeHosts))${list.withLocalOnly ? '' : ' AND note."localOnly" = false'})`);
		if (list.linkedUserId !== undefined) {
			params.routeLinked = list.linkedUserId;
			authors.push(`(note."userId" = :routeLinked AND note.visibility IN ('public', 'home'))`);
		}
	} else {
		params.routeLinked = list.linkedUserId;
		authors.push(`(note."userId" = :routeLinked AND note.visibility IN ('public', 'home'))`);
		if (list.kind === 'social') authors.push(`(note.visibility = 'public' AND (note."userHost" IS NULL OR note."gridspaceShared"))`);
	}
	return [`((${ordinary} AND (${authors.join(' OR ')})) OR ${followedChannel})`, params];
}

/** Existing single-channel posts remain eligible for surfaces that historically included them. */
export function defaultOrLegacyChannelCondition(): string {
	return `(${defaultNoteCondition()} OR (note."multiNoteKind" IS NULL AND ${channelPlacementCondition('note."channelId"')}))`;
}
