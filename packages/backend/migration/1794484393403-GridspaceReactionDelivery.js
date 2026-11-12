/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class GridspaceReactionDelivery1794484393403 {
	name = 'GridspaceReactionDelivery1794484393403';

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "gridspace_reaction_delivery" ("noteId" character varying(32) NOT NULL, "version" uuid NOT NULL, "peerOrigin" character varying(512) NOT NULL, "retryAt" TIMESTAMP WITH TIME ZONE NOT NULL, "attempts" integer NOT NULL DEFAULT 0, CONSTRAINT "PK_gridspace_reaction_delivery" PRIMARY KEY ("noteId"))`);
		await queryRunner.query(`CREATE INDEX "IDX_gridspace_reaction_delivery_retry" ON "gridspace_reaction_delivery" ("retryAt")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TABLE "gridspace_reaction_delivery"`);
	}
}
