/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource, EntityManager } from 'typeorm';
import type { ModuleRef } from '@nestjs/core';
import type { Config } from '@/config.js';
import type { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import type { DriveFolderEntityService } from '@/core/entities/DriveFolderEntityService.js';
import type { IdService } from '@/core/IdService.js';
import type { GlobalEventService } from '@/core/GlobalEventService.js';
import { MiGridspaceLink } from '@/models/Gridspace.js';
import { MiGridspaceDriveEntry } from '@/models/GridspaceDriveEntry.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import { GridspaceSharedDriveService } from './GridspaceSharedDriveService.js';
import { validateSharedDriveWire, type SharedDriveWire } from './shared-drive-protocol.js';

const wire: SharedDriveWire = { kind: 'folder', origin: 'https://r.example', id: 'folder1', revision: 3,
	deleted: false, createdAt: '2026-11-13T00:00:00Z', name: 'folder', parent: null };

function fixture() {
	const db = mockDeep<DataSource>();
	const links = mockDeep<GridspaceLinkService>();
	const service = new GridspaceSharedDriveService(db, { url: 'https://g.example', gridspace: { enabled: true, peerUrl: 'https://r.example' } } as Config,
		mockDeep<ModuleRef>(), links, mockDeep<DriveFileEntityService>(), mockDeep<DriveFolderEntityService>(), mockDeep<IdService>(), mockDeep<GlobalEventService>());
	const internal = service as unknown as {
		acceptRecord(manager: EntityManager, link: MiGridspaceLink, value: SharedDriveWire, changes: unknown[]): Promise<string>;
		deliver(entry: MiGridspaceDriveEntry): Promise<void>;
	};
	return { db, links, internal };
}

describe('shared Drive delivery guards', () => {
	test.each([{ deleted: true, revision: 2 }, { deleted: false, revision: 3 }, { deleted: false, revision: 4 }])('does not recreate tombstones or replay old revisions: %o', async state => {
		const { internal } = fixture();
		const manager = mockDeep<EntityManager>();
		const entries = { findOneBy: async () => ({ ...state, localId: 'reference1' }), save: () => { throw new Error('Must not write'); } };
		manager.getRepository.mockImplementation(entity => {
			if (entity !== MiGridspaceDriveEntry) throw new Error('Must not access files or folders');
			return entries as never;
		});
		expect(await internal.acceptRecord(manager, { id: 'link1' } as MiGridspaceLink, wire, [])).toBe('reference1');
	});

	test('keeps a failed delivery pending and backs off without overwriting a newer revision', async () => {
		const { db, links, internal } = fixture();
		const entries = mockDeep<ReturnType<DataSource['getRepository']>>();
		const pairs = mockDeep<ReturnType<DataSource['getRepository']>>();
		const users = mockDeep<ReturnType<DataSource['getRepository']>>();
		pairs.findOneBy.mockResolvedValue({ id: 'link1', localUserId: 'user1' } as never);
		users.existsBy.mockResolvedValue(true);
		db.getRepository.mockImplementation(entity => (entity === MiGridspaceDriveEntry ? entries : entity === MiGridspaceLink ? pairs : users) as never);
		links.json.mockRejectedValue(new Error('Peer is offline'));
		await internal.deliver({ id: 'entry1', linkId: 'link1', revision: 3, deleted: true, payload: { ...wire, deleted: true }, attempts: 0 } as unknown as MiGridspaceDriveEntry);
		expect(entries.update).toHaveBeenCalledWith({ id: 'entry1', revision: 3 }, expect.objectContaining({ attempts: 1, lastError: 'PEER_UNAVAILABLE', retryAt: expect.any(Date) }));
		expect(entries.update).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pending: false }));
	});

	test('rejects third-party origins and unsafe file URLs before storing a reference', () => {
		expect(() => validateSharedDriveWire({ ...wire, origin: 'https://other.example' }, ['https://g.example', 'https://r.example'])).toThrow();
		expect(() => validateSharedDriveWire({ ...wire, kind: 'file', file: { url: 'javascript:alert(1)', thumbnailUrl: null, webpublicUrl: null, webpublicType: null,
			type: 'image/png', md5: 'a'.repeat(32), size: 1, comment: null, blurhash: null, properties: {}, isSensitive: false } }, ['https://r.example'])).toThrow();
	});

	test('delivers the persisted tombstone after account deletion cascades the local pair', async () => {
		const { db, links, internal } = fixture();
		const entries = mockDeep<ReturnType<DataSource['getRepository']>>();
		const pairs = mockDeep<ReturnType<DataSource['getRepository']>>();
		pairs.findOneBy.mockResolvedValue(null);
		pairs.existsBy.mockResolvedValue(false);
		db.getRepository.mockImplementation(entity => (entity === MiGridspaceDriveEntry ? entries : pairs) as never);
		const binding = { linkId: 'link1', generation: 1, localUserId: 'deletedUser', peerUserId: 'liveUser' };
		await internal.deliver({ id: 'entry1', linkId: 'link1', origin: 'https://g.example', revision: 4, deleted: true,
			payload: { ...wire, origin: 'https://g.example', deleted: true, binding }, attempts: 0 } as unknown as MiGridspaceDriveEntry);
		expect(links.json).toHaveBeenCalledWith('/gridspace/v1/shared-drive', expect.objectContaining({ ...binding, action: 'put', wire: expect.objectContaining({ deleted: true }) }));
		expect(entries.update).toHaveBeenCalledWith({ id: 'entry1', revision: 4 }, expect.objectContaining({ pending: false }));
	});
});
