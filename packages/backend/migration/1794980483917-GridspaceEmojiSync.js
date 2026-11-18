/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export class GridspaceEmojiSync1794980483917 {
	name = 'GridspaceEmojiSync1794980483917';
	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "gridspace_emoji_sync" (
			"id" uuid NOT NULL PRIMARY KEY, "peerOrigin" varchar(512) NOT NULL,
			"aId" varchar(32), "bId" varchar(32), "hashA" varchar(64), "hashB" varchar(64),
			"a" jsonb, "b" jsonb, "pending" jsonb, "state" varchar(16) NOT NULL, "reason" varchar(64),
			"attempts" integer NOT NULL DEFAULT 0, "updatedAt" timestamptz NOT NULL, "retryAt" timestamptz NOT NULL
		)`);
		await queryRunner.query(`CREATE INDEX "IDX_gridspace_emoji_sync_peer_state" ON "gridspace_emoji_sync" ("peerOrigin", "state")`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_gridspace_emoji_sync_a" ON "gridspace_emoji_sync" ("peerOrigin", "aId")`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_gridspace_emoji_sync_b" ON "gridspace_emoji_sync" ("peerOrigin", "bId")`);
		await queryRunner.query(`CREATE TABLE "gridspace_emoji_receipt" (
			"id" varchar(64) NOT NULL PRIMARY KEY, "peerOrigin" varchar(512) NOT NULL,
			"emojiId" varchar(32) NOT NULL, "result" jsonb NOT NULL, "createdAt" timestamptz NOT NULL
		)`);
		await queryRunner.query(`CREATE INDEX "IDX_gridspace_emoji_receipt_created" ON "gridspace_emoji_receipt" ("createdAt")`);
		await queryRunner.query(`CREATE TABLE "gridspace_emoji_state" ("peerOrigin" varchar(512) NOT NULL PRIMARY KEY, "checkedAt" timestamptz NOT NULL, "lastError" varchar(64))`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_EMOJI_LOCAL_NAME" ON "emoji" ("name") WHERE "host" IS NULL`);
	}
	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "IDX_EMOJI_LOCAL_NAME"`);
		await queryRunner.query(`DROP TABLE "gridspace_emoji_receipt"`);
		await queryRunner.query(`DROP TABLE "gridspace_emoji_sync"`);
		await queryRunner.query(`DROP TABLE "gridspace_emoji_state"`);
	}
}
