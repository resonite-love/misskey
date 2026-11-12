/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, In, IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MAX_NOTE_TEXT_LENGTH } from '@/const.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiNote } from '@/models/Note.js';
import { MiGridspaceReplyReceipt } from '@/models/Gridspace.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { isRenote, isQuote } from '@/misc/is-renote.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import { gridspaceHash } from './link-crypto.js';
import { replyAudience, type ReplyOptions, type ReplyPeerRequest } from './reply-protocol.js';

@Injectable()
export class GridspaceReplyService {
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.config) private config: Config,
		private links: GridspaceLinkService,
		private reader: GridspacePrivateService,
		private create: NoteCreateService,
		private users: UserEntityService,
	) {}

	private actor(user: MiUser) {
		return { name: user.name, username: user.username, host: user.host ?? new URL(this.config.url).host,
			uri: user.uri ?? `${this.config.url}/users/${user.id}`, avatarUrl: (user.avatarId == null ? null : user.avatarUrl) ?? this.users.getIdenticonUrl(user) };
	}

	public async peerReply(input: ReplyPeerRequest, rateLimit: (userId: string) => Promise<void>) {
		const link = await this.links.authorizePrivate(input);
		const user = await this.db.getRepository(MiUser).findOneBy({ id: link.localUserId, host: IsNull() });
		if (!user || user.movedToUri) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const parent = await this.reader.readableSourceNote(user.id, input.noteId);
		if (!parent || parent.channelId || (isRenote(parent) && !isQuote(parent))) throw new GridspaceLinkError('REPLY_UNAVAILABLE');
		const audience = replyAudience(parent);
		const participants = audience.visibleUserIds.length ? await this.db.getRepository(MiUser).findBy({ id: In(audience.visibleUserIds) }) : [];
		const result = { account: this.actor(user), canReply: await this.links.hasReplyScope(input), visibility: audience.visibility, localOnly: audience.localOnly,
			recipients: participants.map(person => this.actor(person)), maxTextLength: MAX_NOTE_TEXT_LENGTH, createdNoteId: null as string | null };
		if (input.action === 'prepare') return result;
		if (!result.canReply) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if (!input.requestId) throw new GridspaceLinkError('REPLY_REJECTED');
		if (input.action === 'send' && (!input.text?.trim() || Array.from(input.text).length > MAX_NOTE_TEXT_LENGTH || Array.from(input.cw ?? '').length > 100)) throw new GridspaceLinkError('REPLY_REJECTED');
		const requestHash = gridspaceHash(JSON.stringify([link.id, link.generation, input.noteId, input.text, input.cw ?? null]));
		const receipts = this.db.getRepository(MiGridspaceReplyReceipt);
		const receiptKey = { userId: user.id, requestId: input.requestId };
		const previous = await receipts.findOneBy(receiptKey);
		const acknowledged = async (receipt: MiGridspaceReplyReceipt) => {
			if (input.action === 'send' && receipt.requestHash !== requestHash) throw new GridspaceLinkError('REPLY_CONFLICT');
			if (!await this.db.getRepository(MiNote).existsBy({ id: receipt.noteId, userId: user.id, replyId: parent.id })) throw new GridspaceLinkError('REPLY_DELETED');
			await this.links.authorizePrivate(input);
			if (!await this.links.hasReplyScope(input)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			return { ...result, createdNoteId: receipt.noteId };
		};
		if (previous) return acknowledged(previous);
		if (input.action === 'status') return result;
		if (!input.text) throw new GridspaceLinkError('REPLY_REJECTED');
		await rateLimit(user.id);
		try {
			await this.links.authorizePrivate(input);
			const note = await this.create.fetchAndCreate(user, {
				createdAt: new Date(), text: input.text, cw: input.cw ?? null, replyId: parent.id, renoteId: null,
				fileIds: [], poll: null, reactionAcceptance: null, channelId: null, ...audience,
				// A mention typed in a private reply must not add recipients or leak its body.
				apMentions: [],
				gridspaceReply: { requestId: input.requestId, requestHash, beforeInsert: async manager => {
					await this.links.lockReplyAuthorization(input, manager);
					const fresh = await this.reader.readableSourceNote(user.id, parent.id, manager.queryRunner);
					if (!fresh || fresh.channelId || JSON.stringify(replyAudience(fresh)) !== JSON.stringify(audience)) throw new GridspaceLinkError('REPLY_UNAVAILABLE');
				} },
			});
			return { ...result, createdNoteId: note.id };
		} catch (error) {
			if (error instanceof Error && error.name === 'duplicated') {
				const winner = await receipts.findOneBy(receiptKey);
				if (winner) return acknowledged(winner);
			}
			if (error instanceof IdentifiableError) throw new GridspaceLinkError('REPLY_REJECTED');
			throw error;
		}
	}

	public async reply(viewer: MiLocalUser, input: ReplyOptions) {
		const link = await this.links.privateLink(viewer.id);
		// Apply destination blocks/mutes as well as source readability before sending.
		if (!(await this.reader.notes(viewer, { mode: 'show', noteId: input.noteId }, 1)).notes.length) throw new GridspaceLinkError('REPLY_UNAVAILABLE');
		const result = await this.links.json<Awaited<ReturnType<GridspaceReplyService['peerReply']>>>('/gridspace/v1/private/reply', { ...this.links.privateCredential(link), ...input });
		await this.links.checkPrivateUnchanged(link);
		return result;
	}
}
