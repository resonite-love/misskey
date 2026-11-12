/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class GridspacePrivateRead1794457466799 {
    name = 'GridspacePrivateRead1794457466799'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "gridspace_link" ADD "privateTokenCipher" text`);
        await queryRunner.query(`ALTER TABLE "gridspace_link" ADD "privateRevocationCipher" text`);
        await queryRunner.query(`ALTER TABLE "gridspace_link" ADD "privateTokenHash" character varying(64)`);
        await queryRunner.query(`ALTER TABLE "gridspace_auth_session" ADD "purpose" character varying(16) NOT NULL DEFAULT 'link'`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "gridspace_auth_session" DROP COLUMN "purpose"`);
        await queryRunner.query(`ALTER TABLE "gridspace_link" DROP COLUMN "privateTokenHash"`);
        await queryRunner.query(`ALTER TABLE "gridspace_link" DROP COLUMN "privateTokenCipher"`);
        await queryRunner.query(`ALTER TABLE "gridspace_link" DROP COLUMN "privateRevocationCipher"`);
    }
}
