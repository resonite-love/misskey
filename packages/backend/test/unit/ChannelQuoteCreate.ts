/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { CoreModule } from '@/core/CoreModule.js';
import { GlobalModule } from '@/GlobalModule.js';
import { SignupService } from '@/core/SignupService.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { GridspaceQuoteService } from '@/core/gridspace/GridspaceQuoteService.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { MiNote } from '@/models/Note.js';
import { MiNoteDraft } from '@/models/NoteDraft.js';
import type { MiLocalUser } from '@/models/User.js';
import { PostScheduledNoteProcessorService } from '@/queue/processors/PostScheduledNoteProcessorService.js';
import type { NotificationService } from '@/core/NotificationService.js';
import type { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import Create from '@/server/api/endpoints/notes/create.js';
import { allSettled } from '@/misc/promise-tracker.js';
import { IdService } from '@/core/IdService.js';
import { UserWebhookService } from '@/core/UserWebhookService.js';

describe('channel quote persistence', () => {
	let app: TestingModule, db: DataSource, user: MiLocalUser, endpoint: Create;
	const reference = 'https://g.example/gridspace/private?noteId=source&channelId=channel';
	const check = vi.fn<() => Promise<void>>();
	const quotes = { prepare: vi.fn(async () => ({ url: reference, check })) };
	beforeAll(async () => {
		app = await Test.createTestingModule({ imports: [GlobalModule, CoreModule] })
			.overrideProvider(GridspaceQuoteService).useValue(quotes)
			.overrideProvider(UserWebhookService).useValue({ enqueueUserWebhook: vi.fn().mockResolvedValue(undefined) })
			.compile();
		await app.init();
		db = app.get(DI.db);
		user = (await app.get(SignupService).signup({ username: `quote${Date.now()}` })).account as MiLocalUser;
		endpoint = new Create(app.get(NoteEntityService), app.get(NoteCreateService), quotes as unknown as GridspaceQuoteService);
	}, 60000);
	beforeEach(() => { check.mockReset(); check.mockResolvedValue(); quotes.prepare.mockClear(); });
	afterAll(async () => { await app?.get(NoteCreateService).dispose(); await allSettled(); await app?.close(); });

	test('normal create persists only the reference and forces local-only even if false was requested', async () => {
		const result = await endpoint.exec({ text: 'channel-quote-saved', gridspaceQuote: reference, localOnly: false }, user, null);
		const saved = await db.getRepository(MiNote).findOneByOrFail({ id: result.createdNote.id });
		expect(saved).toMatchObject({ userId: user.id, text: 'channel-quote-saved', gridspaceQuote: reference, localOnly: true, renoteId: null });
		expect(check).toHaveBeenCalledOnce();
	});

	test('revocation during preparation prevents the actual note insert', async () => {
		check.mockRejectedValue(new GridspaceLinkError('ACTION_REJECTED'));
		await expect(endpoint.exec({ text: 'channel-quote-revoked', gridspaceQuote: reference }, user, null)).rejects.toMatchObject({ code: 'CANNOT_RENOTE_OUTSIDE_OF_CHANNEL' });
		expect(await db.getRepository(MiNote).countBy({ userId: user.id, text: 'channel-quote-revoked' })).toBe(0);
	});

	test('a scheduled quote rechecks permission when it runs and keeps the failed draft', async () => {
		const repo = db.getRepository(MiNoteDraft);
		const draft = await repo.save(repo.create({ id: app.get(IdService).gen(), userId: user.id, text: 'channel-quote-scheduled', gridspaceQuote: reference, visibility: 'public', localOnly: false, fileIds: [], visibleUserIds: [], hasPoll: false, pollMultiple: false, pollChoices: [], isActuallyScheduled: true, scheduledAt: new Date() }));
		const notification = { createNotification: vi.fn() };
		const logger = { logger: { createSubLogger: () => ({}) } };
		const processor = new PostScheduledNoteProcessorService(repo, app.get(NoteCreateService), notification as unknown as NotificationService, logger as unknown as QueueLoggerService, quotes as unknown as GridspaceQuoteService);
		check.mockRejectedValue(new GridspaceLinkError('ACTION_REJECTED'));
		await processor.process({ data: { noteDraftId: draft.id } } as Parameters<typeof processor.process>[0]);
		expect(quotes.prepare).toHaveBeenCalledOnce();
		expect(check).toHaveBeenCalledOnce();
		expect(await db.getRepository(MiNote).countBy({ userId: user.id, text: 'channel-quote-scheduled' })).toBe(0);
		expect(await repo.existsBy({ id: draft.id })).toBe(true);
		expect(notification.createNotification).toHaveBeenCalledWith(user.id, 'scheduledNotePostFailed', { noteDraftId: draft.id });
	});
});
