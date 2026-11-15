/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { GetterService } from '@/server/api/GetterService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { GridspacePrivateService } from '@/core/gridspace/GridspacePrivateService.js';
import { GridspaceLinkError } from '@/core/gridspace/GridspaceLinkService.js';
import { privateNoteSchema } from '@/core/gridspace/private-protocol.js';

export function parseNoteLink(value: string, config: Pick<Config, 'url' | 'gridspace'>) {
	const link = new URL(value);
	const peer = config.gridspace;
	if (!peer?.enabled || !['source', 'client'].includes(peer.channelRole ?? '') || link.protocol !== 'https:' || link.username || link.password ||
		![config.url, new URL(peer.peerUrl).origin].includes(link.origin) || link.pathname !== '/gridspace/private' ||
		[...link.searchParams.keys()].some(key => !['noteId', 'channelId'].includes(key)) ||
		link.searchParams.getAll('noteId').length !== 1 || link.searchParams.getAll('channelId').length > 1) throw new GridspaceLinkError('INVALID_REQUEST');
	const noteId = link.searchParams.get('noteId')!;
	const channelId = link.searchParams.get('channelId') ?? undefined;
	if (!/^[a-zA-Z0-9]{1,32}$/.test(noteId) || (channelId !== undefined && !/^[a-zA-Z0-9]{1,32}$/.test(channelId))) throw new GridspaceLinkError('INVALID_REQUEST');
	// The route belongs to the viewing server; its note ID belongs to the peer.
	return { noteId, channelId, local: link.origin !== config.url };
}

export const meta = {
	description: 'Resolve a paired-server note link with the current viewer permissions.',
	tags: ['notes'], requireCredential: true, secure: true,
	limit: { duration: 60000, max: 120 },
	errors: { unavailable: { message: 'This linked note is unavailable.', code: 'GRIDSPACE_NOTE_LINK_UNAVAILABLE', id: '893f773b-682d-44de-8cce-4076760e726e' } },
	res: { type: 'object', optional: false, nullable: false, properties: {
		note: { ...privateNoteSchema, nullable: true },
		localNote: { type: 'object', optional: false, nullable: true, ref: 'Note' },
	} },
} as const;
export const paramDef = { type: 'object', properties: { url: { type: 'string', minLength: 1, maxLength: 2048 } }, required: ['url'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(@Inject(DI.config) config: Config, reader: GridspacePrivateService, getter: GetterService, packer: NoteEntityService) {
		super(meta, paramDef, async (ps, me) => {
			try {
				const target = parseNoteLink(ps.url, config);
				if (target.local) {
					if (target.channelId && config.gridspace?.channelRole !== 'source') throw new GridspaceLinkError('UNAVAILABLE');
					const source = await getter.getNote(target.noteId);
					if ((source.channelId ?? undefined) !== target.channelId) throw new GridspaceLinkError('UNAVAILABLE');
					const localNote = await packer.pack(source, me, { detail: true });
					if (localNote.isHidden) throw new GridspaceLinkError('UNAVAILABLE');
					return { note: null, localNote };
				}
				const page = await reader.notes(me, { mode: 'show', noteId: target.noteId, channelId: target.channelId }, 1);
				const note = page.notes[0];
				if (!note || (note.channelId ?? undefined) !== target.channelId) throw new GridspaceLinkError('UNAVAILABLE');
				return { note, localNote: null };
			} catch { throw new ApiError(meta.errors.unavailable); }
		});
	}
}
