/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class GridspacePlacement1795200743973 {
	name = 'GridspacePlacement1795200743973';

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "gridspace_channel_placement" (
			"id" uuid NOT NULL DEFAULT uuid_generate_v4(),
			"channelId" character varying(32) NOT NULL,
			"canonicalUri" character varying(512) COLLATE "C" NOT NULL,
			"sourceRevision" integer NOT NULL,
			"targetRevision" integer NOT NULL,
			"sortAt" timestamp with time zone NOT NULL,
			"state" character varying(20) NOT NULL,
			"version" uuid NOT NULL,
			"attempts" integer NOT NULL,
			"retryAt" timestamp with time zone,
			"noteOrigin" character varying(512) NOT NULL,
			"channelOrigin" character varying(512) NOT NULL,
			"originNoteId" character varying(32) NOT NULL,
			"authorUri" character varying(512) NOT NULL,
			"authorOrigin" character varying(512) NOT NULL,
			"includeDefault" boolean NOT NULL,
			CONSTRAINT "PK_gridspace_channel_placement" PRIMARY KEY ("id")
		)`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_gridspace_channel_placement_1" ON "gridspace_channel_placement" ("channelId", "canonicalUri")`);
		await queryRunner.query(`CREATE INDEX "IDX_gridspace_channel_placement_2" ON "gridspace_channel_placement" ("channelId", "sortAt", "canonicalUri") WHERE state = 'active'`);
		await queryRunner.query(`CREATE INDEX "IDX_gridspace_channel_placement_3" ON "gridspace_channel_placement" ("retryAt")`);
		await queryRunner.query(`CREATE INDEX "IDX_gridspace_mirror_placements" ON "gridspace_channel_placement" ("canonicalUri", "channelId") WHERE state = 'active' AND "includeDefault"`);
		await queryRunner.query(`CREATE TABLE "gridspace_placement_target" (
			"id" uuid NOT NULL DEFAULT uuid_generate_v4(),
			"channelId" character varying(32) NOT NULL,
			"canonicalUri" character varying(512) COLLATE "C" NOT NULL,
			"sourceRevision" integer NOT NULL,
			"targetRevision" integer NOT NULL,
			"sortAt" timestamp with time zone NOT NULL,
			"state" character varying(20) NOT NULL,
			"version" uuid NOT NULL,
			"attempts" integer NOT NULL,
			"retryAt" timestamp with time zone,
			"noteId" character varying(32) NOT NULL,
			"permanentFailure" boolean NOT NULL DEFAULT false,
			"peerOrigin" character varying(512) NOT NULL,
			"authorId" character varying(32) NOT NULL,
			"includeDefault" boolean NOT NULL,
			"name" character varying(128) NOT NULL,
			"color" character varying(16) NOT NULL,
			"placementId" uuid,
			CONSTRAINT "PK_gridspace_placement_target" PRIMARY KEY ("id")
		)`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_gridspace_placement_target_1" ON "gridspace_placement_target" ("canonicalUri", "peerOrigin", "channelId")`);
		await queryRunner.query(`CREATE INDEX "IDX_gridspace_placement_target_2" ON "gridspace_placement_target" ("noteId")`);
		await queryRunner.query(`CREATE INDEX "IDX_gridspace_placement_target_3" ON "gridspace_placement_target" ("retryAt")`);
		// Channel IDs are destination-owned. Preserve a terminal status for each remote source.
		await queryRunner.query(`CREATE FUNCTION gridspace_remove_channel_placements() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				WITH removed AS (UPDATE gridspace_channel_placement SET state = 'removed', "targetRevision" = "targetRevision" + 1,
					version = uuid_generate_v4(), "retryAt" = clock_timestamp(), attempts = 0
					WHERE "channelId" = OLD.id AND state = 'active'
					RETURNING "canonicalUri", "channelOrigin", "channelId", "sourceRevision", "targetRevision")
				INSERT INTO gridspace_timeline_outbox (kind, "canonicalUri", "channelOrigin", "channelId", "sourceRevision", "targetRevision", "eventId")
					SELECT 'place-remove', "canonicalUri", "channelOrigin", "channelId", "sourceRevision", "targetRevision", uuid_generate_v4() FROM removed;
				INSERT INTO gridspace_timeline_outbox (kind, "canonicalUri", "channelOrigin", "channelId", "noteId", "eventId")
					SELECT 'place-remove', "canonicalUri", split_part("canonicalUri", '/notes/', 1), "channelId", "noteId", uuid_generate_v4()
					FROM note_channel_placement WHERE "channelId" = OLD.id AND state = 'active';
				PERFORM pg_notify('gridspace_timeline_changed', '');
				RETURN OLD;
			END $$`);
		await queryRunner.query('CREATE TRIGGER gridspace_remove_channel_placements BEFORE DELETE ON channel FOR EACH ROW EXECUTE FUNCTION gridspace_remove_channel_placements()');
	}

	async down(queryRunner) {
		await queryRunner.query('DROP TRIGGER gridspace_remove_channel_placements ON channel');
		await queryRunner.query('DROP FUNCTION gridspace_remove_channel_placements()');
		await queryRunner.query('DROP TABLE "gridspace_placement_target"');
		await queryRunner.query('DROP TABLE "gridspace_channel_placement"');
	}
}
