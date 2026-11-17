/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class GridspaceTimelineInvalidation1794882992056 {
	name = 'GridspaceTimelineInvalidation1794882992056';

	async up(queryRunner) {
		await queryRunner.query(`CREATE FUNCTION gridspace_timeline_wakeup() RETURNS trigger LANGUAGE plpgsql AS $body$
		BEGIN
			PERFORM pg_notify('gridspace_timeline_changed', '');
			RETURN NULL;
		END $body$`);
		await queryRunner.query(`CREATE TRIGGER "gridspace_timeline_wakeup" AFTER INSERT ON "gridspace_timeline_outbox" FOR EACH STATEMENT EXECUTE FUNCTION gridspace_timeline_wakeup()`);
		await queryRunner.query(`CREATE TRIGGER "gridspace_timeline_token_policy" AFTER UPDATE OF "permission" OR DELETE ON "access_token" FOR EACH ROW EXECUTE FUNCTION gridspace_timeline_audience_event('userId')`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TRIGGER "gridspace_timeline_token_policy" ON "access_token"`);
		await queryRunner.query(`DROP TRIGGER "gridspace_timeline_wakeup" ON "gridspace_timeline_outbox"`);
		await queryRunner.query(`DROP FUNCTION gridspace_timeline_wakeup()`);
	}
}
