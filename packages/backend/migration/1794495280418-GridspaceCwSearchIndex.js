/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const concurrently = process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY === '1';
const name = 'IDX_GRIDSPACE_NOTE_CW_SEARCH';

export class GridspaceCwSearchIndex1794495280418 {
	name = 'GridspaceCwSearchIndex1794495280418';
	transaction = concurrently ? false : undefined;

	async up(queryRunner) {
		// PGroonga is optional. Plain PostgreSQL keeps the same search semantics.
		if (!(await queryRunner.query("SELECT 1 FROM pg_extension WHERE extname = 'pgroonga'")).length) return;
		const existing = await queryRunner.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.oid = to_regclass('"${name}"')`);
		if (existing[0]?.indisvalid) return;
		if (existing.length) await queryRunner.query(`DROP INDEX ${concurrently ? 'CONCURRENTLY' : ''} "${name}"`);
		// LIKE/ILIKE cannot use PGroonga's varchar index; match the query's text cast.
		await queryRunner.query(`CREATE INDEX ${concurrently ? 'CONCURRENTLY' : ''} "${name}" ON "note" USING pgroonga ((cw::text)) WHERE cw IS NOT NULL`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX ${concurrently ? 'CONCURRENTLY' : ''} IF EXISTS "${name}"`);
	}
}
