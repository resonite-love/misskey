/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, IsNull, type EntityManager } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiUser, type MiLocalUser } from '@/models/User.js';
import { MiChannel } from '@/models/Channel.js';
import { MiNoteReaction } from '@/models/NoteReaction.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import { MiPollVote } from '@/models/PollVote.js';
import { ReactionService } from '@/core/ReactionService.js';
import { ExtendedReactionService } from '@/core/ExtendedReactionService.js';
import { PollService, PollVoteError } from '@/core/PollService.js';
import { DriveService } from '@/core/DriveService.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { createTemp } from '@/misc/create-temp.js';
import { GridspaceChannelAuthService } from './GridspaceChannelAuthService.js';
import { GridspaceLinkError, GridspaceLinkService, type GridspacePeerLinkRequest } from './GridspaceLinkService.js';
import { GridspacePrivateService } from './GridspacePrivateService.js';
import { GridspaceReactionService } from './GridspaceReactionService.js';
import { GRIDSPACE_ACTION_SCOPE } from './link-crypto.js';
import { PRIVATE_FILE_LIMIT } from './private-protocol.js';
import type { ActionOptions, ActionPeerRequest, UploadOptions, UploadPeerRequest } from './action-protocol.js';

@Injectable()
export class GridspaceActionService {
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.config) private config: Config,
		private links: GridspaceLinkService,
		private reader: GridspacePrivateService,
		private reactions: ReactionService,
		private polls: PollService,
		private drive: DriveService,
		private files: DriveFileEntityService,
		private users: UserEntityService,
		private extended: ExtendedReactionService,
		private pairedReactions: GridspaceReactionService,
		private channelAuth: GridspaceChannelAuthService,
	) {}

	private async source(input: GridspacePeerLinkRequest & { noteId: string; channelId?: string }, write: boolean) {
		if (input.channelId) this.channelAuth.assertSource();
		if (input.channelActorId) {
			if (!input.channelId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			const user = await this.channelAuth.source(input.channelActorId);
			const note = await this.reader.readableSourceNote(user.id, input.noteId, undefined, input.channelId);
			if (!note || note.channelId !== input.channelId) throw new GridspaceLinkError('ACTION_REJECTED');
			return { user, note };
		}
		const link = await this.links.authorizePrivate(input);
		if (input.channelId && (link.initiator || (write && !await this.links.hasChannelScope(input)))) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if (write && !await this.links.hasActionScope(input)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const user = await this.db.getRepository(MiUser).findOneBy({ id: link.localUserId, host: IsNull() }) as MiLocalUser | null;
		const note = user && await this.reader.readableSourceNote(user.id, input.noteId, undefined, input.channelId);
		if (!user || user.movedToUri || !note || (note.channelId ?? null) !== (input.channelId ?? null)) throw new GridspaceLinkError('ACTION_REJECTED');
		return { user, note };
	}

	private async lockAction(input: GridspacePeerLinkRequest & { channelId?: string }, manager: EntityManager) {
		if (input.channelActorId) {
			if (!input.channelId) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			await this.channelAuth.source(input.channelActorId, manager); return;
		}
		await this.links.lockReplyAuthorization(input, manager, GRIDSPACE_ACTION_SCOPE);
		if (input.channelId && !await this.links.hasChannelScope(input, manager)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
	}

	public async peerAction(input: ActionPeerRequest, rateLimit: (userId: string) => Promise<void>) {
		const write = input.action !== 'prepare' && input.action !== 'reaction-list';
		const { user, note } = await this.source(input, write);
		if (write && input.expectedActorUri && input.expectedActorUri !== (user.uri ?? `${this.config.url}/users/${user.id}`)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if (write) await rateLimit(user.id);
		try {
			if (input.action === 'add-reaction' || input.action === 'remove-reaction') {
				if (!input.reaction) throw new GridspaceLinkError('ACTION_REJECTED');
				await this.reactions.withReactionLock(user.id, note.id, () => this.db.transaction(async manager => {
					await this.lockAction(input, manager);
					const fresh = await this.reader.readableSourceNote(user.id, note.id, manager.queryRunner, input.channelId);
					if (!fresh || (fresh.channelId ?? null) !== (input.channelId ?? null)) throw new GridspaceLinkError('ACTION_REJECTED');
					const authorized = fresh.channelId ? fresh : await this.pairedReactions.prepareMutation(user as MiLocalUser, fresh);
					try {
						if (input.action === 'add-reaction') await this.extended.createUnlocked(user, authorized, input.reaction!, authorized.userHost !== null, !!input.channelActorId);
						else await this.extended.deleteUnlocked(user, authorized, input.reaction!, authorized.userHost !== null, !!input.channelActorId);
					} catch (error) {
						// Retrying a desired membership state never toggles it back.
						const duplicate = input.action === 'add-reaction' ? '51c42bb4-931a-456b-bff7-e5a8a70dd298' : '60527ec9-b4cb-4a88-a6bd-32d3ad26817d';
						if (!(error instanceof IdentifiableError && error.id === duplicate)) throw error;
					}
				}));
			}
			if (input.action === 'react') {
				if (input.reaction === undefined) throw new GridspaceLinkError('ACTION_REJECTED');
				await this.reactions.withReactionLock(user.id, note.id, () => this.db.transaction(async manager => {
					await this.lockAction(input, manager);
					const fresh = await this.reader.readableSourceNote(user.id, note.id, manager.queryRunner, input.channelId);
					if (!fresh || (fresh.channelId ?? null) !== (input.channelId ?? null)) throw new GridspaceLinkError('ACTION_REJECTED');
					const wanted = input.reaction === null ? null : await this.reactions.resolveReaction(user, fresh, input.reaction);
					const previous = await manager.getRepository(MiNoteReaction).findOneBy({ userId: user.id, noteId: note.id });
					if ((previous?.reaction ?? null) === wanted) return;
					if (previous) await this.reactions.deleteUnlocked(user, fresh);
					if (wanted !== null) await this.reactions.createUnlocked(user, fresh, wanted);
				}));
			}
			if (input.action === 'vote') {
				if (input.choice === undefined) throw new GridspaceLinkError('ACTION_REJECTED');
				try {
					await this.polls.castVote(user, note, input.choice, async manager => {
						await this.lockAction(input, manager);
						if (!await this.reader.readableSourceNote(user.id, note.id, manager.queryRunner, input.channelId)) throw new GridspaceLinkError('ACTION_REJECTED');
					});
				} catch (error) {
					// A retry of the same vote is successful; a different single choice is rejected.
					if (!(error instanceof PollVoteError && error.code === 'alreadyVoted' && await this.db.getRepository(MiPollVote).existsBy({ userId: user.id, noteId: note.id, choice: input.choice }))) throw error;
				}
			}
		} catch (error) {
			if (error instanceof IdentifiableError || error instanceof PollVoteError) throw new GridspaceLinkError('ACTION_REJECTED');
			throw error;
		}
		const listed = input.action === 'reaction-list' ? await this.pairedReactions.list(note, user, input.reaction, input.limit ?? 10, undefined, input.untilId) : undefined;
		const reactors = listed ? await Promise.all(listed.map(async row => {
			const actor = await this.db.getRepository(MiUser).findOneByOrFail({ id: row.user.id });
			return { id: row.id, reaction: row.type, account: { name: actor.name, username: actor.username,
				host: actor.host ?? new URL(this.config.url).host, uri: actor.uri ?? `${this.config.url}/users/${actor.id}`,
				avatarUrl: row.user.avatarUrl ?? this.users.getIdenticonUrl(actor) } };
		})) : undefined;
		const page = await this.reader.peerNotes({ ...input, mode: 'show' });
		if (!page.notes[0]) throw new GridspaceLinkError('ACTION_REJECTED');
		const { filterActors: _actors, ...display } = page.notes[0];
		return {
			canInteract: !!input.channelActorId || (await this.links.hasActionScope(input) && (!input.channelId || await this.links.hasChannelScope(input))), note: display, reactors,
			account: { name: user.name, username: user.username, host: user.host ?? new URL(this.config.url).host,
				uri: user.uri ?? `${this.config.url}/users/${user.id}`, avatarUrl: (user.avatarId == null ? null : user.avatarUrl) ?? this.users.getIdenticonUrl(user) },
		};
	}

	public async action(viewer: MiLocalUser, input: ActionOptions) {
		const channel = input.channelId ? await this.channelAuth.destination(viewer) : null;
		const link = channel ? null : await this.links.privateLink(viewer.id);
		if (!(await this.reader.notes(viewer, { mode: 'show', noteId: input.noteId, channelId: input.channelId }, 1)).notes.length) throw new GridspaceLinkError('ACTION_REJECTED');
		const result = await this.links.json<Awaited<ReturnType<GridspaceActionService['peerAction']>>>('/gridspace/v1/private/action', {
			action: input.action, noteId: input.noteId, channelId: input.channelId, expectedActorUri: input.expectedActorUri, reaction: input.reaction, choice: input.choice, untilId: input.untilId, limit: input.limit, ...(channel ? channel.credential : this.links.privateCredential(link!)),
		});
		const note = await this.reader.filterChannelRenote(viewer, result.note, channel?.peerUserId ?? link!.peerUserId);
		if (channel) await channel.check(); else await this.links.checkPrivateUnchanged(link!);
		return { ...result, note };
	}

	private async uploadSource(input: UploadPeerRequest) {
		if (input.channelId) this.channelAuth.assertSource();
		if (!input.channelId) {
			if (!input.noteId) throw new GridspaceLinkError('FILE_REJECTED');
			const { user } = await this.source({ ...input, noteId: input.noteId }, true);
			if (!await this.links.hasReplyScope(input)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			return user;
		}
		if (input.channelActorId) {
			const user = await this.channelAuth.source(input.channelActorId);
			if (!await this.db.getRepository(MiChannel).existsBy({ id: input.channelId, isArchived: false })) throw new GridspaceLinkError('FILE_REJECTED');
			if (input.noteId && !await this.reader.readableSourceNote(user.id, input.noteId, undefined, input.channelId)) throw new GridspaceLinkError('FILE_REJECTED');
			return user;
		}
		const link = await this.links.authorizePrivate(input);
		if (link.initiator || !await this.links.hasActionScope(input) || !await this.links.hasChannelScope(input)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		const user = await this.db.getRepository(MiUser).findOneBy({ id: link.localUserId, host: IsNull() });
		if (!user || user.movedToUri || !await this.db.getRepository(MiChannel).existsBy({ id: input.channelId, isArchived: false })) throw new GridspaceLinkError('FILE_REJECTED');
		if (input.noteId && !await this.reader.readableSourceNote(user.id, input.noteId, undefined, input.channelId)) throw new GridspaceLinkError('FILE_REJECTED');
		return user as MiLocalUser;
	}

	private async lockUpload(input: UploadPeerRequest, user: MiUser, manager: EntityManager) {
		await this.lockAction(input, manager);
		if (input.channelId) {
			if (!await manager.getRepository(MiChannel).findOne({ where: { id: input.channelId, isArchived: false }, lock: { mode: 'pessimistic_read' } })) throw new GridspaceLinkError('FILE_REJECTED');
		} else if (!await this.links.hasReplyScope(input, manager)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if (input.noteId && !await this.reader.readableSourceNote(user.id, input.noteId, manager.queryRunner, input.channelId)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
	}

	public async peerUpload(input: UploadPeerRequest, rateLimit: (userId: string) => Promise<void>) {
		const user = await this.uploadSource(input);
		if (input.expectedActorUri && input.expectedActorUri !== (user.uri ?? `${this.config.url}/users/${user.id}`)) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
		if (input.channelActorId && (!input.sourceFileUrl || new URL(input.sourceFileUrl).protocol !== 'https:')) throw new GridspaceLinkError('FILE_REJECTED');
		if (!this.files.validateFileName(input.name)) throw new GridspaceLinkError('FILE_REJECTED');
		const data = Buffer.from(input.data, 'base64');
		if (!data.length || data.length > Math.min(PRIVATE_FILE_LIMIT, this.config.maxFileSize) || data.toString('base64') !== input.data) throw new GridspaceLinkError('FILE_REJECTED');
		await rateLimit(user.id);
		const [path, cleanup] = await createTemp();
		let created: MiDriveFile | null = null;
		try {
			await writeFile(path, data);
			// Keep local revocation behind the upload. Force a new file so a failed
			// final readability check can delete only this request's file, never a
			// pre-existing deduplicated file from the user's drive.
			const file = await this.db.transaction(async manager => {
				await this.lockUpload(input, user, manager);
				created = await this.drive.addFile({ user, path, name: input.name, comment: input.comment ?? null, sensitive: input.isSensitive ?? false, force: true,
					...(input.channelActorId ? { url: input.sourceFileUrl, uri: input.sourceFileUrl, isLink: true } : {}) });
				await this.lockUpload(input, user, manager);
				return created;
			});
			await this.uploadSource(input);
			return { id: file.id, name: file.name };
		} catch (error) {
			if (created) await this.drive.deleteFileSync(created);
			if (error instanceof IdentifiableError) throw new GridspaceLinkError('FILE_REJECTED');
			throw error;
		} finally { cleanup(); }
	}

	public async upload(viewer: MiLocalUser, input: UploadOptions, path: string) {
		// Use the same author as channel-post; the original stays in their G Drive.
		const channel = input.channelId ? await this.channelAuth.destination(viewer, true) : null;
		const link = channel ? null : await this.links.privateLink(viewer.id);
		if (!input.noteId && !input.channelId) throw new GridspaceLinkError('ACTION_REJECTED');
		if (input.noteId && !(await this.reader.notes(viewer, { mode: 'show', noteId: input.noteId, channelId: input.channelId }, 1)).notes.length) throw new GridspaceLinkError('ACTION_REJECTED');
		const size = (await stat(path)).size;
		if (!size || size > PRIVATE_FILE_LIMIT) throw new GridspaceLinkError('FILE_REJECTED');
		let sourceFileUrl: string | undefined;
		if (channel?.credential.channelActorId) {
			if (input.expectedActorUri && input.expectedActorUri !== `${this.config.url}/users/${viewer.id}`) throw new GridspaceLinkError('AUTHORIZATION_REVOKED');
			// The G user owns the original in their normal Drive. R stores only a
			// re-fetchable cache, so the author can manage files without an R login.
			const original = await this.drive.addFile({ user: viewer, path, name: input.name, comment: input.comment ?? null, sensitive: input.isSensitive ?? false, force: true });
			sourceFileUrl = original.url;
			await channel.check();
		}
		const result = await this.links.json<{ id: string; name: string }>('/gridspace/v1/private/upload', {
			noteId: input.noteId, channelId: input.channelId, expectedActorUri: input.expectedActorUri, name: input.name, comment: input.comment, isSensitive: input.isSensitive,
			data: (await readFile(path)).toString('base64'), sourceFileUrl, ...(channel ? channel.credential : this.links.privateCredential(link!)),
		});
		if (channel) await channel.check(); else await this.links.checkPrivateUnchanged(link!);
		return result;
	}
}
