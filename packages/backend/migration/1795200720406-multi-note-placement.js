/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class MultiNotePlacement1795200720406 {
	name = 'MultiNotePlacement1795200720406';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note"
			ADD "includeDefault" boolean,
			ADD "multiNoteKind" varchar(32),
			ADD "multiNoteRootId" varchar(32),
			ADD CONSTRAINT "CHK_NOTE_CHANNEL_ONLY" CHECK ("includeDefault" IS DISTINCT FROM FALSE OR ("localOnly" AND NOT "gridspaceShared"))`);
		await queryRunner.query(`CREATE TABLE "note_channel_placement" (
			"id" uuid CONSTRAINT "PK_LOCAL_PLACEMENT" PRIMARY KEY,
			"noteId" varchar(32) CONSTRAINT "FK_LOCAL_PLACEMENT_NOTE" REFERENCES "note"("id") ON DELETE SET NULL,
			"channelId" varchar(32) NOT NULL CONSTRAINT "FK_LOCAL_PLACEMENT_CHANNEL" REFERENCES "channel"("id") ON DELETE CASCADE,
			"canonicalUri" varchar(512) COLLATE "C" NOT NULL, "sortAt" timestamptz NOT NULL, "state" varchar(32) NOT NULL,
			"removedAt" timestamptz, "removedBy" varchar(32)
		)`);
		await queryRunner.query('CREATE UNIQUE INDEX "UQ_LOCAL_PLACEMENT_NOTE_CHANNEL" ON "note_channel_placement" ("noteId", "channelId")');
		await queryRunner.query('CREATE UNIQUE INDEX "UQ_LOCAL_PLACEMENT_CHANNEL_URI" ON "note_channel_placement" ("channelId", "canonicalUri")');
		await queryRunner.query(`CREATE INDEX "IDX_LOCAL_PLACEMENT_ORDER" ON "note_channel_placement" ("channelId", "sortAt", "canonicalUri") WHERE state = 'active'`);
		await queryRunner.query(`CREATE TABLE "note_create_receipt" (
			"userId" varchar(32) NOT NULL, "clientRequestId" uuid NOT NULL, "inputHash" varchar(64) NOT NULL,
			"canonicalUri" varchar(512) NOT NULL, "deleted" boolean NOT NULL DEFAULT false,
			"noteId" varchar(32) CONSTRAINT "FK_CREATE_RECEIPT_NOTE" REFERENCES "note"("id") ON DELETE SET NULL,
			CONSTRAINT "PK_NOTE_CREATE_RECEIPT" PRIMARY KEY ("userId", "clientRequestId")
		)`);
		await queryRunner.query(`CREATE TABLE "note_create_dispatch" (
			"noteId" varchar(32) CONSTRAINT "PK_NOTE_CREATE_DISPATCH" PRIMARY KEY CONSTRAINT "FK_NOTE_CREATE_DISPATCH" REFERENCES "note"("id") ON DELETE CASCADE,
			"retryAt" timestamptz NOT NULL, "attempts" integer NOT NULL DEFAULT 0, "silent" boolean NOT NULL DEFAULT false
		)`);
		await queryRunner.query('CREATE INDEX "IDX_NOTE_DISPATCH_RETRY" ON "note_create_dispatch" ("retryAt")');
		await queryRunner.query('CREATE INDEX "IDX_CREATE_RECEIPT_NOTE" ON "note_create_receipt" ("noteId")');
		await queryRunner.query(`CREATE TABLE "channel_placement_pin" (
			"channelId" varchar(32) NOT NULL CONSTRAINT "FK_CHANNEL_PLACEMENT_PIN" REFERENCES "channel"("id") ON DELETE CASCADE,
			"canonicalUri" varchar(512) COLLATE "C" NOT NULL, "rank" integer NOT NULL,
			CONSTRAINT "PK_CHANNEL_PLACEMENT_PIN" PRIMARY KEY ("channelId", "canonicalUri")
		)`);
		for (const name of ['outbox', 'change']) {
			await queryRunner.query(`ALTER TABLE "gridspace_timeline_${name}" ADD "channelOrigin" varchar(512), ADD "channelId" varchar(32), ADD "sourceRevision" bigint, ADD "targetRevision" bigint, ADD "eventId" uuid`);
			await queryRunner.query(`CREATE UNIQUE INDEX "UQ_PLACEMENT_EVENT_${name.toUpperCase()}" ON "gridspace_timeline_${name}" ("eventId")`);
		}
	}

	async down(queryRunner) {
		for (const name of ['outbox', 'change']) {
			await queryRunner.query(`ALTER TABLE "gridspace_timeline_${name}" DROP COLUMN "eventId", DROP COLUMN "targetRevision", DROP COLUMN "sourceRevision", DROP COLUMN "channelId", DROP COLUMN "channelOrigin"`);
		}
		await queryRunner.query('DROP TABLE "channel_placement_pin"');
		await queryRunner.query('DROP TABLE "note_create_dispatch"');
		await queryRunner.query('DROP TABLE "note_create_receipt"');
		await queryRunner.query('DROP TABLE "note_channel_placement"');
		await queryRunner.query('ALTER TABLE "note" DROP CONSTRAINT "CHK_NOTE_CHANNEL_ONLY", DROP COLUMN "multiNoteRootId", DROP COLUMN "multiNoteKind", DROP COLUMN "includeDefault"');
	}
}
