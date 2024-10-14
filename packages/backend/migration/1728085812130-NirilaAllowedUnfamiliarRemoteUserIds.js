/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NirilaAllowedUnfamiliarRemoteUserIds1728085812129 {
	name = 'NirilaAllowedUnfamiliarRemoteUserIds1728085812130'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" ADD "nirilaBlockMentionsFromUnfamiliarRemoteUsers" boolean NOT NULL DEFAULT false`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "nirilaBlockMentionsFromUnfamiliarRemoteUsers"`);
	}
}
