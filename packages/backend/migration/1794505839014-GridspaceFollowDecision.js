/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class GridspaceFollowDecision1794505839014 {
	name = 'GridspaceFollowDecision1794505839014';

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "gridspace_follow_decision" ("requestId" character varying(32) NOT NULL, "followeeId" character varying(32) NOT NULL, "followerId" character varying(32) NOT NULL, "activityId" text, "accept" boolean NOT NULL, "followingId" character varying(32), "delivered" boolean NOT NULL DEFAULT false, "retryAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_gridspace_follow_decision" PRIMARY KEY ("requestId"))`);
		await queryRunner.query(`CREATE INDEX "IDX_gridspace_follow_decision_retry" ON "gridspace_follow_decision"  ("retryAt") WHERE "delivered" = false`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "public"."IDX_gridspace_follow_decision_retry"`);
		await queryRunner.query(`DROP TABLE "gridspace_follow_decision"`);
	}
}
