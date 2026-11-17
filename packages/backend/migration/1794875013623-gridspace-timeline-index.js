/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const audienceTables = {
	following: 'followerId',
	muting: 'muterId',
	renote_muting: 'muterId',
	blocking: '',
	channel_following: 'followerId',
	channel_muting: 'userId',
	note_thread_muting: 'userId',
	user_list_membership: '',
	role_assignment: 'userId',
	gridspace_link: 'localUserId',
};

/** Only new changes are recorded. Existing notes are neither copied nor backfilled. */
export class GridspaceTimelineIndex1794875013623 {
	name = 'GridspaceTimelineIndex1794875013623';

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "gridspace_timeline_outbox" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "canonicalUri" character varying(1024) COLLATE "C", "noteId" character varying(32), "kind" character varying(16) NOT NULL, "affectedUserId" character varying(32), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(), CONSTRAINT "PK_gridspace_timeline_outbox" PRIMARY KEY ("id"))`);
		await queryRunner.query(`CREATE INDEX "IDX_gridspace_timeline_outbox_created" ON "gridspace_timeline_outbox" ("createdAt")`);
		await queryRunner.query(`CREATE TABLE "gridspace_timeline_change" ("sequence" bigint NOT NULL, "canonicalUri" character varying(1024) COLLATE "C", "noteId" character varying(32), "kind" character varying(16) NOT NULL, "affectedUserId" character varying(32), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_gridspace_timeline_change" PRIMARY KEY ("sequence"))`);
		await queryRunner.query(`CREATE INDEX "IDX_gridspace_timeline_change_created" ON "gridspace_timeline_change" ("createdAt")`);
		await queryRunner.query(`CREATE TABLE "gridspace_timeline_state" ("key" character varying(32) NOT NULL, "generation" integer NOT NULL DEFAULT 1, "nextSequence" bigint NOT NULL DEFAULT 0, "trimmedThrough" bigint NOT NULL DEFAULT 0, CONSTRAINT "PK_gridspace_timeline_state" PRIMARY KEY ("key"))`);
		await queryRunner.query(`INSERT INTO "gridspace_timeline_state" ("key") VALUES ('changes')`);
		await queryRunner.query(`CREATE FUNCTION gridspace_timeline_note_event() RETURNS trigger LANGUAGE plpgsql AS $body$
		DECLARE target_id varchar(32); target_uri varchar(1024);
		BEGIN
			IF TG_OP = 'DELETE' THEN target_id := OLD.id; target_uri := OLD.uri; ELSE target_id := NEW.id; target_uri := NEW.uri; END IF;
			INSERT INTO "gridspace_timeline_outbox" ("canonicalUri", "noteId", "kind") VALUES (target_uri, target_id, CASE WHEN TG_OP = 'DELETE' THEN 'remove' WHEN TG_OP = 'INSERT' THEN 'insert' ELSE 'update' END);
			IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
			RETURN NEW;
		END $body$`);
		await queryRunner.query(`CREATE TRIGGER "gridspace_timeline_note_create_delete" AFTER INSERT OR DELETE ON "note" FOR EACH ROW EXECUTE FUNCTION gridspace_timeline_note_event()`);
		await queryRunner.query(`CREATE TRIGGER "gridspace_timeline_note_update" AFTER UPDATE OF "text", "cw", "visibility", "visibleUserIds", "fileIds", "userId", "channelId", "mentions", "replyId", "renoteId", "uri" ON "note" FOR EACH ROW EXECUTE FUNCTION gridspace_timeline_note_event()`);
		await queryRunner.query(`CREATE FUNCTION gridspace_timeline_audience_event() RETURNS trigger LANGUAGE plpgsql AS $body$
		DECLARE old_row jsonb; new_row jsonb; old_id varchar(32); new_id varchar(32);
		BEGIN
			IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); old_id := old_row ->> TG_ARGV[0]; END IF;
			IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); new_id := new_row ->> TG_ARGV[0]; END IF;
			INSERT INTO "gridspace_timeline_outbox" ("kind", "affectedUserId") VALUES ('reset', coalesce(new_id, old_id));
			IF old_id IS NOT NULL AND new_id IS NOT NULL AND old_id <> new_id THEN INSERT INTO "gridspace_timeline_outbox" ("kind", "affectedUserId") VALUES ('reset', old_id); END IF;
			IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
		END $body$`);
		for (const [table, field] of Object.entries(audienceTables)) {
			await queryRunner.query(`CREATE TRIGGER "gridspace_timeline_audience" AFTER INSERT OR UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION gridspace_timeline_audience_event('${field}')`);
		}
		await queryRunner.query(`CREATE TRIGGER "gridspace_timeline_author_policy" AFTER UPDATE OF "isSuspended", "isDeleted", "requireSigninToViewContents", "makeNotesHiddenBefore", "makeNotesFollowersOnlyBefore" ON "user" FOR EACH ROW EXECUTE FUNCTION gridspace_timeline_audience_event('')`);
		await queryRunner.query(`CREATE TRIGGER "gridspace_timeline_role_policy" AFTER INSERT OR UPDATE OR DELETE ON "role" FOR EACH ROW EXECUTE FUNCTION gridspace_timeline_audience_event('')`);
		await queryRunner.query(`CREATE TRIGGER "gridspace_timeline_muted_instances" AFTER UPDATE OF "mutedInstances" ON "user_profile" FOR EACH ROW EXECUTE FUNCTION gridspace_timeline_audience_event('userId')`);
		await queryRunner.query(`CREATE TRIGGER "gridspace_timeline_blocked_hosts" AFTER UPDATE OF "blockedHosts" ON "meta" FOR EACH ROW EXECUTE FUNCTION gridspace_timeline_audience_event('')`);
		await queryRunner.query(`CREATE TRIGGER "gridspace_timeline_channel_policy" AFTER UPDATE OF "isSensitive" ON "channel" FOR EACH ROW EXECUTE FUNCTION gridspace_timeline_audience_event('')`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TRIGGER "gridspace_timeline_channel_policy" ON "channel"`);
		await queryRunner.query(`DROP TRIGGER "gridspace_timeline_blocked_hosts" ON "meta"`);
		await queryRunner.query(`DROP TRIGGER "gridspace_timeline_muted_instances" ON "user_profile"`);
		await queryRunner.query(`DROP TRIGGER "gridspace_timeline_role_policy" ON "role"`);
		await queryRunner.query(`DROP TRIGGER "gridspace_timeline_author_policy" ON "user"`);
		for (const table of Object.keys(audienceTables)) await queryRunner.query(`DROP TRIGGER "gridspace_timeline_audience" ON "${table}"`);
		await queryRunner.query(`DROP FUNCTION gridspace_timeline_audience_event()`);
		await queryRunner.query(`DROP TRIGGER "gridspace_timeline_note_update" ON "note"`);
		await queryRunner.query(`DROP TRIGGER "gridspace_timeline_note_create_delete" ON "note"`);
		await queryRunner.query(`DROP FUNCTION gridspace_timeline_note_event()`);
		for (const table of ['gridspace_timeline_state', 'gridspace_timeline_change', 'gridspace_timeline_outbox']) await queryRunner.query(`DROP TABLE "${table}"`);
	}
}
