/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export class GridspaceLink1794451421453 {
    name = 'GridspaceLink1794451421453'

    async up(queryRunner) {
        await queryRunner.query(`CREATE TABLE "gridspace_link" ("id" uuid NOT NULL, "localUserId" character varying(32) NOT NULL, "peerOrigin" character varying(512) NOT NULL, "peerUserId" character varying(32) NOT NULL, "peerUsername" character varying(128) NOT NULL, "generation" integer NOT NULL DEFAULT '1', "initiator" boolean NOT NULL, "state" character varying(16) NOT NULL, "tokenCipher" text, "snapshot" jsonb, "snapshotAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastError" character varying(64), CONSTRAINT "PK_8c4920260f9a443579576b3c42d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_gridspace_active_peer" ON "gridspace_link"  ("peerOrigin", "peerUserId") WHERE "state" <> 'revoked'`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_gridspace_active_local" ON "gridspace_link"  ("localUserId") WHERE "state" <> 'revoked'`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1a36f54433081b8f130a4d0221" ON "gridspace_link"  ("localUserId", "peerOrigin", "peerUserId") `);
        await queryRunner.query(`CREATE TABLE "gridspace_auth_session" ("id" uuid NOT NULL, "localUserId" character varying(32) NOT NULL, "stateHash" character varying(64) NOT NULL, "clientHash" character varying(64) NOT NULL, "verifierCipher" text NOT NULL, "tokenCipher" text, "exchanged" boolean NOT NULL DEFAULT false, "completed" boolean NOT NULL DEFAULT false, "linkId" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_52f68bb85e828ed5087da578e94" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_96b02e13bda214265f1e74ee97" ON "gridspace_auth_session"  ("localUserId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b354bf7b63e0b2bbf0fe89a3c7" ON "gridspace_auth_session"  ("stateHash") `);
        await queryRunner.query(`CREATE INDEX "IDX_7f5c32efe026177554eb253ec8" ON "gridspace_auth_session"  ("expiresAt") `);
        await queryRunner.query(`CREATE TABLE "gridspace_import_item" ("id" uuid NOT NULL, "linkId" uuid NOT NULL, "actorUri" character varying(512) NOT NULL, "withReplies" boolean NOT NULL DEFAULT false, "state" character varying(16) NOT NULL, "reason" character varying(64), "targetUserId" character varying(32), CONSTRAINT "PK_6e3a2b3ab2d5cbb98309f74eda0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5bbf17c8f48d18e515d084dac1" ON "gridspace_import_item"  ("state") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_60c9d88ac628514784b0fc5000" ON "gridspace_import_item"  ("linkId", "actorUri") `);
        await queryRunner.query(`CREATE TABLE "gridspace_follow_override" ("localUserId" character varying(32) NOT NULL, "targetUserId" character varying(32) NOT NULL, "changedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_74d576a5a9f35e9a818ddb4b7d1" PRIMARY KEY ("localUserId", "targetUserId"))`);
        await queryRunner.query(`ALTER TABLE "gridspace_link" ADD CONSTRAINT "FK_72981c9e37e59f79144cb4a5ba7" FOREIGN KEY ("localUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "gridspace_auth_session" ADD CONSTRAINT "FK_96b02e13bda214265f1e74ee976" FOREIGN KEY ("localUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "gridspace_import_item" ADD CONSTRAINT "FK_3cf19a127b1b4eeb120de525d9a" FOREIGN KEY ("linkId") REFERENCES "gridspace_link"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "gridspace_import_item" ADD CONSTRAINT "FK_f053543272f86a3bfcce0031d9b" FOREIGN KEY ("targetUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "gridspace_follow_override" ADD CONSTRAINT "FK_00d84ec9deffa610473e8fa76c5" FOREIGN KEY ("localUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "gridspace_follow_override" ADD CONSTRAINT "FK_a94cdb49330b4027bc27610a4d9" FOREIGN KEY ("targetUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "gridspace_follow_override" DROP CONSTRAINT "FK_a94cdb49330b4027bc27610a4d9"`);
        await queryRunner.query(`ALTER TABLE "gridspace_follow_override" DROP CONSTRAINT "FK_00d84ec9deffa610473e8fa76c5"`);
        await queryRunner.query(`ALTER TABLE "gridspace_import_item" DROP CONSTRAINT "FK_f053543272f86a3bfcce0031d9b"`);
        await queryRunner.query(`ALTER TABLE "gridspace_import_item" DROP CONSTRAINT "FK_3cf19a127b1b4eeb120de525d9a"`);
        await queryRunner.query(`ALTER TABLE "gridspace_auth_session" DROP CONSTRAINT "FK_96b02e13bda214265f1e74ee976"`);
        await queryRunner.query(`ALTER TABLE "gridspace_link" DROP CONSTRAINT "FK_72981c9e37e59f79144cb4a5ba7"`);
        await queryRunner.query(`DROP TABLE "gridspace_follow_override"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_60c9d88ac628514784b0fc5000"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5bbf17c8f48d18e515d084dac1"`);
        await queryRunner.query(`DROP TABLE "gridspace_import_item"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7f5c32efe026177554eb253ec8"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b354bf7b63e0b2bbf0fe89a3c7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_96b02e13bda214265f1e74ee97"`);
        await queryRunner.query(`DROP TABLE "gridspace_auth_session"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1a36f54433081b8f130a4d0221"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_gridspace_active_local"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_gridspace_active_peer"`);
        await queryRunner.query(`DROP TABLE "gridspace_link"`);
    }
}
