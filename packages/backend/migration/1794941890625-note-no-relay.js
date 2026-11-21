/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteNoRelay1794941890625 {
	name = 'NoteNoRelay1794941890625'

	async up(queryRunner) {
		await queryRunner.query('ALTER TABLE "note" ADD "noRelay" boolean NOT NULL DEFAULT false');
	}

	async down(queryRunner) {
		await queryRunner.query('ALTER TABLE "note" DROP COLUMN "noRelay"');
	}
}
