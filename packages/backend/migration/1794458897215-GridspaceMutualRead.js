/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class GridspaceMutualRead1794458897215 {
    name = 'GridspaceMutualRead1794458897215'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "gridspace_link" ADD "privateMutualGrantId" uuid`);
        await queryRunner.query(`ALTER TABLE "gridspace_link" ADD "privateRevision" integer NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "gridspace_link" ADD "privateMutualReady" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "gridspace_auth_session" ADD "privateGrant" jsonb`);
    }

    async down(queryRunner) {
        // Removing the pair checks must not turn reciprocal grants into independent grants.
        await queryRunner.query(`UPDATE "gridspace_link" SET "privateTokenHash" = NULL, "privateTokenCipher" = NULL WHERE "privateMutualGrantId" IS NOT NULL`);
        await queryRunner.query(`DELETE FROM "gridspace_auth_session" WHERE "purpose" = 'private-mutual'`);
        await queryRunner.query(`ALTER TABLE "gridspace_auth_session" DROP COLUMN "privateGrant"`);
        await queryRunner.query(`ALTER TABLE "gridspace_link" DROP COLUMN "privateMutualReady"`);
        await queryRunner.query(`ALTER TABLE "gridspace_link" DROP COLUMN "privateRevision"`);
        await queryRunner.query(`ALTER TABLE "gridspace_link" DROP COLUMN "privateMutualGrantId"`);
    }
}
