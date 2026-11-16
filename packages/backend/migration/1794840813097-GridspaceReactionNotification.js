/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class GridspaceReactionNotification1794840813097 {
	name = 'GridspaceReactionNotification1794840813097';

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "gridspace_reaction_notification" ("reactionId" character varying(32) NOT NULL, "noteId" character varying(32) NOT NULL, "notifierId" character varying(32) NOT NULL, "reaction" character varying(260) NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "retryAt" TIMESTAMP WITH TIME ZONE NOT NULL, "attempts" integer NOT NULL DEFAULT 0, CONSTRAINT "PK_gridspace_reaction_notification" PRIMARY KEY ("reactionId"))`);
		await queryRunner.query(`CREATE INDEX "IDX_gridspace_reaction_notification_retry" ON "gridspace_reaction_notification" ("retryAt")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TABLE "gridspace_reaction_notification"`);
	}
}
