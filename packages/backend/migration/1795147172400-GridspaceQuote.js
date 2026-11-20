/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class GridspaceQuote1795147172400 {
	name = 'GridspaceQuote1795147172400';

	async up(queryRunner) {
		await queryRunner.query('ALTER TABLE "note" ADD "gridspaceQuote" character varying(2048)');
		await queryRunner.query('ALTER TABLE "note_draft" ADD "gridspaceQuote" character varying(2048)');
	}

	async down(queryRunner) {
		await queryRunner.query('ALTER TABLE "note_draft" DROP COLUMN "gridspaceQuote"');
		await queryRunner.query('ALTER TABLE "note" DROP COLUMN "gridspaceQuote"');
	}
}
