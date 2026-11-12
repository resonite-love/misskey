/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class GridspaceNotes1794452699504 {
    name = 'GridspaceNotes1794452699504'

    async up(queryRunner) {
        await queryRunner.query(`CREATE TABLE "gridspace_note_delivery" ("noteId" character varying(32) NOT NULL, "version" uuid NOT NULL, "peerOrigin" character varying(512) NOT NULL, "retryAt" TIMESTAMP WITH TIME ZONE NOT NULL, "attempts" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_070a9d5540c512ee07c68e5e9e1" PRIMARY KEY ("noteId"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8ef42969d9cac457bf4f327992" ON "gridspace_note_delivery"  ("retryAt") `);
        await queryRunner.query(`CREATE TABLE "gridspace_note_tombstone" ("uri" character varying(512) NOT NULL, CONSTRAINT "PK_c36ede1ba41989ef72dc3fff051" PRIMARY KEY ("uri"))`);
        await queryRunner.query(`ALTER TABLE "note" ADD "gridspaceShared" boolean NOT NULL DEFAULT false`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "note" DROP COLUMN "gridspaceShared"`);
        await queryRunner.query(`DROP TABLE "gridspace_note_tombstone"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8ef42969d9cac457bf4f327992"`);
        await queryRunner.query(`DROP TABLE "gridspace_note_delivery"`);
    }
}
