/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteFederateAsHome1794944916377 {
	name = 'NoteFederateAsHome1794944916377'

	async up(queryRunner) {
		await queryRunner.query('ALTER TABLE "note" ADD "federateAsHome" boolean NOT NULL DEFAULT false');
	}

	async down(queryRunner) {
		await queryRunner.query('ALTER TABLE "note" DROP COLUMN "federateAsHome"');
	}
}
