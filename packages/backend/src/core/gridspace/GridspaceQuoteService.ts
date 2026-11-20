/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import { GridspaceLinkError } from './GridspaceLinkService.js';
import { parseChannelQuote } from './quote-reference.js';

@Injectable()
export class GridspaceQuoteService {
	constructor(@Inject(DI.config) private config: Config, private reader: GridspacePrivateService) {}

	public async prepare(viewer: MiLocalUser, value: string) {
		if (!this.config.gridspace?.enabled || this.config.gridspace.channelRole !== 'client') throw new GridspaceLinkError('ACTION_REJECTED');
		let target;
		try { target = parseChannelQuote(value, this.config.url); } catch { throw new GridspaceLinkError('ACTION_REJECTED'); }
		const check = async () => {
			const page = await this.reader.notes(viewer, { mode: 'show', noteId: target.noteId, channelId: target.channelId }, 1);
			const note = page.notes[0];
			if (!note || note.id !== target.noteId || note.channelId !== target.channelId || note.origin !== new URL(this.config.gridspace!.peerUrl).origin || note.uri !== `${note.origin}/notes/${target.noteId}` ||
				!note.canQuoteOutside || !['public', 'home'].includes(note.visibility)) throw new GridspaceLinkError('ACTION_REJECTED');
		};
		await check();
		return { url: target.url, check };
	}
}
