/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const concurrently = process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY === '1';
const name = 'IDX_DRIVE_FILE_URL_HASH';

export class DriveFileUrlHashIndex1795434589863 {
	name = 'DriveFileUrlHashIndex1795434589863';
	transaction = concurrently ? false : undefined;

	async up(queryRunner) {
		const existing = await queryRunner.query(`SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid = to_regclass('"${name}"')`);
		if (existing[0]?.indisvalid) return;
		if (existing.length) await queryRunner.query(`DROP INDEX ${concurrently ? 'CONCURRENTLY' : ''} "${name}"`);
		// URLs may exceed a btree entry's byte limit. Hash equality still rechecks the full URL.
		await queryRunner.query(`CREATE INDEX ${concurrently ? 'CONCURRENTLY' : ''} "${name}" ON "drive_file" USING hash ("url")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX ${concurrently ? 'CONCURRENTLY' : ''} IF EXISTS "${name}"`);
	}
}
