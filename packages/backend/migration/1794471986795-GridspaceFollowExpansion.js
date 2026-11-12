/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class GridspaceFollowExpansion1794471986795 {
    name = 'GridspaceFollowExpansion1794471986795';

    async up(queryRunner) {
        await queryRunner.query(`CREATE TABLE "gridspace_follow_expansion" ("followerId" character varying(32) NOT NULL, "targetId" character varying(32) NOT NULL, "state" character varying(16) NOT NULL, "reason" character varying(64), "retryAt" TIMESTAMP WITH TIME ZONE NOT NULL, "attempts" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_2efabcc61fdd23395f84fbbf331" PRIMARY KEY ("followerId", "targetId"))`);
        await queryRunner.query(`ALTER TABLE "gridspace_follow_expansion" ADD CONSTRAINT "FK_1b91730cd68e65f68f4ce83c702" FOREIGN KEY ("followerId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "gridspace_follow_expansion" ADD CONSTRAINT "FK_d9d8925e9ee965dc00e6b94d3a5" FOREIGN KEY ("targetId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "gridspace_follow_expansion" DROP CONSTRAINT "FK_d9d8925e9ee965dc00e6b94d3a5"`);
        await queryRunner.query(`ALTER TABLE "gridspace_follow_expansion" DROP CONSTRAINT "FK_1b91730cd68e65f68f4ce83c702"`);
        await queryRunner.query(`DROP TABLE "gridspace_follow_expansion"`);
    }
}
