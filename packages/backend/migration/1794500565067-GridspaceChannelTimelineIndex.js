/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const concurrently = process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY === '1';
const name = 'IDX_GRIDSPACE_NOTE_CHANNEL_ID_ID';

export class GridspaceChannelTimelineIndex1794500565067 {
	name = 'GridspaceChannelTimelineIndex1794500565067';
	transaction = concurrently ? false : undefined;

	async up(queryRunner) {
		const existing = await queryRunner.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.oid = to_regclass('"${name}"')`);
		if (existing[0]?.indisvalid) return;
		if (existing.length) await queryRunner.query(`DROP INDEX ${concurrently ? 'CONCURRENTLY' : ''} "${name}"`);
		await queryRunner.query(`CREATE INDEX ${concurrently ? 'CONCURRENTLY' : ''} "${name}" ON "note" ("channelId", "id") WHERE "channelId" IS NOT NULL`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX ${concurrently ? 'CONCURRENTLY' : ''} IF EXISTS "${name}"`);
	}
}
