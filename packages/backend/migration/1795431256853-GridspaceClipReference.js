/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class GridspaceClipReference1795431256853 {
	name = 'GridspaceClipReference1795431256853';

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "gridspace_clip_reference" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "clipId" varchar(32) NOT NULL, "canonicalUri" varchar(512) COLLATE "C" NOT NULL, "noteId" varchar(32) NOT NULL, "sortAt" timestamptz NOT NULL, CONSTRAINT "PK_gridspace_clip_reference" PRIMARY KEY ("id"), CONSTRAINT "FK_gridspace_clip_reference_clip" FOREIGN KEY ("clipId") REFERENCES "clip"("id") ON DELETE CASCADE)`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_gridspace_clip_reference_uri" ON "gridspace_clip_reference" ("clipId", "canonicalUri")`);
		await queryRunner.query(`CREATE INDEX "IDX_gridspace_clip_reference_order" ON "gridspace_clip_reference" ("clipId", "sortAt", "noteId")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TABLE "gridspace_clip_reference"`);
	}
}
