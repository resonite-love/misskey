/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class GridspaceReplyReceipt1794466348204 {
    name = 'GridspaceReplyReceipt1794466348204';

    async up(queryRunner) {
        await queryRunner.query(`CREATE TABLE "gridspace_reply_receipt" ("userId" varchar(32) NOT NULL, "requestId" uuid NOT NULL, "requestHash" varchar(64) NOT NULL, "noteId" varchar(32) NOT NULL, PRIMARY KEY ("userId", "requestId"), CONSTRAINT "FK_8802312108f58c44344316ff479" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE)`);
    }

    async down(queryRunner) {
        // Reapplying after rollback must not allow a lost receipt to replay a write.
        await queryRunner.query(`DELETE FROM "access_token" WHERE "permission" @> ARRAY['write:gridspace-reply']::varchar[]`);
        await queryRunner.query(`DROP TABLE "gridspace_reply_receipt"`);
        await queryRunner.query(`DELETE FROM "gridspace_auth_session" WHERE "purpose" = 'private-reply'`);
    }
}
