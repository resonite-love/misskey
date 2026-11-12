/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onUnmounted, reactive } from 'vue';
import * as Misskey from 'misskey-js';
import { EventEmitter } from 'eventemitter3';
import { createVisibilityAwareInterval } from '@@/js/interval.js';
import type { Reactive } from 'vue';
import type { NoteUpdatedEvent } from 'misskey-js/streaming.types.js';
import { useStream } from '@/stream.js';
import { $i } from '@/i.js';
import { store } from '@/store.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { prefer } from '@/preferences.js';
import { fetchExtendedReactions, watchSharedReactions, supportsExtendedReactions } from '@/utility/extended-reactions.js';
import { globalEvents } from '@/events.js';

export const noteEvents = new EventEmitter<{
	[ev: `extendedUpdated:${string}`]: () => void;
	[ev: `reacted:${string}`]: (ctx: { userId: Misskey.entities.User['id']; reaction: string; emoji?: { name: string; url: string; } | null; }) => void;
	[ev: `unreacted:${string}`]: (ctx: { userId: Misskey.entities.User['id']; reaction: string; emoji?: { name: string; url: string; } | null; }) => void;
	[ev: `pollVoted:${string}`]: (ctx: { userId: Misskey.entities.User['id']; choice: number; }) => void;
}>();

const fetchEvent = new EventEmitter<{
	[id: string]: Pick<Misskey.entities.Note, 'reactions' | 'reactionEmojis'>;
}>();

const pollingQueue = new Map<string, {
	referenceCount: number;
	lastAddedAt: number;
}>();

function pollingEnqueue(note: Pick<Misskey.entities.Note, 'id' | 'createdAt'>) {
	if (pollingQueue.has(note.id)) {
		const data = pollingQueue.get(note.id)!;
		pollingQueue.set(note.id, {
			...data,
			referenceCount: data.referenceCount + 1,
			lastAddedAt: Date.now(),
		});
	} else {
		pollingQueue.set(note.id, {
			referenceCount: 1,
			lastAddedAt: Date.now(),
		});
	}
}

function pollingDequeue(note: Pick<Misskey.entities.Note, 'id' | 'createdAt'>) {
	const data = pollingQueue.get(note.id);
	if (data == null) return;

	if (data.referenceCount === 1) {
		pollingQueue.delete(note.id);
	} else {
		pollingQueue.set(note.id, {
			...data,
			referenceCount: data.referenceCount - 1,
		});
	}
}

const CAPTURE_MAX = 30;
const MIN_POLLING_INTERVAL = 1000 * 10;
const POLLING_INTERVAL =
	prefer.s.pollingInterval === 1 ? MIN_POLLING_INTERVAL * 1.5 * 1.5 :
	prefer.s.pollingInterval === 2 ? MIN_POLLING_INTERVAL * 1.5 :
	prefer.s.pollingInterval === 3 ? MIN_POLLING_INTERVAL :
	MIN_POLLING_INTERVAL;

// documentが非表示の間はポーリングを停止する
createVisibilityAwareInterval(() => {
	const ids = [...pollingQueue.entries()]
		.filter(([k, v]) => Date.now() - v.lastAddedAt < 1000 * 60 * 5) // 追加されてから一定時間経過したものは省く
		.map(([k, v]) => k)
		.sort((a, b) => (a > b ? -1 : 1)) // 新しいものを優先するためにIDで降順ソート
		.slice(0, CAPTURE_MAX);

	if (ids.length === 0) return;

	// まとめてリクエストするのではなく、個別にHTTPリクエスト投げてCDNにキャッシュさせた方がサーバーの負荷低減には良いかもしれない？
	misskeyApi('notes/show-partial-bulk', {
		noteIds: ids,
	}).then((items) => {
		for (const item of items) {
			fetchEvent.emit(item.id, {
				reactions: item.reactions,
				reactionEmojis: item.reactionEmojis,
			});
		}
	});
}, POLLING_INTERVAL);

function pollingSubscribe(props: {
	note: Pick<Misskey.entities.Note, 'id' | 'createdAt'>;
	$note: ReactiveNoteData;
}) {
	const { note, $note } = props;

	function onFetched(data: Pick<Misskey.entities.Note, 'reactions' | 'reactionEmojis'>): void {
		if ($note.extendedReactions) {
			noteEvents.emit(`extendedUpdated:${note.id}`);
			return;
		}
		$note.reactions = data.reactions;
		$note.reactionCount = Object.values(data.reactions).reduce((a, b) => a + b, 0);
		$note.reactionEmojis = data.reactionEmojis;
	}

	pollingEnqueue(note);
	fetchEvent.on(note.id, onFetched);

	onUnmounted(() => {
		pollingDequeue(note);
		fetchEvent.off(note.id, onFetched);
	});
}

function realtimeSubscribe(props: {
	note: Pick<Misskey.entities.Note, 'id' | 'createdAt'>;
}): void {
	const note = props.note;
	const connection = useStream();

	function onStreamNoteUpdated(noteData: NoteUpdatedEvent): void {
		const { type, id, body } = noteData;

		if (id !== note.id) return;

		switch (type) {
			case 'extendedReactionUpdated': {
				noteEvents.emit(`extendedUpdated:${id}`);
				break;
			}

			case 'reacted': {
				noteEvents.emit(`reacted:${id}`, {
					userId: body.userId,
					reaction: body.reaction,
					emoji: body.emoji,
				});
				break;
			}

			case 'unreacted': {
				noteEvents.emit(`unreacted:${id}`, {
					userId: body.userId,
					reaction: body.reaction,
				});
				break;
			}

			case 'pollVoted': {
				noteEvents.emit(`pollVoted:${id}`, {
					userId: body.userId,
					choice: body.choice,
				});
				break;
			}

			case 'deleted': {
				globalEvents.emit('noteDeleted', id);
				break;
			}
		}
	}

	function capture(withHandler = false): void {
		connection.send('sr', { id: note.id });
		if (withHandler) connection.on('noteUpdated', onStreamNoteUpdated);
	}

	function decapture(withHandler = false): void {
		connection.send('un', { id: note.id });
		if (withHandler) connection.off('noteUpdated', onStreamNoteUpdated);
	}

	function onStreamConnected() {
		capture(false);
		noteEvents.emit(`extendedUpdated:${note.id}`);
	}

	capture(true);
	connection.on('_connected_', onStreamConnected);

	onUnmounted(() => {
		decapture(true);
		connection.off('_connected_', onStreamConnected);
	});
}

export type ReactiveNoteData = {
	reactions: Misskey.entities.Note['reactions'];
	reactionCount: Misskey.entities.Note['reactionCount'];
	reactionEmojis: Misskey.entities.Note['reactionEmojis'];
	myReaction: Misskey.entities.Note['myReaction'];
	myReactions: string[];
	extendedReactions: boolean;
	reactionVersion: number;
	pollChoices: NonNullable<Misskey.entities.Note['poll']>['choices'];
};

const noReaction = Symbol();

export function useNoteCapture(props: {
	note: Misskey.entities.Note;
	parentNote: Misskey.entities.Note | null;
	mock?: boolean;
}): {
	$note: Reactive<ReactiveNoteData>;
	subscribe: () => void;
} {
	const { note, parentNote, mock } = props;

	const $note = reactive<ReactiveNoteData>({
		reactions: Object.entries(note.reactions).reduce((acc, [name, count]) => {
			// Normalize reactions
			const normalizedName = name.replace(/^:(\w+):$/, ':$1@.:');
			if (acc[normalizedName] == null) {
				acc[normalizedName] = count;
			} else {
				acc[normalizedName] += count;
			}
			return acc;
		}, {} as Misskey.entities.Note['reactions']),
		reactionCount: note.reactionCount,
		reactionEmojis: note.reactionEmojis,
		myReaction: note.myReaction,
		myReactions: note.myReaction ? [note.myReaction] : [],
		extendedReactions: !mock && supportsExtendedReactions(note),
		reactionVersion: 0,
		pollChoices: note.poll?.choices ?? [],
	});

	let disposed = false;
	let refreshing = false;
	let refreshAgain = false;
	let stopSharedRefresh: (() => void) | undefined;
	let sharedPush = false;
	let subscribed = false;
	let realtime = false;
	let receivedComplete = false;
	let lastReactionState = '';
	let retryTimer: number | undefined;
	let retryAttempt = 0;

	function retryExtended(): void {
		if (disposed || retryTimer !== undefined) return;
		retryTimer = window.setTimeout(() => {
			retryTimer = undefined;
			void refreshExtended();
		}, Math.min(60000, 1000 * 2 ** Math.min(retryAttempt++, 6)));
	}

	async function refreshExtended(): Promise<void> {
		if (!$note.extendedReactions || disposed || (stopSharedRefresh && window.document.hidden)) return;
		if (refreshing) { refreshAgain = true; return; }
		window.clearTimeout(retryTimer); retryTimer = undefined;
		refreshing = true;
		try {
			const state = await fetchExtendedReactions(note.id);
			if (state && !disposed) {
				const push = state.push === true && realtime;
				if (state.shared && (!stopSharedRefresh || sharedPush !== push)) {
					stopSharedRefresh?.();
					sharedPush = push;
					stopSharedRefresh = watchSharedReactions(() => { void refreshExtended(); }, push);
				}
				if (state.complete === false && receivedComplete) {
					// Keep the peer counts, but apply our own successful changes during an outage.
					const counts = { ...$note.reactions };
					for (const reaction of $note.myReactions) counts[reaction] = Math.max(0, (counts[reaction] ?? 0) - 1);
					for (const reaction of state.myReactions) counts[reaction] = (counts[reaction] ?? 0) + 1;
					$note.reactions = Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));
					$note.reactionEmojis = { ...$note.reactionEmojis, ...state.reactionEmojis };
				} else {
					if (state.complete !== false) receivedComplete = true;
					$note.reactions = state.reactions;
					$note.reactionEmojis = state.reactionEmojis;
				}
				$note.reactionCount = Object.values($note.reactions).reduce((sum, count) => sum + count, 0);
				$note.myReactions = state.myReactions;
				$note.myReaction = state.myReaction;
				const signature = JSON.stringify([$note.reactions, $note.reactionEmojis, $note.myReactions, state.revision]);
				if (signature !== lastReactionState) { $note.reactionVersion++; lastReactionState = signature; }
				if (state.complete === false) retryExtended(); else retryAttempt = 0;
			}
		} catch {
			// Keep the previous state on transient network failures.
			retryExtended();
		} finally {
			refreshing = false;
			if (refreshAgain) { refreshAgain = false; void refreshExtended(); }
		}
	}

	noteEvents.on(`extendedUpdated:${note.id}`, refreshExtended);
	void refreshExtended();

	noteEvents.on(`reacted:${note.id}`, onReacted);
	noteEvents.on(`unreacted:${note.id}`, onUnreacted);
	noteEvents.on(`pollVoted:${note.id}`, onPollVoted);

	// 操作がダブっていないかどうかを簡易的に記録するためのMap
	const reactionUserMap = new Map<Misskey.entities.User['id'], string | typeof noReaction>();
	let latestPollVotedKey: string | null = null;

	function onReacted(ctx: { userId: Misskey.entities.User['id']; reaction: string; emoji?: { name: string; url: string; } | null; }): void {
		if ($note.extendedReactions) {
			if ($i && ctx.userId === $i.id) $note.myReaction = ctx.reaction;
			void refreshExtended();
			return;
		}
		let normalizedName = ctx.reaction.replace(/^:(\w+):$/, ':$1@.:');
		normalizedName = normalizedName.match('\u200d') ? normalizedName : normalizedName.replace(/\ufe0f/g, '');
		if (reactionUserMap.has(ctx.userId) && reactionUserMap.get(ctx.userId) === normalizedName) return;
		reactionUserMap.set(ctx.userId, normalizedName);

		if (ctx.emoji && !(ctx.emoji.name in $note.reactionEmojis)) {
			$note.reactionEmojis[ctx.emoji.name] = ctx.emoji.url;
		}

		const currentCount = $note.reactions[normalizedName] || 0;

		$note.reactions[normalizedName] = currentCount + 1;
		$note.reactionCount += 1;

		if ($i && (ctx.userId === $i.id)) {
			$note.myReaction = normalizedName;
		}
	}

	function onUnreacted(ctx: { userId: Misskey.entities.User['id']; reaction: string; emoji?: { name: string; url: string; } | null; }): void {
		if ($note.extendedReactions) {
			void refreshExtended();
			return;
		}
		let normalizedName = ctx.reaction.replace(/^:(\w+):$/, ':$1@.:');
		normalizedName = normalizedName.match('\u200d') ? normalizedName : normalizedName.replace(/\ufe0f/g, '');

		// 確実に一度リアクションされて取り消されている場合のみ処理をとめる（APIで初回読み込み→Streamでアップデート等の場合、reactionUserMapに情報がないため）
		if (reactionUserMap.has(ctx.userId) && reactionUserMap.get(ctx.userId) === noReaction) return;
		reactionUserMap.set(ctx.userId, noReaction);

		const currentCount = $note.reactions[normalizedName] || 0;

		$note.reactions[normalizedName] = Math.max(0, currentCount - 1);
		$note.reactionCount = Math.max(0, $note.reactionCount - 1);
		if ($note.reactions[normalizedName] === 0) delete $note.reactions[normalizedName];

		if ($i && (ctx.userId === $i.id)) {
			$note.myReaction = null;
		}
	}

	function onPollVoted(ctx: { userId: Misskey.entities.User['id']; choice: number; }): void {
		const newPollVotedKey = `${ctx.userId}:${ctx.choice}`;
		if (newPollVotedKey === latestPollVotedKey) return;
		latestPollVotedKey = newPollVotedKey;

		const choices = [...$note.pollChoices];
		choices[ctx.choice] = {
			...choices[ctx.choice],
			votes: choices[ctx.choice].votes + 1,
			...($i && (ctx.userId === $i.id) ? {
				isVoted: true,
			} : {}),
		};

		$note.pollChoices = choices;
	}

	function subscribe() {
		if (mock || subscribed) {
			// モックモードでは購読しない
			return;
		}
		subscribed = true;

		if ($i && store.s.realtimeMode) {
			realtime = true;
			realtimeSubscribe({
				note,
			});
		} else {
			pollingSubscribe({
				note,
				$note,
			});
		}
	}

	onUnmounted(() => {
		disposed = true;
		window.clearTimeout(retryTimer);
		stopSharedRefresh?.();
		noteEvents.off(`extendedUpdated:${note.id}`, refreshExtended);
		noteEvents.off(`reacted:${note.id}`, onReacted);
		noteEvents.off(`unreacted:${note.id}`, onUnreacted);
		noteEvents.off(`pollVoted:${note.id}`, onPollVoted);
	});

	// Shared reactions can change on the peer even for old posts. Keep the normal
	// authenticated note subscription so their updates need no periodic peer reads.
	if (note.gridspaceReactions && $i && store.s.realtimeMode) subscribe();

	// 投稿からある程度経過している(=タイムラインを遡って表示した)ノートは、イベントが発生する可能性が低いためそもそも購読しない
	// ただし「リノートされたばかりの過去のノート」(= parentNoteが存在し、かつparentNoteの投稿日時が最近)はイベント発生が考えられるため購読する
	// TODO: デバイスとサーバーの時計がズレていると不具合の元になるため、ズレを検知して警告を表示するなどのケアが必要かもしれない
	if (parentNote == null) {
		if ((Date.now() - new Date(note.createdAt).getTime()) > 1000 * 60 * 5) { // 5min
			// リノートで表示されているノートでもないし、投稿からある程度経過しているので自動で購読しない
			return {
				$note,
				subscribe: () => {
					subscribe();
				},
			};
		}
	} else {
		if ((Date.now() - new Date(parentNote.createdAt).getTime()) > 1000 * 60 * 5) { // 5min
			// リノートで表示されているノートだが、リノートされてからある程度経過しているので自動で購読しない
			return {
				$note,
				subscribe: () => {
					subscribe();
				},
			};
		}
	}

	subscribe();

	return {
		$note,
		subscribe: () => {
			// すでに購読しているので何もしない
		},
	};
}
