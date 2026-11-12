/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export class GridspaceSessionGeneration1794451529407 {
    name = 'GridspaceSessionGeneration1794451529407'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "gridspace_auth_session" ADD "generation" integer`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "gridspace_auth_session" DROP COLUMN "generation"`);
    }
}
