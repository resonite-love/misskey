/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DataSource, type EntityManager } from 'typeorm';
import { MiPoll } from '@/models/Poll.js';
import { MiPollVote } from '@/models/PollVote.js';
import type { MiLocalUser, MiRemoteUser } from '@/models/User.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { QueueService } from '@/core/QueueService.js';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { NotesRepository, UsersRepository, PollsRepository, PollVotesRepository, MiUser } from '@/models/_.js';
import type { MiNote } from '@/models/Note.js';
import { RelayService } from '@/core/RelayService.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { bindThis } from '@/decorators.js';
import { UserBlockingService } from '@/core/UserBlockingService.js';

export class PollVoteError extends Error {
	constructor(public code: 'noSuchNote' | 'noPoll' | 'invalidChoice' | 'alreadyVoted' | 'alreadyExpired' | 'youHaveBeenBlocked') { super(code); }
}

@Injectable()
export class PollService {
	constructor(
		@Inject(DI.db) private db: DataSource,
		private noteEntityService: NoteEntityService,
		private queueService: QueueService,
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.pollsRepository)
		private pollsRepository: PollsRepository,

		@Inject(DI.pollVotesRepository)
		private pollVotesRepository: PollVotesRepository,

		private userEntityService: UserEntityService,
		private idService: IdService,
		private relayService: RelayService,
		private globalEventService: GlobalEventService,
		private userBlockingService: UserBlockingService,
		private apRendererService: ApRendererService,
		private apDeliverManagerService: ApDeliverManagerService,
	) {
	}

	/** Local votes share one transactional path, including delegated old-account votes. */
	@bindThis
	public async castVote(user: MiLocalUser | MiRemoteUser, note: MiNote, choice: number, beforeInsert?: (manager: EntityManager) => Promise<void>) {
		if (user.host !== null && !note.channelId) throw new PollVoteError('noSuchNote');
		if (!await this.noteEntityService.isVisibleForMe(note, user.id)) throw new PollVoteError('noSuchNote');
		if (!note.hasPoll) throw new PollVoteError('noPoll');
		if (note.userId !== user.id && await this.userBlockingService.checkBlocked(note.userId, user.id)) throw new PollVoteError('youHaveBeenBlocked');
		const result = await this.db.transaction(async manager => {
			await beforeInsert?.(manager);
			const poll = await manager.getRepository(MiPoll).findOne({ where: { noteId: note.id }, lock: { mode: 'pessimistic_write' } });
			if (!poll) throw new PollVoteError('noPoll');
			if (poll.expiresAt && poll.expiresAt.getTime() <= Date.now()) throw new PollVoteError('alreadyExpired');
			if (!Number.isInteger(choice) || poll.choices[choice] == null) throw new PollVoteError('invalidChoice');
			const votes = manager.getRepository(MiPollVote);
			const previous = await votes.findBy({ noteId: note.id, userId: user.id });
			if (previous.some(vote => vote.choice === choice) || (!poll.multiple && previous.length)) throw new PollVoteError('alreadyVoted');
			const vote = votes.create({ id: this.idService.gen(), noteId: note.id, userId: user.id, choice });
			await votes.insert(vote);
			await manager.query('UPDATE poll SET votes[$1] = votes[$1] + 1 WHERE "noteId" = $2', [choice + 1, note.id]);
			return { vote, poll };
		});
		this.globalEventService.publishNoteStream(note, 'pollVoted', { choice, userId: user.id });
		if (note.userHost != null && !note.channelId && user.host === null) {
			const owner = await this.usersRepository.findOneByOrFail({ id: note.userId }) as MiRemoteUser;
			this.queueService.deliver(user, this.apRendererService.addContext(await this.apRendererService.renderVote(user, result.vote, note, result.poll, owner)), owner.inbox, false);
		}
		this.deliverQuestionUpdate(note.id);
	}

	@bindThis
	public async vote(user: MiUser, note: MiNote, choice: number) {
		const poll = await this.pollsRepository.findOneBy({ noteId: note.id });

		if (poll == null) throw new Error('poll not found');

		// Check whether is valid choice
		if (poll.choices[choice] == null) throw new Error('invalid choice param');

		// Check blocking
		if (note.userId !== user.id) {
			const blocked = await this.userBlockingService.checkBlocked(note.userId, user.id);
			if (blocked) {
				throw new Error('blocked');
			}
		}

		// if already voted
		const exist = await this.pollVotesRepository.findBy({
			noteId: note.id,
			userId: user.id,
		});

		if (poll.multiple) {
			if (exist.some(x => x.choice === choice)) {
				throw new Error('already voted');
			}
		} else if (exist.length !== 0) {
			throw new Error('already voted');
		}

		await this.pollVotesRepository.insert({
			id: this.idService.gen(),
			noteId: note.id,
			userId: user.id,
			choice: choice,
		});

		// Increment votes count
		const index = choice + 1; // In SQL, array index is 1 based
		await this.pollsRepository.query('UPDATE poll SET votes[$1] = votes[$1] + 1 WHERE "noteId" = $2', [index, poll.noteId]);

		this.globalEventService.publishNoteStream(note, 'pollVoted', {
			choice: choice,
			userId: user.id,
		});
	}

	@bindThis
	public async deliverQuestionUpdate(noteId: MiNote['id']) {
		const note = await this.notesRepository.findOneBy({ id: noteId });
		if (note == null) throw new Error('note not found');

		if (note.localOnly) return;

		const user = await this.usersRepository.findOneBy({ id: note.userId });
		if (user == null) throw new Error('note not found');

		if (this.userEntityService.isLocalUser(user)) {
			const content = this.apRendererService.addContext(this.apRendererService.renderUpdate(await this.apRendererService.renderNote(note, false), user));
			this.apDeliverManagerService.deliverToFollowers(user, content);
			this.relayService.deliverToRelays(user, content);
		}
	}
}
