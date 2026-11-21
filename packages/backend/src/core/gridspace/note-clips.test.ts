/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DataSource } from 'typeorm';
import type { ModuleRef } from '@nestjs/core';
import type { Config } from '@/config.js';
import type { Packed } from '@/misc/json-schema.js';
import type { MiAccessToken } from '@/models/AccessToken.js';
import { MiNote } from '@/models/Note.js';
import { MiClip } from '@/models/Clip.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import type { ClipEntityService } from '@/core/entities/ClipEntityService.js';
import { GridspaceNoteClipsService } from './GridspaceNoteClipsService.js';
import type { GridspacePlacementActionService } from './GridspacePlacementActionService.js';
import type { GridspacePrivateService } from './GridspacePrivateService.js';
import type { GridspacePublicNoteService } from './GridspacePublicNoteService.js';
import type { GridspaceLinkService } from './GridspaceLinkService.js';
import type { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import NoteClipsEndpoint from '@/server/api/endpoints/gridspace/note-clips.js';
import LegacyClipsEndpoint from '@/server/api/endpoints/notes/clips.js';

const clip = { id: 'clip', userId: 'owner', name: 'Public', isPublic: true, user: { id: 'owner', host: null } } as Packed<'Clip'>;
const viewer = { id: 'viewer' } as MiLocalUser;

function fixture() {
	const db = mockDeep<DataSource>(), packer = mockDeep<ClipEntityService>(), links = mockDeep<GridspaceLinkService>();
	const reader = mockDeep<GridspacePrivateService>(), publicNotes = mockDeep<GridspacePublicNoteService>(), channels = mockDeep<GridspaceChannelAuthService>(), modules = mockDeep<ModuleRef>();
	const placementActions = mockDeep<GridspacePlacementActionService>();
	const config = { url: 'https://g.example', gridspace: { enabled: true, peerUrl: 'https://r.example', channelRole: 'client' } } as Config;
	const query = { innerJoin: vi.fn(), where: vi.fn(), andWhere: vi.fn(), orderBy: vi.fn(), getMany: vi.fn().mockResolvedValue([clip]) };
	for (const key of ['innerJoin', 'where', 'andWhere', 'orderBy'] as const) query[key].mockReturnValue(query);
	const notes = { findOneBy: vi.fn().mockResolvedValue({ id: 'note', uri: null, channelId: null }) };
	db.getRepository.mockImplementation((entity: unknown) => (entity === MiNote ? notes : entity === MiClip ? { createQueryBuilder: () => query } : entity === MiUser ? { findBy: async () => [] } : {}) as never);
	const native = vi.fn().mockResolvedValue({ id: 'note', uri: null, clippedCount: 0, visibility: 'public' });
	modules.get.mockReturnValue({ exec: native } as never);
	packer.packMany.mockImplementation(async rows => rows as unknown as Packed<'Clip'>[]);
	links.privateLink.mockResolvedValue({ localUserId: 'viewer' } as never);
	links.privateCredential.mockReturnValue({ accessToken: 'grant', localUserId: 'viewer' });
	links.authorizePrivate.mockResolvedValue({ localUserId: 'viewer', initiator: false } as never);
	reader.readableSourceNote.mockResolvedValue({ id: 'note' } as never);
	reader.notes.mockResolvedValue({ notes: [{ id: 'note' }] } as never);
	links.json.mockResolvedValue({ origin: 'https://r.example', noteId: 'remote', noteUri: 'https://g.example/notes/note', clips: [{ ...clip, id: 'remoteclip' }] });
	channels.destination.mockResolvedValue({ credential: { channelActorId: 'viewer' }, check: vi.fn() } as never);
	channels.source.mockResolvedValue({ id: 'actor' } as never);
	const service = new GridspaceNoteClipsService(db, config, packer, links, reader, publicNotes, channels, modules, placementActions);
	return { service, db, config, packer, links, reader, publicNotes, channels, placementActions, native, notes, query };
}

describe('public clip memberships across the paired servers', () => {
	test('merges local and peer clips even when a local note has zero local clipped count', async () => {
		const f = fixture();
		const result = await f.service.list({ noteId: 'note' }, viewer);
		expect(result.partial).toBe(false);
		expect(result.clips.map(c => c.id)).toEqual(['clip', 'remoteclip']);
		expect(result.clips[1]).toMatchObject({ gridspaceOrigin: 'https://r.example', userId: 'gridspace:owner', user: { host: 'r.example' } });
		expect(f.packer.packMany).toHaveBeenCalledWith([clip], viewer);
		expect(f.links.json).toHaveBeenCalledWith('/gridspace/v1/notes/clips', expect.objectContaining({ noteUri: 'https://g.example/notes/note' }));
	});

	test('looks up clips for a peer-authored copy by its original URI, normalizing activity aliases', async () => {
		const f = fixture();
		f.native.mockResolvedValue({ id: 'copy', uri: 'https://r.example/notes/original/activity' });
		f.links.json.mockResolvedValue({ origin: 'https://r.example', noteId: 'original', noteUri: 'https://r.example/notes/original', clips: [clip] });
		expect((await f.service.list({ noteId: 'copy' }, viewer)).partial).toBe(false);
		expect(f.links.json).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ noteUri: 'https://r.example/notes/original' }));
	});

	test('retains local results on peer failure, while still rechecking note visibility', async () => {
		const f = fixture(); f.links.json.mockRejectedValue(new Error('offline'));
		expect(await f.service.list({ noteId: 'note' }, viewer)).toEqual({ clips: [clip], partial: true });
		expect(f.native).toHaveBeenCalledTimes(2);
		f.native.mockReset().mockResolvedValueOnce({ id: 'note' }).mockResolvedValueOnce({ id: 'note', isHidden: true });
		await expect(f.service.list({ noteId: 'note' }, viewer)).rejects.toThrow('UNAVAILABLE');
	});

	test('drops peer data when its grant is revoked while local clips are packed', async () => {
		const f = fixture();
		f.links.checkPrivateUnchanged.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
		expect(await f.service.list({ noteId: 'note' }, viewer)).toEqual({ clips: [clip], partial: true });
	});

	test('does not send third-party note requests to the special peer', async () => {
		const f = fixture(); f.native.mockResolvedValue({ id: 'note', uri: 'https://other.example/notes/note' });
		expect((await f.service.list({ noteId: 'note' }, viewer)).clips).toEqual([clip]);
		expect(f.links.json).not.toHaveBeenCalled();
	});

	test('does not return a clip made private or removed while it was being packed', async () => {
		const f = fixture(); f.query.getMany.mockResolvedValueOnce([clip]).mockResolvedValueOnce([]);
		expect((await f.service.peer({ noteId: 'note' })).clips).toEqual([]);
		expect(f.query.where).toHaveBeenCalledWith(expect.stringContaining('clip.isPublic = true'));
		expect(f.query.where).toHaveBeenCalledWith(expect.stringContaining('owner.isSuspended = false'));
	});

	test('anonymous peer lookups use visitor policy before and after reading memberships', async () => {
		const f = fixture();
		expect((await f.service.peer({ noteUri: 'https://g.example/notes/note/activity' })).clips).toEqual([clip]);
		expect(f.notes.findOneBy).toHaveBeenCalledWith({ id: 'note' });
		expect(f.publicNotes.local).toHaveBeenCalledTimes(2);
		f.publicNotes.local.mockRejectedValue(new Error('private'));
		await expect(f.service.peer({ noteId: 'note' })).rejects.toThrow('private');
	});

	test('rejects revoked delegated reads after packing the public memberships', async () => {
		const f = fixture(); f.links.authorizePrivate.mockResolvedValueOnce({ localUserId: 'viewer' } as never).mockRejectedValueOnce(new Error('revoked'));
		await expect(f.service.peer({ noteId: 'note', accessToken: 'grant' })).rejects.toThrow('revoked');
		expect(f.reader.readableSourceNote).toHaveBeenCalledWith('viewer', 'note', undefined, undefined);
	});

	test('requires the destination note view to allow a private-source lookup', async () => {
		const f = fixture(); f.reader.notes.mockResolvedValue({ notes: [] } as never);
		await expect(f.service.list({ noteId: 'note', source: 'peer' }, viewer)).rejects.toThrow('UNAVAILABLE');
		expect(f.links.json).not.toHaveBeenCalled();
	});

	test('an ordinary OAuth token cannot consume a saved private grant without its scope', async () => {
		const f = fixture(); const token = { name: 'third-party', permission: [] } as unknown as MiAccessToken;
		await expect(f.service.list({ noteId: 'note', source: 'peer' }, viewer, token)).rejects.toThrow('AUTHORIZATION_REVOKED');
		expect(f.reader.notes).not.toHaveBeenCalled();
		await f.service.list({ noteId: 'note' }, viewer, token);
		expect(f.links.privateLink).not.toHaveBeenCalled();
		expect(f.links.json).toHaveBeenCalledWith('/gridspace/v1/notes/clips', { noteUri: 'https://g.example/notes/note' });
	});

	test('both API endpoints pass OAuth scope information into the reader', async () => {
		const f = fixture(); const token = { name: 'third-party', permission: [] } as unknown as MiAccessToken;
		const endpoint = new NoteClipsEndpoint(f.service);
		await expect(endpoint.exec({ noteId: 'note', source: 'peer' }, viewer, token)).rejects.toMatchObject({ code: 'NOTE_CLIPS_UNAVAILABLE' });
		const legacy = new LegacyClipsEndpoint(f.service);
		await legacy.exec({ noteId: 'note' }, viewer, token);
		expect(f.links.privateLink).not.toHaveBeenCalled();
	});

	test('rejects a peer credential on the general API before using a later grant', async () => {
		const f = fixture(); f.links.assertPrivateCaller.mockImplementation(() => { throw new Error('AUTHORIZATION_REVOKED'); });
		const token = { permission: ['read:gridspace-private'] } as unknown as MiAccessToken;
		await expect(f.service.list({ noteId: 'note' }, viewer, token)).rejects.toThrow('AUTHORIZATION_REVOKED');
		expect(f.links.json).not.toHaveBeenCalled();
	});

	test('rechecks destination restrictions after the peer response', async () => {
		const f = fixture();
		f.links.json.mockResolvedValue({ origin: 'https://r.example', noteId: 'note', noteUri: 'https://g.example/notes/note', clips: [clip] });
		f.reader.notes.mockResolvedValueOnce({ notes: [{ id: 'note' }] } as never).mockResolvedValueOnce({ notes: [] } as never);
		await expect(f.service.list({ noteId: 'note', source: 'peer' }, viewer)).rejects.toThrow('UNAVAILABLE');
	});

	test('channel-only readers retain channel-scoped authorization', async () => {
		const f = fixture(); f.config.gridspace!.channelRole = 'source'; f.notes.findOneBy.mockResolvedValue({ id: 'note', uri: null, channelId: 'channel' });
		await f.service.peer({ noteId: 'note', channelId: 'channel', channelActorId: 'viewer' });
		expect(f.channels.source).toHaveBeenCalledTimes(2);
		expect(f.reader.readableSourceNote).toHaveBeenCalledWith('actor', 'note', undefined, 'channel');
	});

	test('resolves dedicated clips through the signed guest conversation and checks the view again after packing', async () => {
		const f = fixture();
		const conversationUri = 'https://r.example/notes/note';
		const check = vi.fn();
		f.placementActions.destination.mockResolvedValue({ credential: { placementActorId: 'guest' }, check } as never);
		f.links.json.mockResolvedValue({ origin: 'https://r.example', noteId: 'note', noteUri: conversationUri, clips: [clip] });
		const endpoint = new NoteClipsEndpoint(f.service);
		expect((await endpoint.exec({ source: 'peer', noteId: 'note', conversationUri }, viewer, null)).partial).toBe(false);
		expect(f.reader.notes).toHaveBeenCalledTimes(2);
		expect(f.reader.notes).toHaveBeenCalledWith(viewer, expect.objectContaining({ mode: 'show', noteId: 'note', conversationUri }), 1);
		expect(f.placementActions.destination).toHaveBeenCalledWith(viewer, conversationUri, 'note');
		expect(f.links.json).toHaveBeenCalledWith('/gridspace/v1/notes/clips', expect.objectContaining({ placementActorId: 'guest', conversationUri, noteId: 'note' }));
		expect(f.links.privateLink).not.toHaveBeenCalled();
		expect(check).toHaveBeenCalledTimes(2);
	});

	test('checks the guest placement ACL before and after collecting clips on the source', async () => {
		const f = fixture();
		const input = { noteId: 'note', conversationUri: 'https://g.example/notes/note', placementActorId: 'guest' };
		f.placementActions.source.mockResolvedValueOnce({ user: { id: 'actor' } } as never).mockRejectedValueOnce(new Error('revoked'));
		await expect(f.service.peer(input)).rejects.toThrow('revoked');
		expect(f.placementActions.source).toHaveBeenCalledTimes(2);
		expect(f.placementActions.source).toHaveBeenCalledWith(input, 'read');
		expect(f.packer.packMany).toHaveBeenCalledWith([clip], { id: 'actor' });
		expect(f.publicNotes.local).not.toHaveBeenCalled();
	});

	test('authorizes an explicitly selected placement using its current channel even when the note has no legacy channel', async () => {
		const f = fixture();
		f.config.gridspace!.channelRole = 'source';
		const input = { noteId: 'note', channelId: 'placement', channelActorId: 'viewer' };
		expect((await f.service.peer(input)).clips).toEqual([clip]);
		expect(f.reader.readableSourceNote).toHaveBeenCalledTimes(2);
		expect(f.reader.readableSourceNote).toHaveBeenCalledWith('actor', 'note', undefined, 'placement');
		f.reader.readableSourceNote.mockResolvedValue(null);
		await expect(f.service.peer(input)).rejects.toThrow('UNAVAILABLE');
	});

	test.each([{ origin: 'https://wrong.example' }, { clips: [{ ...clip, isPublic: false }] }])('rejects untrusted or non-public peer clip data: %j', async change => {
		const f = fixture(); f.links.json.mockResolvedValue({ origin: 'https://r.example', noteId: 'remote', noteUri: 'https://g.example/notes/note', clips: [clip], ...change });
		expect(await f.service.list({ noteId: 'note' }, viewer)).toEqual({ clips: [clip], partial: true });
	});
});
