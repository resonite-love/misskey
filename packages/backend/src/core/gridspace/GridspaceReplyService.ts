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
import { MiDriveFile } from '@/models/DriveFile.js';
import { MiNote } from '@/models/Note.js';
import { MiChannel } from '@/models/Channel.js';
import { MiGridspaceReplyReceipt } from '@/models/Gridspace.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { isRenote, isQuote } from '@/misc/is-renote.js';
import { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import { GridspaceLinkError, GridspaceLinkService } from './GridspaceLinkService.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import { gridspaceHash, GRIDSPACE_CHANNEL_SCOPE, GRIDSPACE_REPLY_SCOPE } from './link-crypto.js';
import { canSelfRenote, replyAudience, type ReplyOptions, type ReplyPeerRequest } from './reply-protocol.js';

@Injectable()
export class GridspaceReplyService {
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.config) private config: Config,
		private links: GridspaceLinkService,
		private reader: GridspacePrivateService,
		private create: NoteCreateService,
		private users: UserEntityService,
		private channelAuth: GridspaceChannelAuthService,
	) {}

	private actor(user: MiUser) {
		return { name: user.name, username: user.username, host: user.host ?? new URL(this.config.url).host,
			uri: user.uri ?? `${this.config.url}/users/${user.id}`, avatarUrl: (user.avatarId == null ? null : user.avatarUrl) ?? this.users.getIdenticonUrl(user) };
	}

	public async peerReply(input: ReplyPeerRequest, rateLimit: (userId: string) => Promise<void>) {
		const selfRenote = !!input.renoteId && !input.channelId;
		if (input.renoteId && input.noteId) throw new GridspaceLinkError('REPLY_UNAVAILABLE');
		if (selfRenote && (input.text || input.cw != null || input.fileIds?.length || input.poll)) throw new GridspaceLinkError('REPLY_REJECTED');
		if (input.channelId || selfRenote) this.channelAuth.assertSource();
		if (input.channelActorId && !input.channelId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const guest = input.channelActorId ? await this.channelAuth.source(input.channelActorId) : null;
		const link = guest ? null : await this.links.authorizePrivate(input);
		const user = guest ?? await this.db.getRepository(MiUser).findOneBy({ id: link!.localUserId, host: IsNull() });
		if (!user || user.movedToUri) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if (input.expectedActorUri && input.expectedActorUri !== this.actor(user).uri) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if ((input.channelId || selfRenote) && link?.initiator) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const channel = input.channelId ? await this.db.getRepository(MiChannel).findOneBy({ id: input.channelId }) : null;
		const targetId = input.noteId ?? input.renoteId;
		const parent = targetId ? await this.reader.readableSourceNote(user.id, targetId, undefined, input.channelId) : null;
		if ((input.channelId && !channel) || (targetId && !parent) || (!channel && !parent) ||
			(parent && ((parent.channelId ?? null) !== (input.channelId ?? null) || (isRenote(parent) && !isQuote(parent))))) throw new GridspaceLinkError('REPLY_UNAVAILABLE');
		if (input.renoteId && parent && (selfRenote ? !canSelfRenote(parent, user.id) : !['public', 'home'].includes(parent.visibility))) throw new GridspaceLinkError('REPLY_UNAVAILABLE');
		const audience = channel ? { visibility: 'public' as const, localOnly: true, visibleUserIds: [] as string[] } : replyAudience(parent!);
		const authorize = () => input.channelActorId ? this.channelAuth.source(input.channelActorId) : this.links.authorizePrivate(input);
		const canWrite = async () => guest ? !!await authorize() : channel ? this.links.hasChannelScope(input) : this.links.hasReplyScope(input);
		const participants = audience.visibleUserIds.length ? await this.db.getRepository(MiUser).findBy({ id: In(audience.visibleUserIds) }) : [];
		const result = { account: this.actor(user), canReply: !channel?.isArchived && await canWrite(), canAttach: !!guest || await this.links.hasActionScope(input), visibility: audience.visibility, localOnly: audience.localOnly,
			recipients: participants.map(person => this.actor(person)), maxTextLength: MAX_NOTE_TEXT_LENGTH, createdNoteId: null as string | null };
		if (input.action === 'prepare') return result;
		if (!await canWrite()) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if (!input.requestId) throw new GridspaceLinkError('REPLY_REJECTED');
		if (input.action === 'send' && ((!input.renoteId && !input.text?.trim() && !input.fileIds?.length && !input.poll) || Array.from(input.text ?? '').length > MAX_NOTE_TEXT_LENGTH || Array.from(input.cw ?? '').length > 100)) throw new GridspaceLinkError('REPLY_REJECTED');
		const requestHash = gridspaceHash(JSON.stringify([...(channel ? ['channel', channel.id] : []), link?.id ?? `actor:${user.id}`, link?.generation ?? 0, input.noteId, ...(input.renoteId ? ['renote', input.renoteId] : []), input.text, input.cw ?? null, ...(input.fileIds?.length ? [input.fileIds] : []), ...(input.poll ? [{ poll: [input.poll.choices, input.poll.multiple, input.poll.expiresAt] }] : [])]));
		const receipts = this.db.getRepository(MiGridspaceReplyReceipt);
		const receiptKey = { userId: user.id, requestId: input.requestId };
		const previous = await receipts.findOneBy(receiptKey);
		const acknowledged = async (receipt: MiGridspaceReplyReceipt) => {
			if (input.action === 'send' && receipt.requestHash !== requestHash) throw new GridspaceLinkError('REPLY_CONFLICT');
			if (!await this.db.getRepository(MiNote).existsBy({ id: receipt.noteId, userId: user.id, replyId: input.noteId ?? IsNull(), renoteId: input.renoteId ?? IsNull(), channelId: channel?.id ?? IsNull() })) throw new GridspaceLinkError('REPLY_DELETED');
			await authorize();
			if (!await canWrite()) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			return { ...result, createdNoteId: receipt.noteId };
		};
		if (previous) return acknowledged(previous);
		if (input.action === 'status') return result;
		if (!result.canReply) throw new GridspaceLinkError('REPLY_UNAVAILABLE');
		if (input.fileIds?.length && (!result.canAttach || await this.db.getRepository(MiDriveFile).countBy({ id: In(input.fileIds), userId: user.id }) !== input.fileIds.length)) throw new GridspaceLinkError('REPLY_REJECTED');
		await rateLimit(user.id);
		try {
			await authorize();
			const note = await this.create.fetchAndCreate(user, {
				createdAt: new Date(), text: input.text?.trim() ? input.text : null, cw: input.cw ?? null, replyId: input.noteId ?? null, renoteId: input.renoteId ?? null,
				fileIds: input.fileIds ?? [], poll: input.poll ? { choices: input.poll.choices, multiple: input.poll.multiple, expiresAt: input.poll.expiresAt == null ? null : new Date(input.poll.expiresAt) } : null, reactionAcceptance: null, channelId: channel?.id ?? null, ...audience,
				// A mention typed in a private reply must not add recipients or leak its body.
				...(channel ? {} : { apMentions: [] }),
				gridspaceReply: { requestId: input.requestId, requestHash, beforeInsert: async manager => {
					if (input.channelActorId) await this.channelAuth.source(input.channelActorId, manager);
					else await this.links.lockReplyAuthorization(input, manager, channel ? GRIDSPACE_CHANNEL_SCOPE : GRIDSPACE_REPLY_SCOPE);
					if (input.fileIds?.length && ((!guest && !await this.links.hasActionScope(input, manager)) || await manager.getRepository(MiDriveFile).countBy({ id: In(input.fileIds), userId: user.id }) !== input.fileIds.length)) throw new GridspaceLinkError('REPLY_REJECTED');
					if (channel && !await manager.getRepository(MiChannel).findOne({ where: { id: channel.id, isArchived: false }, lock: { mode: 'pessimistic_read' } })) throw new GridspaceLinkError('REPLY_UNAVAILABLE');
					if (parent) {
						const fresh = await this.reader.readableSourceNote(user.id, parent.id, manager.queryRunner, channel?.id);
						if (!fresh || (isRenote(fresh) && !isQuote(fresh)) || (input.renoteId && (selfRenote ? !canSelfRenote(fresh, user.id) : !['public', 'home'].includes(fresh.visibility))) || (channel ? fresh.channelId !== channel.id : fresh.channelId || JSON.stringify(replyAudience(fresh)) !== JSON.stringify(audience))) throw new GridspaceLinkError('REPLY_UNAVAILABLE');
					}
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

	public async reply(viewer: MiLocalUser, input: ReplyOptions, channelPost = false) {
		if (input.renoteId && (input.noteId || (channelPost && !input.channelId) || (!channelPost && input.channelId))) throw new GridspaceLinkError('REPLY_UNAVAILABLE');
		// Channel authorship belongs to the signed-in G account, even when an
		// old R account is linked for reading. Never silently switch that author.
		const channel = channelPost ? await this.channelAuth.destination(viewer, true) : null;
		const link = channel ? null : await this.links.privateLink(viewer.id);
		if (!channelPost && input.renoteId && !link?.initiator) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if (channelPost ? !input.channelId : input.channelId || (!input.noteId && !input.renoteId)) throw new GridspaceLinkError('REPLY_UNAVAILABLE');
		// Apply destination blocks/mutes as well as source readability before sending.
		const targetId = input.noteId ?? input.renoteId;
		if (targetId && !(await this.reader.notes(viewer, { mode: 'show', noteId: targetId, channelId: input.channelId }, 1)).notes.length) throw new GridspaceLinkError('REPLY_UNAVAILABLE');
		const result = await this.links.json<Awaited<ReturnType<GridspaceReplyService['peerReply']>>>('/gridspace/v1/private/reply', { action: input.action, noteId: input.noteId, renoteId: input.renoteId, channelId: input.channelId, expectedActorUri: input.expectedActorUri, requestId: input.requestId, text: input.text, cw: input.cw, fileIds: input.fileIds, poll: input.poll, ...(channel ? channel.credential : this.links.privateCredential(link!)) });
		if (channel) await channel.check(); else await this.links.checkPrivateUnchanged(link!);
		return result;
	}
}
