<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<button
	ref="buttonEl"
	v-ripple="canToggle"
	:data-reaction="reaction"
	:aria-pressed="extendedReactions ? (myReactions?.includes(reaction) ?? false) : myReaction === reaction"
	class="_button"
	:class="[$style.root, { [$style.reacted]: extendedReactions ? myReactions?.includes(reaction) : myReaction == reaction, [$style.canToggle]: canToggle, [$style.small]: prefer.s.reactionsDisplaySize === 'small', [$style.large]: prefer.s.reactionsDisplaySize === 'large' }]"
	@click="toggleReaction()"
	@contextmenu.prevent.stop="menu"
>
	<MkReactionIcon style="pointer-events: none;" :class="prefer.s.limitWidthOfReaction ? $style.limitWidth : ''" :reaction="reaction" :emojiUrl="reactionEmojis[emojiName]"/>
	<span :class="$style.count">
	</span>
	<div v-for="u in users" :key="u.id" :class="$style.avatars" style="height: 42px; width: auto">
		<MkAvatar :class="$style.avatar" :user="u"/>
	</div>
	<div v-for="u in remoteUsers" :key="u.uri" :class="$style.avatars" style="height: 42px; width: auto">
		<img :class="[$style.avatar, $style.remoteAvatar]" :src="actorAvatar(u)" :alt="u.name || u.username" :title="`@${u.username}@${u.host}`">
	</div>
</button>
</template>

<script lang="ts" setup>
import { computed, inject, onActivated, onBeforeUnmount, onDeactivated, onMounted, useTemplateRef, watch, ref } from 'vue';
import * as Misskey from 'misskey-js';
import { getUnicodeEmojiOrNull } from '@@/js/emojilist.js';
import { getEmojiNameFromReaction, isLocalCustomEmojiReaction } from '@@/js/emoji-name.js';
import MkCustomEmojiDetailedDialog from './MkCustomEmojiDetailedDialog.vue';
import type { MenuItem } from '@/types/menu';
import XDetails from '@/components/MkReactionsViewer.details.vue';
import MkReactionIcon from '@/components/MkReactionIcon.vue';
import * as os from '@/os.js';
import { misskeyApi, misskeyApiGet } from '@/utility/misskey-api.js';
import { useTooltip } from '@/composables/use-tooltip.js';
import { $i } from '@/i.js';
import MkReactionEffect from '@/components/MkReactionEffect.vue';
import { i18n } from '@/i18n.js';
import * as sound from '@/utility/sound.js';
// import { checkReactionPermissions } from '@/utility/check-reaction-permissions.js';
import { customEmojisMap } from '@/custom-emojis.js';
import { prefer } from '@/preferences.js';
import { DI } from '@/di.js';
import { store } from '@/store';
import { noteEvents } from '@/composables/use-note-capture.js';
import { mute as muteEmoji, unmute as unmuteEmoji, checkMuted as isEmojiMuted } from '@/utility/emoji-mute.js';
import { addToEmojiPalette } from '@/utility/emoji-palette.js';
import { addExtendedReaction, deleteExtendedReaction, fetchReactionUsers } from '@/utility/extended-reactions.js';
import { haptic } from '@/utility/haptic.js';
import type { ReactionActor, ReactionTransport } from '@/utility/reaction-transport.js';
import { getStaticImageUrl } from '@/utility/media-proxy.js';

const props = defineProps<{
	noteId: Misskey.entities.Note['id'];
	reaction: string;
	reactionEmojis: Misskey.entities.Note['reactionEmojis'];
	myReaction: Misskey.entities.Note['myReaction'];
	myReactions?: string[];
	extendedReactions?: boolean;
	reactionVersion?: string | number;
	count: number;
	isInitial: boolean;
	transport?: ReactionTransport;
}>();

const mock = inject(DI.mock, false);

const emit = defineEmits<{
	(ev: 'reactionToggled', emoji: string, newCount: number): void;
}>();

const buttonEl = useTemplateRef('buttonEl');

const emojiName = computed(() => getEmojiNameFromReaction(props.reaction));

const isLocalCustomEmoji = computed(() => isLocalCustomEmojiReaction(props.reaction));

const canToggle = computed(() => {
	if (props.transport) return props.transport.canToggle();
	const emoji = isLocalCustomEmoji.value ? customEmojisMap.get(emojiName.value) : getUnicodeEmojiOrNull(props.reaction);

	// TODO
	//return $i != null && emoji != null && checkReactionPermissions($i, props.note, emoji);
	return $i != null && emoji != null;
});

const users = ref<Misskey.entities.UserLite[]>([]);
const remoteUsers = ref<ReactionActor[]>([]);
const actorAvatar = (actor: ReactionActor) => prefer.s.disableShowingAnimatedImages || prefer.s.dataSaver.avatar ? getStaticImageUrl(actor.avatarUrl) : actor.avatarUrl;

async function toggleReaction() {
	if (!canToggle.value) return;
	if (props.transport) { await props.transport.toggle(props.reaction); return; }
	if ($i == null) return;

	if (props.extendedReactions && !mock) {
		if (props.myReactions?.includes(props.reaction)) {
			const { canceled } = await os.confirm({ type: 'warning', text: i18n.ts.cancelReactionConfirm });
			if (!canceled) await deleteExtendedReaction(props.noteId, props.reaction).catch(error => os.alert({ type: 'error', text: error.message }));
		} else {
			if (prefer.s.confirmOnReact) {
				const { canceled } = await os.confirm({ type: 'question', text: i18n.tsx.reactAreYouSure({ emoji: props.reaction.replace('@.', '') }) });
				if (canceled) return;
			}
			await addExtendedReaction(props.noteId, props.reaction).catch(error => os.alert({ type: 'error', text: error.message }));
		}
		return;
	}
	const me = $i;

	const oldReaction = props.myReaction;
	if (oldReaction) {
		const confirm = await os.confirm({
			type: 'warning',
			text: oldReaction !== props.reaction ? i18n.ts.changeReactionConfirm : i18n.ts.cancelReactionConfirm,
		});
		if (confirm.canceled) return;

		if (oldReaction !== props.reaction) {
			sound.playMisskeySfx('reaction');
			haptic();
		}

		if (mock) {
			emit('reactionToggled', props.reaction, (props.count - 1));
			return;
		}

		misskeyApi('notes/reactions/delete', {
			noteId: props.noteId,
		}).then(() => {
			noteEvents.emit(`unreacted:${props.noteId}`, {
				userId: me.id,
				reaction: oldReaction,
			});
			if (oldReaction !== props.reaction) {
				misskeyApi('notes/reactions/create', {
					noteId: props.noteId,
					reaction: props.reaction,
				}).then(() => {
					const emoji = customEmojisMap.get(emojiName.value);
					if (emoji == null && getUnicodeEmojiOrNull(props.reaction) == null) {
						return;
					}
					noteEvents.emit(`reacted:${props.noteId}`, {
						userId: me.id,
						reaction: props.reaction,
						emoji: emoji,
					});
				});
			}
		});
	} else {
		if (prefer.s.confirmOnReact) {
			const confirm = await os.confirm({
				type: 'question',
				text: i18n.tsx.reactAreYouSure({ emoji: props.reaction.replace('@.', '') }),
			});

			if (confirm.canceled) return;
		}

		sound.playMisskeySfx('reaction');
		haptic();

		if (mock) {
			emit('reactionToggled', props.reaction, (props.count + 1));
			return;
		}

		misskeyApi('notes/reactions/create', {
			noteId: props.noteId,
			reaction: props.reaction,
		}).then(() => {
			const emoji = customEmojisMap.get(emojiName.value);
			if (emoji == null && getUnicodeEmojiOrNull(props.reaction) == null) {
				return;
			}

			noteEvents.emit(`reacted:${props.noteId}`, {
				userId: me.id,
				reaction: props.reaction,
				emoji: emoji,
			});
		});
		// TODO: 上位コンポーネントでやる
		//if (props.note.text && props.note.text.length > 100 && (Date.now() - new Date(props.note.createdAt).getTime() < 1000 * 3)) {
		//	claimAchievement('reactWithoutRead');
		//}
	}
}

async function menu(ev: PointerEvent) {
	let menuItems: MenuItem[] = [];
	if (props.transport) menuItems.push({ text: i18n.ts.more, icon: 'ti ti-users', action: () => props.transport?.showUsers(props.reaction) });

	if (isLocalCustomEmoji.value) {
		menuItems.push({
			text: i18n.ts.info,
			icon: 'ti ti-info-circle',
			action: async () => {
				const { dispose } = os.popup(MkCustomEmojiDetailedDialog, {
					emoji: await misskeyApiGet('emoji', {
						name: emojiName.value,
					}),
				}, {
					closed: () => dispose(),
				});
			},
		});
	}

	if (isEmojiMuted(props.reaction).value) {
		menuItems.push({
			text: i18n.ts.emojiUnmute,
			icon: 'ti ti-mood-smile',
			action: () => {
				os.confirm({
					type: 'question',
					title: i18n.tsx.unmuteX({ x: isLocalCustomEmoji.value ? `:${emojiName.value}:` : props.reaction }),
				}).then(({ canceled }) => {
					if (canceled) return;
					unmuteEmoji(props.reaction);
				});
			},
		});
	} else {
		menuItems.push({
			text: i18n.ts.emojiMute,
			icon: 'ti ti-mood-off',
			action: () => {
				os.confirm({
					type: 'question',
					title: i18n.tsx.muteX({ x: isLocalCustomEmoji.value ? `:${emojiName.value}:` : props.reaction }),
				}).then(({ canceled }) => {
					if (canceled) return;
					muteEmoji(props.reaction);
				});
			},
		});
	}

	if (canToggle.value) {
		menuItems.push({
			text: i18n.ts.addToEmojiPalette,
			icon: 'ti ti-palette',
			action: () => {
				addToEmojiPalette(isLocalCustomEmoji.value ? `:${emojiName.value}:` : props.reaction);
			},
		});
	}

	os.popupMenu(menuItems, ev.currentTarget ?? ev.target);
}

function anime() {
	if (window.document.hidden || !prefer.s.animation || buttonEl.value == null) return;

	const rect = buttonEl.value.getBoundingClientRect();
	const x = rect.left + 16;
	const y = rect.top + (buttonEl.value.offsetHeight / 2);
	const { dispose } = os.popup(MkReactionEffect, { reaction: props.reaction, x, y }, {
		end: () => dispose(),
	});
}

function fetchUsers() {
	if (props.transport) return Promise.resolve([]);
	return fetchReactionUsers(props.noteId, props.reaction, props.extendedReactions ?? false, props.count, props.reactionVersion);
}

let usersRequest = 0;
let active = true;
let disposeRemoteDetails: (() => void) | undefined;

async function refreshUsers() {
	disposeRemoteDetails?.(); disposeRemoteDetails = undefined;
	const request = ++usersRequest;
	try {
		if (props.transport) {
			const actors = active && !window.document.hidden ? props.transport.previews(props.reaction) : [];
			remoteUsers.value = [...new Map(actors.map(actor => [actor.uri, actor])).values()].slice(0, 10);
			return;
		}
		const reactions = await fetchUsers();
		if (request === usersRequest) users.value = [...new Map(reactions.map(x => [x.user.id, x.user])).values()];
	} catch { if (props.transport) remoteUsers.value = []; }
}

function visibility() { if (props.transport) { usersRequest++; remoteUsers.value = []; disposeRemoteDetails?.(); if (!window.document.hidden) void refreshUsers(); } }

window.document.addEventListener('visibilitychange', visibility);
onBeforeUnmount(() => { active = false; usersRequest++; window.document.removeEventListener('visibilitychange', visibility); remoteUsers.value = []; disposeRemoteDetails?.(); });
onDeactivated(() => { active = false; if (props.transport) { usersRequest++; remoteUsers.value = []; disposeRemoteDetails?.(); } });
onActivated(() => { active = true; if (props.transport) void refreshUsers(); });
watch([() => props.noteId, () => props.transport], () => { usersRequest++; remoteUsers.value = []; void refreshUsers(); });

watch([() => props.count, () => props.reactionVersion], ([newCount], [oldCount]) => {
	void refreshUsers();
	if (oldCount < newCount) anime();
});

onMounted(() => {
	void refreshUsers();
	if (!props.isInitial) anime();
});

if (!mock) {
	useTooltip(buttonEl, async (showing) => {
		if (buttonEl.value == null) return;
		if (props.transport) {
			if (!active || window.document.hidden) return;
			const current = usersRequest;
			const actors = await props.transport.users(props.reaction).catch(() => null);
			if (!actors || !active || current !== usersRequest || window.document.hidden || !showing.value) return;
			disposeRemoteDetails?.();
			const { dispose } = os.popup(XDetails, { showing, reaction: props.reaction, emojiUrl: props.reactionEmojis[emojiName.value], users: [], actors, count: props.count, anchorElement: buttonEl.value }, { closed: () => dispose() });
			disposeRemoteDetails = dispose;
			return;
		}

		const reactions = await fetchUsers().catch(() => null);
		if (!reactions) return;

		const users = [...new Map(reactions.map(x => [x.user.id, x.user])).values()];

		const { dispose } = os.popup(XDetails, {
			showing,
			reaction: props.reaction,
			emojiUrl: props.reactionEmojis[emojiName.value],
			users,
			count: props.count,
			anchorElement: buttonEl.value,
		}, {
			closed: () => dispose(),
		});
	}, 100);
}
</script>

<style lang="scss" module>
.remoteAvatar { border-radius: 100%; object-fit: cover; }
.avatars {
	display: flex;
	align-items: center;
}

.avatar {
	height: 14px;
	width: 14px;
	margin-left: 2px;
}

.root {
	display: inline-flex;
	height: 42px;
	padding: 0 6px;
	font-size: 1.5em;
	border-radius: 6px;
	align-items: center;
	justify-content: center;

	&.canToggle {
		background: var(--MI_THEME-buttonBg);

		&:hover {
			background: rgba(0, 0, 0, 0.1);
		}
	}

	&:not(.canToggle) {
		cursor: default;
	}

	&.small {
		height: 32px;
		font-size: 1em;
		border-radius: 4px;

		> .count {
			font-size: 0.9em;
			line-height: 32px;
		}
	}

	&.large {
		height: 52px;
		font-size: 2em;
		border-radius: 8px;

		> .count {
			font-size: 0.6em;
			line-height: 52px;
		}
	}

	&.reacted, &.reacted:hover {
		background: var(--MI_THEME-accentedBg);
		color: var(--MI_THEME-accent);
		box-shadow: 0 0 0 1px var(--MI_THEME-accent) inset;

		> .count {
			color: var(--MI_THEME-accent);
		}

		> .icon {
			filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.5));
		}
	}
}

.limitWidth {
	max-width: 70px;
	object-fit: contain;
}

.count {
	font-size: 0.7em;
	line-height: 42px;
	margin: 0 0 0 4px;
}
</style>
