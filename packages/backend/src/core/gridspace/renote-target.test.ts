/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import type { GridspacePrivateService } from './GridspacePrivateService.js';
import type { GridspaceNoteService } from './GridspaceNoteService.js';
import type { ApNoteService } from '@/core/activitypub/models/ApNoteService.js';
import type { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import type { UtilityService } from '@/core/UtilityService.js';
import type { GetterService } from '@/server/api/GetterService.js';
import RenoteTarget from '@/server/api/endpoints/gridspace/renote-target.js';

function fixture() {
	const reader = mockDeep<GridspacePrivateService>();
	const notes = mockDeep<GridspaceNoteService>();
	const ap = mockDeep<ApNoteService>(); const packer = mockDeep<NoteEntityService>();
	const getter = mockDeep<GetterService>(); const utility = mockDeep<UtilityService>();
	const source = { id: 'old', uri: 'https://r.example/notes/old', origin: 'https://r.example', visibility: 'public', localOnly: true, channelId: null };
	reader.notes.mockImplementation(async () => ({ notes: [source] }) as never);
	notes.historyNote.mockResolvedValue({ id: 'native', visibility: 'public', channelId: null, localOnly: true } as never);
	packer.pack.mockResolvedValue({ id: 'native', visibility: 'public', localOnly: true } as never);
	utility.isFederationAllowedUri.mockReturnValue(true);
	const endpoint = new RenoteTarget(reader, notes, ap, packer, getter, utility, { url: 'https://g.example' } as Config);
	return { source, reader, notes, ap, packer, getter, utility, call: () => endpoint.exec({ noteId: 'old' }, { id: 'viewer' } as MiLocalUser, null) };
}

describe('linked collection renote targets', () => {
	test('uses a freshly authorized native ID and preserves local-only', async () => {
		const f = fixture(); expect(await f.call()).toMatchObject({ id: 'native', localOnly: true });
		expect(f.notes.historyNote).toHaveBeenCalledWith('old', expect.any(Object));
		expect(f.ap.resolveNote).not.toHaveBeenCalled(); expect(f.reader.notes).toHaveBeenCalledTimes(2);
	});
	test('never imports a followers-only or channel note', async () => {
		for (const patch of [{ visibility: 'followers' }, { channelId: 'channel' }, { visibility: 'specified' }]) {
			const f = fixture(); Object.assign(f.source, patch);
			await expect(f.call()).rejects.toMatchObject({ code: 'GRIDSPACE_RENOTE_UNAVAILABLE' });
			expect(f.notes.historyNote).not.toHaveBeenCalled(); expect(f.ap.resolveNote).not.toHaveBeenCalled();
		}
	});
	test('rejects a source made unavailable by historical restrictions or deletion', async () => {
		const f = fixture(); f.notes.historyNote.mockResolvedValue(null);
		await expect(f.call()).rejects.toMatchObject({ code: 'GRIDSPACE_RENOTE_UNAVAILABLE' }); expect(f.packer.pack).not.toHaveBeenCalled();
	});
	test('fetches third-party originals through ActivityPub without accepting private or local-only copies', async () => {
		const f = fixture(); Object.assign(f.source, { uri: 'https://external.example/n/1', localOnly: false });
		f.ap.resolveNote.mockResolvedValue({ id: 'external', channelId: null, visibility: 'home' } as never);
		await f.call(); expect(f.ap.resolveNote).toHaveBeenCalledWith('https://external.example/n/1');
		f.source.localOnly = true;
		await expect(f.call()).rejects.toMatchObject({ code: 'GRIDSPACE_RENOTE_UNAVAILABLE' });
		f.source.localOnly = false; f.ap.resolveNote.mockResolvedValue({ id: 'external', channelId: null, visibility: 'followers' } as never);
		await expect(f.call()).rejects.toMatchObject({ code: 'GRIDSPACE_RENOTE_UNAVAILABLE' });
	});
	test('rejects blocks and revocation before returning a target', async () => {
		const f = fixture(); f.packer.pack.mockResolvedValue({ isHidden: true } as never);
		await expect(f.call()).rejects.toMatchObject({ code: 'GRIDSPACE_RENOTE_UNAVAILABLE' });
		f.packer.pack.mockResolvedValue({ id: 'native' } as never);
		f.reader.notes.mockResolvedValueOnce({ notes: [f.source] } as never).mockResolvedValueOnce({ notes: [] } as never);
		await expect(f.call()).rejects.toMatchObject({ code: 'GRIDSPACE_RENOTE_UNAVAILABLE' });
	});
	test('rejects a note downgraded to followers-only by current author policy', async () => {
		const f = fixture(); f.packer.pack.mockResolvedValue({ id: 'native', visibility: 'followers', isHidden: false } as never);
		await expect(f.call()).rejects.toMatchObject({ code: 'GRIDSPACE_RENOTE_UNAVAILABLE' });
	});
});
