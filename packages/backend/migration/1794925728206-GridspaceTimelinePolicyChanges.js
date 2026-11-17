/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const body = (guard) => `CREATE OR REPLACE FUNCTION gridspace_timeline_audience_event() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE old_row jsonb; new_row jsonb; old_id varchar(32); new_id varchar(32);
BEGIN
 IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); old_id := old_row ->> TG_ARGV[0]; END IF;
 IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); new_id := new_row ->> TG_ARGV[0]; END IF;
 ${guard}
 INSERT INTO "gridspace_timeline_outbox" ("kind", "affectedUserId") VALUES ('reset', coalesce(new_id, old_id));
 IF old_id IS NOT NULL AND new_id IS NOT NULL AND old_id <> new_id THEN INSERT INTO "gridspace_timeline_outbox" ("kind", "affectedUserId") VALUES ('reset', old_id); END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $body$`;

export class GridspaceTimelinePolicyChanges1794925728206 {
	name = 'GridspaceTimelinePolicyChanges1794925728206';

	async up(queryRunner) {
		await queryRunner.query(body(`IF TG_OP = 'UPDATE' AND (
  old_row IS NOT DISTINCT FROM new_row
  OR (TG_TABLE_NAME = 'user' AND
   (old_row -> 'isSuspended', old_row -> 'isDeleted', old_row -> 'requireSigninToViewContents', old_row -> 'makeNotesHiddenBefore', old_row -> 'makeNotesFollowersOnlyBefore')
   IS NOT DISTINCT FROM
   (new_row -> 'isSuspended', new_row -> 'isDeleted', new_row -> 'requireSigninToViewContents', new_row -> 'makeNotesHiddenBefore', new_row -> 'makeNotesFollowersOnlyBefore'))
  OR (TG_TABLE_NAME = 'role' AND (old_row - 'lastUsedAt' - 'updatedAt') IS NOT DISTINCT FROM (new_row - 'lastUsedAt' - 'updatedAt'))
  OR (TG_TABLE_NAME = 'meta' AND (old_row -> 'blockedHosts') IS NOT DISTINCT FROM (new_row -> 'blockedHosts'))
 ) THEN RETURN NEW; END IF;`));
	}

	async down(queryRunner) {
		await queryRunner.query(body(''));
	}
}
