/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class GridspaceSharedDrive1794555737190 {
	name = 'GridspaceSharedDrive1794555737190';
	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "gridspace_link" ADD "driveShared" boolean NOT NULL DEFAULT true, ADD "driveSeeded" boolean NOT NULL DEFAULT false`);
		await queryRunner.query(`CREATE TABLE "gridspace_drive_entry" (
			"id" uuid NOT NULL PRIMARY KEY, "linkId" uuid NOT NULL, "kind" varchar(8) NOT NULL,
			"origin" varchar(512) NOT NULL, "sourceId" varchar(32) NOT NULL, "localId" varchar(32) NOT NULL,
			"revision" integer NOT NULL DEFAULT 0, "deleted" boolean NOT NULL DEFAULT false,
			"pending" boolean NOT NULL DEFAULT false, "retryAt" TIMESTAMP NOT NULL DEFAULT now(),
			"attempts" integer NOT NULL DEFAULT 0, "lastError" varchar(64), "payload" jsonb
		)`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_gridspace_drive_source" ON "gridspace_drive_entry" ("linkId", "kind", "origin", "sourceId")`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_gridspace_drive_local" ON "gridspace_drive_entry" ("kind", "localId")`);
		await queryRunner.query(`CREATE INDEX "IDX_gridspace_drive_pending" ON "gridspace_drive_entry" ("pending", "retryAt")`);
	}
	async down(queryRunner) {
		await queryRunner.query(`DROP TABLE "gridspace_drive_entry"`);
		await queryRunner.query(`ALTER TABLE "gridspace_link" DROP COLUMN "driveShared", DROP COLUMN "driveSeeded"`);
	}
}
