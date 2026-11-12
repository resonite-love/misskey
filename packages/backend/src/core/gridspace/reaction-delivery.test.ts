/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource, EntityManager, Repository, QueryRunner } from 'typeorm';
import type { Config } from '@/config.js';
import { MiNote } from '@/models/Note.js';
import { MiGridspaceReactionDelivery } from '@/models/Gridspace.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { GridspaceReactionDeliveryService } from './GridspaceReactionDeliveryService.js';
import { requestGridspacePeer } from './peer-client.js';

vi.mock('./peer-client.js', () => ({ requestGridspacePeer: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.useRealTimers(); });

function fixture() {
	vi.stubEnv('REACTION_TEST_KEY', Buffer.alloc(32, 1).toString('base64'));
	const config = { url: 'https://g.example', gridspace: { enabled: true, communityId: 'reactions', peerUrl: 'https://r.example', keyId: 'v1', secretEnv: 'REACTION_TEST_KEY' } } as Config;
	const db = mockDeep<DataSource>(); const manager = mockDeep<EntityManager>();
	const runner = mockDeep<QueryRunner>(); runner.query.mockResolvedValue([{ locked: true }]); runner.release.mockResolvedValue();
	db.createQueryRunner.mockReturnValue(runner);
	const queue = mockDeep<Repository<MiGridspaceReactionDelivery>>(); const notes = mockDeep<Repository<MiNote>>();
	const events = mockDeep<GlobalEventService>(); events.publishNoteStream.mockResolvedValue(1);
	db.getRepository.mockImplementation(((entity: unknown) => entity === MiNote ? notes : queue) as never);
	db.transaction.mockImplementation((async (write: (manager: EntityManager) => Promise<unknown>) => write(manager)) as never);
	const note = { id: 'local', userHost: null, uri: null, channelId: null } as MiNote;
	const item = { noteId: note.id, version: 'version-a', peerOrigin: config.gridspace!.peerUrl, attempts: 0 } as MiGridspaceReactionDelivery;
	queue.find.mockResolvedValue([item]); notes.findBy.mockResolvedValue([note]);
	const service = new GridspaceReactionDeliveryService(db, config, events);
	return { service, db, manager, queue, notes, note, item, events, config, runner };
}

describe('durable peer reaction invalidations', () => {
	test('skips delivery when another server process holds the shared database lock', async () => {
		const f = fixture(); f.runner.query.mockResolvedValue([{ locked: false }]);
		await f.service.flush();
		expect(f.queue.find).not.toHaveBeenCalled(); expect(requestGridspacePeer).not.toHaveBeenCalled();
		expect(f.runner.release).toHaveBeenCalled();
	});
	test('stores a change in the same transaction and does not enqueue failed writes', async () => {
		const f = fixture(); const write = vi.fn(async (manager: EntityManager) => { expect(manager).toBe(f.manager); return 42; });
		expect(await f.service.mutate(f.note, write)).toBe(42);
		expect(f.manager.upsert).toHaveBeenCalledWith(MiGridspaceReactionDelivery, expect.objectContaining({ noteId: 'local', peerOrigin: 'https://r.example', attempts: 0 }), ['noteId']);
		f.manager.upsert.mockClear();
		await expect(f.service.mutate(f.note, async () => { throw new Error('write failed'); })).rejects.toThrow('write failed');
		expect(f.manager.upsert).not.toHaveBeenCalled();
	});
	test('does not add peer work to external notes or disabled deployments', async () => {
		const f = fixture(); const write = vi.fn(async () => 1);
		await f.service.mutate({ ...f.note, userHost: 'external.example' }, write);
		const disabled = new GridspaceReactionDeliveryService(f.db, { ...f.config, gridspace: undefined }, f.events);
		await disabled.mutate(f.note, write);
		expect(write).toHaveBeenCalledTimes(2); expect(f.db.transaction).not.toHaveBeenCalled();
	});
	test('batches notifications, waits for acknowledgement and preserves newer versions', async () => {
		const f = fixture(); const peer = vi.mocked(requestGridspacePeer);
		peer.mockImplementation(async () => {
			expect(f.queue.delete).not.toHaveBeenCalled();
			// A concurrent mutation updates the row while version-a is in flight.
			await f.service.mutate(f.note, async () => undefined);
			return { ok: true };
		});
		await f.service.flush();
		expect(peer).toHaveBeenCalledWith(expect.anything(), '/gridspace/v1/reactions/updated', { uris: ['https://g.example/notes/local'] }, 4096, expect.any(Number));
		expect(f.queue.delete).toHaveBeenCalledWith([{ noteId: 'local', version: 'version-a' }]);
		const next = f.manager.upsert.mock.calls[0][1] as MiGridspaceReactionDelivery;
		expect(next.version).not.toBe('version-a');
	});
	test('retains failed delivery with backoff and a restarted worker retries it', async () => {
		const f = fixture(); const peer = vi.mocked(requestGridspacePeer); peer.mockRejectedValueOnce(new Error('offline'));
		const now = Date.now(); await f.service.flush();
		expect(f.queue.delete).not.toHaveBeenCalled();
		const retry = f.queue.update.mock.calls[0][1] as { attempts: number; retryAt: Date };
		expect(retry.attempts).toBe(1); expect(retry.retryAt.getTime()).toBeGreaterThanOrEqual(now + 3000);
		peer.mockResolvedValue({ ok: true });
		await new GridspaceReactionDeliveryService(f.db, f.config, f.events).flush();
		expect(f.queue.delete).toHaveBeenCalledWith([{ noteId: 'local', version: 'version-a' }]);
	});
	test('an invalid acknowledgement never discards pending work', async () => {
		const f = fixture(); vi.mocked(requestGridspacePeer).mockResolvedValue({ ok: false });
		await f.service.flush(); expect(f.queue.delete).not.toHaveBeenCalled(); expect(f.queue.update).toHaveBeenCalled();
	});
	test('receives either origin without echoing changes or sending note/reaction content', async () => {
		const f = fixture(); const remote = { ...f.note, id: 'cached', userHost: 'r.example', uri: 'https://r.example/notes/source' };
		f.notes.findBy.mockResolvedValue([f.note, remote]);
		for (let n = 0; n < 2; n++) await f.service.receive({ uris: ['https://g.example/notes/local', remote.uri] });
		expect(f.events.publishNoteStream).toHaveBeenCalledTimes(4);
		expect(f.events.publishNoteStream).toHaveBeenCalledWith(remote, 'extendedReactionUpdated', {});
		expect(requestGridspacePeer).not.toHaveBeenCalled(); expect(f.manager.upsert).not.toHaveBeenCalled();
		await expect(f.service.receive({ uris: ['https://external.example/notes/local'] })).rejects.toThrow('Invalid note origin');
	});
	test('redis failure prevents acknowledgement, while unknown notes do not cause imports', async () => {
		const f = fixture(); f.events.publishNoteStream.mockRejectedValue(new Error('redis offline'));
		await expect(f.service.receive({ uris: ['https://g.example/notes/local'] })).rejects.toThrow('redis offline');
		f.notes.findBy.mockResolvedValue([]);
		expect(await f.service.receive({ uris: ['https://r.example/notes/unknown'] })).toEqual({ ok: true });
		expect(requestGridspacePeer).not.toHaveBeenCalled();
	});
	test('coalesces capability checks and retains polling for older peers', async () => {
		const f = fixture(); const peer = vi.mocked(requestGridspacePeer); peer.mockResolvedValue({ features: ['community-reaction-updates'] });
		expect(await Promise.all([f.service.supportsPush(), f.service.supportsPush()])).toEqual([true, true]);
		expect(peer).toHaveBeenCalledTimes(1);
		peer.mockResolvedValue({ features: ['community-reactions'] });
		expect(await new GridspaceReactionDeliveryService(f.db, f.config, f.events).supportsPush()).toBe(false);
	});
});
