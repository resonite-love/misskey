/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NirilaAllowedUnfamiliarRemoteUserIds1728085812129 {
	name = 'NirilaAllowedUnfamiliarRemoteUserIds1728085812129'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta"
			ADD "nirilaAllowedUnfamiliarRemoteUserIds" character varying(32) array NOT NULL DEFAULT '{}'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "nirilaAllowedUnfamiliarRemoteUserIds"`);
	}
}
