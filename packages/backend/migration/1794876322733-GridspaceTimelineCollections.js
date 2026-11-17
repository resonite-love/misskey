/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class GridspaceTimelineCollections1794876322733 {
	name = 'GridspaceTimelineCollections1794876322733';

	async up(queryRunner) {
		await queryRunner.query(`CREATE TRIGGER "gridspace_timeline_favorite" AFTER INSERT OR UPDATE OR DELETE ON "note_favorite" FOR EACH ROW EXECUTE FUNCTION gridspace_timeline_audience_event('userId')`);
		await queryRunner.query(`CREATE TRIGGER "gridspace_timeline_clip" AFTER INSERT OR UPDATE OR DELETE ON "clip" FOR EACH ROW EXECUTE FUNCTION gridspace_timeline_audience_event('userId')`);
		await queryRunner.query(`CREATE TRIGGER "gridspace_timeline_clip_note" AFTER INSERT OR UPDATE OR DELETE ON "clip_note" FOR EACH ROW EXECUTE FUNCTION gridspace_timeline_audience_event('')`);
		await queryRunner.query(`CREATE TRIGGER "gridspace_timeline_antenna" AFTER UPDATE OF "src", "userListId", "keywords", "excludeKeywords", "users", "caseSensitive", "withReplies", "withFile", "expression", "localOnly", "excludeBots", "excludeNotesInSensitiveChannel" OR DELETE ON "antenna" FOR EACH ROW EXECUTE FUNCTION gridspace_timeline_audience_event('userId')`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TRIGGER "gridspace_timeline_antenna" ON "antenna"`);
		await queryRunner.query(`DROP TRIGGER "gridspace_timeline_clip_note" ON "clip_note"`);
		await queryRunner.query(`DROP TRIGGER "gridspace_timeline_clip" ON "clip"`);
		await queryRunner.query(`DROP TRIGGER "gridspace_timeline_favorite" ON "note_favorite"`);
	}
}
