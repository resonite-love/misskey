/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { mirrorPlacementCondition } from '@/misc/note-distribution.js';
import { searchNoteTimeSql } from '../search-visibility.js';

/** $1 = target channel, $2 = this server's origin. Include unconverted single-channel rows. */
export function activeChannelEntries(idMethod: string, followed = false): string {
	const channels = followed ? 'IN (SELECT id FROM watched)' : '= $1';
	return `SELECT p."canonicalUri", p."sortAt", note.id AS "localNoteId", note.id AS "originNoteId",
			$2::text AS "noteOrigin", coalesce(note."includeDefault", false) AS "includeDefault",
			(note."multiNoteKind" IS NULL) AS legacy, coalesce(author.uri, $2 || '/users/' || author.id) AS "authorUri", p."channelId"
		FROM note_channel_placement p JOIN note ON note.id = p."noteId" JOIN "user" author ON author.id = note."userId"
		WHERE p."channelId" ${channels} AND p.state = 'active'
		UNION ALL
		SELECT peer_placement."canonicalUri", peer_placement."sortAt", mirror.id, peer_placement."originNoteId",
			peer_placement."noteOrigin", peer_placement."includeDefault", false, peer_placement."authorUri", peer_placement."channelId"
		FROM gridspace_channel_placement peer_placement LEFT JOIN note mirror ON
			mirror.uri IN (peer_placement."canonicalUri", peer_placement."canonicalUri" || '/activity') AND ${mirrorPlacementCondition('mirror')}
		WHERE peer_placement."channelId" ${channels} AND peer_placement.state = 'active'
		UNION ALL
		SELECT coalesce(note.uri, $2 || '/notes/' || note.id), to_timestamp(${searchNoteTimeSql(idMethod)} / 1000.0),
			note.id, note.id, $2::text, false, true, coalesce(author.uri, $2 || '/users/' || author.id), note."channelId"
		FROM note JOIN "user" author ON author.id = note."userId" WHERE note."channelId" ${channels} AND note."multiNoteKind" IS NULL AND NOT EXISTS
			(SELECT 1 FROM note_channel_placement p WHERE p."channelId" = note."channelId" AND p."noteId" = note.id)`;
}

type PlacementChange = {
	kind: 'place-add' | 'place-remove' | 'origin-delete' | 'place-policy'; canonicalUri: string;
	channelId: string; channelOrigin: string; sourceRevision?: string | number; targetRevision?: string | number;
	eventId?: string; noteId?: string | null;
};

export async function recordPlacementChange(manager: EntityManager, event: PlacementChange): Promise<void> {
	await manager.query(`INSERT INTO gridspace_timeline_outbox (kind, "canonicalUri", "channelId", "channelOrigin",
		"sourceRevision", "targetRevision", "eventId", "noteId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ("eventId") DO NOTHING`,
	[event.kind, event.canonicalUri, event.channelId, event.channelOrigin, event.sourceRevision ?? null,
		event.targetRevision ?? null, event.eventId ?? randomUUID(), event.noteId ?? null]);
	await manager.query("SELECT pg_notify('gridspace_timeline_changed', '')");
}

export async function recordChannelPolicy(manager: EntityManager, channelId: string, origin: string): Promise<void> {
	await manager.query(`INSERT INTO gridspace_timeline_outbox (kind, "channelId", "channelOrigin", "canonicalUri",
		"noteId", "sourceRevision", "targetRevision", "eventId")
		SELECT 'place-policy', $1, $2, active.uri, active.note, active.source, active.target, gen_random_uuid() FROM (
			SELECT "canonicalUri" AS uri, "noteId" AS note, 1::bigint AS source, 1::bigint AS target
			FROM note_channel_placement WHERE "channelId" = $1 AND state = 'active'
			UNION ALL SELECT "canonicalUri", NULL, "sourceRevision", "targetRevision" FROM gridspace_channel_placement
			WHERE "channelId" = $1 AND state = 'active') active`, [channelId, origin]);
	await manager.query("SELECT pg_notify('gridspace_timeline_changed', '')");
}

/** Caller holds the channel row lock throughout the placement or pin mutation. */
export async function refreshPlacementChannel(manager: EntityManager, channelId: string, origin: string, idMethod: string): Promise<void> {
	const entries = activeChannelEntries(idMethod);
	const params = [channelId, origin];
	// First touch also converts pins saved by older clients, preserving their order.
	await manager.query(`WITH active AS (${entries})
		INSERT INTO channel_placement_pin ("channelId", "canonicalUri", rank)
		SELECT $1, active."canonicalUri", min(pin.ord)::int - 1 FROM channel c,
			unnest(c."pinnedNoteIds") WITH ORDINALITY pin(id, ord) JOIN active ON active."localNoteId" = pin.id
		WHERE c.id = $1 GROUP BY active."canonicalUri" ON CONFLICT DO NOTHING`, params);
	await manager.query(`WITH active AS (${entries}) DELETE FROM channel_placement_pin p WHERE p."channelId" = $1
		AND NOT EXISTS (SELECT 1 FROM active a WHERE a."canonicalUri" = p."canonicalUri")`, params);
	await manager.query(`WITH active AS (${entries}) UPDATE channel c SET
		"usersCount" = (SELECT count(DISTINCT "authorUri") FROM active),
		"notesCount" = (SELECT count(DISTINCT "canonicalUri") FROM active),
		"lastNotedAt" = (SELECT max("sortAt") FROM active),
		"pinnedNoteIds" = ARRAY(SELECT a."localNoteId" FROM channel_placement_pin p
			JOIN active a USING ("canonicalUri") WHERE p."channelId" = $1 AND a."localNoteId" IS NOT NULL
			GROUP BY a."localNoteId" ORDER BY min(p.rank), a."localNoteId")
		WHERE c.id = $1`, params);
}

/** A local-ID request carries no read revision. A remote pin omitted by a stale editor
 * may have acquired a mirror since the editor loaded. Explicit URI edits can remove it. */
export async function replacePlacementPins(manager: EntityManager, channelId: string, origin: string, idMethod: string,
	request: { ids?: string[]; uris?: string[] }): Promise<void> {
	await refreshPlacementChannel(manager, channelId, origin, idMethod);
	const entries = activeChannelEntries(idMethod);
	await manager.query(`WITH active AS (${entries}) DELETE FROM channel_placement_pin p
		WHERE p."channelId" = $1 AND ($3::boolean OR EXISTS (SELECT 1 FROM active a
		WHERE a."canonicalUri" = p."canonicalUri" AND a."localNoteId" IS NOT NULL AND a."noteOrigin" = $2))`, [channelId, origin, request.uris !== undefined]);
	const key = request.uris !== undefined ? 'canonicalUri' : 'localNoteId';
	await manager.query(`WITH active AS (${entries}) INSERT INTO channel_placement_pin ("channelId","canonicalUri",rank)
		SELECT $1, active."canonicalUri", min(pin.ord)::int - 1 FROM unnest($3::varchar[]) WITH ORDINALITY pin(value, ord)
		JOIN active ON active."${key}" = pin.value GROUP BY active."canonicalUri"
		ON CONFLICT ("channelId","canonicalUri") DO UPDATE SET rank = EXCLUDED.rank`,
	[channelId, origin, request.uris ?? request.ids ?? []]);
	// Avoid re-importing the previous ID list while recomputing its new projection.
	await manager.query('UPDATE channel SET "pinnedNoteIds" = ARRAY[]::varchar[] WHERE id = $1', [channelId]);
	await refreshPlacementChannel(manager, channelId, origin, idMethod);
}
