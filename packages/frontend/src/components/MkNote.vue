<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div
	v-if="!hardMuted && !hideByPlugin && muted === false"
	ref="rootEl"
	v-hotkey="keymap"
	:class="[$style.root, { [$style.skipRender]: prefer.s.skipNoteRender }]"
	tabindex="0"
>
	<MkNoteSub v-if="appearNote.replyId && !renoteCollapsed" :note="appearNote?.reply ?? null" :class="$style.replyTo"/>
	<div v-if="pinned" :class="$style.tip"><i class="ti ti-pin"></i> {{ i18n.ts.pinnedNote }}</div>
	<div v-if="isRenote" :class="$style.renote">
		<MkNoteChannel v-if="note.channel" :channel="note.channel" display="bar" compact/>
		<MkAvatar :class="$style.renoteAvatar" :user="note.user" link preview/>
		<i class="ti ti-repeat" style="margin-right: 4px;"></i>
		<I18n :src="i18n.ts.renotedBy" tag="span" :class="$style.renoteText">
			<template #user>
				<MkA v-user-preview="note.userId" :class="$style.renoteUserName" :to="userPage(note.user)">
					<MkUserName :user="note.user"/>
				</MkA>
			</template>
		</I18n>
		<div :class="$style.renoteInfo">
			<button ref="renoteTime" :class="$style.renoteTime" class="_button" @mousedown.prevent="showRenoteMenu()">
				<i class="ti ti-dots" :class="$style.renoteMenu"></i>
				<MkTime :time="note.createdAt"/>
			</button>
			<span v-if="note.visibility !== 'public'" style="margin-left: 0.5em;" :title="i18n.ts._visibility[note.visibility]">
				<i v-if="note.visibility === 'home'" class="ti ti-home"></i>
				<i v-else-if="note.visibility === 'followers'" class="ti ti-lock"></i>
				<i v-else-if="note.visibility === 'specified'" ref="specified" class="ti ti-mail"></i>
			</span>
			<span v-if="note.localOnly" style="margin-left: 0.5em;" :title="i18n.ts._visibility['disableFederation']"><i class="ti ti-rocket-off"></i></span>
			<span v-if="note.channel" style="margin-left: 0.5em;" :title="note.channel.name"><i class="ti ti-device-tv"></i></span>
		</div>
	</div>
	<div v-if="isRenote && note.renote == null" :class="$style.deleted">
		{{ i18n.ts.deletedNote }}
	</div>
	<div v-else-if="renoteCollapsed" :class="$style.collapsedRenoteTarget">
		<MkAvatar :class="$style.collapsedRenoteTargetAvatar" :user="appearNote.user" link preview/>
		<Mfm :text="getNoteSummary(appearNote)" :plain="true" :nowrap="true" :author="appearNote.user" :nyaize="'respect'" :class="$style.collapsedRenoteTargetText" @click="renoteCollapsed = false"/>
	</div>
	<MkNoteArticle v-else :user="appearNote.user" :channel="appearNote.channel" :showChannelLink="!inChannel" :avatarLink="!mock" :avatarPreview="!mock" :stickyAvatar="prefer.s.useStickyIcons" :compactTop="isRenote || pinned" :footerOnHover="prefer.s.showNoteActionsOnlyHover" @contextmenu.stop="onContextmenu">
		<template #header>
			<MkNoteHeader :note="appearNote" :mini="true"/>
			<MkInstanceTicker v-if="showTicker" :host="appearNote.user.host" :instance="appearNote.user.instance"/>
		</template>
		<p v-if="appearNote.cw != null" :class="$style.cw">
			<Mfm
				v-if="appearNote.cw != ''"
				:text="appearNote.cw"
				:author="appearNote.user"
				:nyaize="'respect'"
				:enableEmojiMenu="true"
				:enableEmojiMenuReaction="true"
			/>
			<MkCwButton v-model="showContent" :text="appearNote.text" :renote="appearNote.renote" :files="appearNote.files" :poll="appearNote.poll" style="margin: 4px 0;"/>
		</p>
		<div v-show="appearNote.cw == null || showContent" :class="[{ [$style.contentCollapsed]: collapsed }]">
			<div :class="$style.text">
				<span v-if="appearNote.isHidden" style="opacity: 0.5">({{ i18n.ts.private }})</span>
				<span v-else-if="isUnavailableGridspaceNote(appearNote)"><i class="ti ti-lock"></i> {{ i18n.ts._gridspace.unavailableNote }}</span>
				<MkA v-if="appearNote.replyId" :class="$style.replyIcon" :to="`/notes/${appearNote.replyId}`"><i class="ti ti-arrow-back-up"></i></MkA>
				<MkAutoTranslatedNote v-slot="{ text, translated }" :note="appearNote" :active="!mock && (appearNote.cw == null || showContent)">
					<Mfm
						v-if="appearNote.text"
						:parsedNodes="translated ? undefined : parsed"
						:text="text ?? ''"
						:author="appearNote.user"
						:nyaize="'respect'"
						:emojiUrls="appearNote.emojis"
						:enableEmojiMenu="true"
						:enableEmojiMenuReaction="true"
						class="_selectable"
					/>
				</MkAutoTranslatedNote>
				<div v-if="translating || translation" :class="$style.translation">
					<MkLoading v-if="translating" mini/>
					<div v-else-if="translation">
						<b>{{ i18n.tsx.translatedFrom({ x: translation.sourceLang }) }}: </b>
						<Mfm :text="translation.text" :author="appearNote.user" :nyaize="'respect'" :emojiUrls="appearNote.emojis" class="_selectable"/>
					</div>
				</div>
			</div>
			<div v-if="appearNote.files && appearNote.files.length > 0" style="margin-top: 8px;">
				<MkMediaList ref="galleryEl" :mediaList="appearNote.files" :user="appearNote.user"/>
			</div>
			<MkPoll
				v-if="appearNote.poll"
				:noteId="appearNote.id"
				:multiple="appearNote.poll.multiple"
				:expiresAt="appearNote.poll.expiresAt"
				:choices="$appearNote.pollChoices"
				:author="appearNote.user"
				:emojiUrls="appearNote.emojis"
				:class="$style.poll"
			/>
			<div v-if="isEnabledUrlPreview">
				<MkUrlPreview v-for="url in urls" :key="url" :url="url" :compact="true" :detail="false" :class="$style.urlPreview"/>
			</div>
			<div v-if="appearNote.renoteId" :class="$style.quote"><MkNoteSimple :note="appearNote?.renote ?? null" :class="$style.quoteNote"/></div>
			<button v-if="isLong && collapsed" :class="$style.collapsed" class="_button" @click="collapsed = false">
				<span :class="$style.collapsedLabel">{{ i18n.ts.showMore }}</span>
			</button>
			<button v-else-if="isLong && !collapsed" :class="$style.showLess" class="_button" @click="collapsed = true">
				<span :class="$style.showLessLabel">{{ i18n.ts.showLess }}</span>
			</button>
		</div>
		<template #reactions>
			<MkReactionsViewer
				v-if="appearNote.reactionAcceptance !== 'likeOnly'"
				style="margin-top: 6px;"
				:reactions="$appearNote.reactions"
				:reactionEmojis="$appearNote.reactionEmojis"
				:myReaction="$appearNote.myReaction"
				:myReactions="$appearNote.myReactions"
				:extendedReactions="$appearNote.extendedReactions"
				:reactionVersion="$appearNote.reactionVersions ?? $appearNote.reactionVersion"
				:noteId="appearNote.id"
				:maxNumber="16"
				@mockUpdateMyReaction="emitUpdReaction"
			>
				<template #more>
					<MkA :to="`/notes/${appearNote.id}/reactions`" :class="[$style.reactionOmitted]">{{ i18n.ts.more }}</MkA>
				</template>
			</MkReactionsViewer>
		</template>
		<template #footer="{ buttonClass }">
			<button :class="buttonClass" class="_button" @click="reply()">
				<i class="ti ti-arrow-back-up"></i>
				<p v-if="appearNote.repliesCount > 0" :class="$style.footerButtonCount">{{ number(appearNote.repliesCount) }}</p>
			</button>
			<button
				v-if="canRenote"
				ref="renoteButton"
				:class="buttonClass"
				class="_button"
				@mousedown.prevent="renote()"
			>
				<i class="ti ti-repeat"></i>
				<p v-if="appearNote.renoteCount > 0" :class="$style.footerButtonCount">{{ number(appearNote.renoteCount) }}</p>
			</button>
			<button v-else :class="buttonClass" class="_button" disabled>
				<i class="ti ti-ban"></i>
			</button>
			<button ref="reactButton" :class="buttonClass" class="_button" @click="handleToggleReact()">
				<i v-if="appearNote.reactionAcceptance === 'likeOnly' && $appearNote.myReaction != null" class="ti ti-heart-filled" style="color: var(--MI_THEME-love);"></i>
				<i v-else-if="!$appearNote.extendedReactions && $appearNote.myReaction != null" class="ti ti-minus" style="color: var(--MI_THEME-accent);"></i>
				<i v-else-if="appearNote.reactionAcceptance === 'likeOnly'" class="ti ti-heart"></i>
				<i v-else class="ti ti-plus"></i>
				<p v-if="(appearNote.reactionAcceptance === 'likeOnly' || prefer.s.showReactionsCount) && $appearNote.reactionCount > 0" :class="$style.footerButtonCount">{{ number($appearNote.reactionCount) }}</p>
			</button>
			<button v-if="prefer.s.showClipButtonInNoteFooter" ref="clipButton" :class="buttonClass" class="_button" @mousedown.prevent="clip()">
				<i class="ti ti-paperclip"></i>
			</button>
			<button ref="menuButton" :class="buttonClass" class="_button" @mousedown.prevent="showMenu()">
				<i class="ti ti-dots"></i>
			</button>
		</template>
	</MkNoteArticle>
</div>
<div v-else-if="!hardMuted && !hideByPlugin" :class="$style.muted" @click="muted = false">
	<I18n v-if="muted === 'sensitiveMute'" :src="i18n.ts.userSaysSomethingSensitive" tag="small">
		<template #name>
			<MkA v-user-preview="appearNote.userId" :to="userPage(appearNote.user)">
				<MkUserName :user="appearNote.user"/>
			</MkA>
		</template>
	</I18n>
	<I18n v-else-if="showSoftWordMutedWord !== true" :src="i18n.ts.userSaysSomething" tag="small">
		<template #name>
			<MkA v-user-preview="appearNote.userId" :to="userPage(appearNote.user)">
				<MkUserName :user="appearNote.user"/>
			</MkA>
		</template>
	</I18n>
	<I18n v-else :src="i18n.ts.userSaysSomethingAbout" tag="small">
		<template #name>
			<MkA v-user-preview="appearNote.userId" :to="userPage(appearNote.user)">
				<MkUserName :user="appearNote.user"/>
			</MkA>
		</template>
		<template #word>
			{{ Array.isArray(muted) ? muted.map(words => Array.isArray(words) ? words.join() : words).slice(0, 3).join(' ') : muted }}
		</template>
	</I18n>
</div>
<div v-else>
	<!--
		MkDateSeparatedList uses TransitionGroup which requires single element in the child elements
		so MkNote create empty div instead of no elements
	-->
</div>
</template>

<script lang="ts" setup>
import { inject, ref, useTemplateRef, provide, computed } from 'vue';
import * as Misskey from 'misskey-js';
import { userPage } from '@@/js/user.js';
import type { Ref } from 'vue';
import type { Keymap } from '@/utility/hotkey.js';
import MkAutoTranslatedNote from '@/components/MkAutoTranslatedNote.vue';
import { useNote } from '@/composables/use-note.js';
import { isUnavailableGridspaceNote } from '@/utility/is-unavailable-gridspace-note.js';
import { prefer } from '@/preferences.js';
import { i18n } from '@/i18n.js';
import { getNoteSummary } from '@/utility/get-note-summary.js';
import { isEnabledUrlPreview } from '@/utility/url-preview.js';
import { focusPrev, focusNext } from '@/utility/focus.js';
import number from '@/filters/number.js';
import { DI } from '@/di.js';

// コンポーネント外部の依存関係
import MkNoteSub from '@/components/MkNoteSub.vue';
import MkNoteChannel from '@/components/MkNoteChannel.vue';
import MkNoteArticle from '@/components/MkNoteArticle.vue';
import MkNoteHeader from '@/components/MkNoteHeader.vue';
import MkNoteSimple from '@/components/MkNoteSimple.vue';
import MkReactionsViewer from '@/components/MkReactionsViewer.vue';
import MkMediaList from '@/components/MkMediaList.vue';
import MkCwButton from '@/components/MkCwButton.vue';
import MkPoll from '@/components/MkPoll.vue';
import MkUrlPreview from '@/components/MkUrlPreview.vue';
import MkInstanceTicker from '@/components/MkInstanceTicker.vue';

const props = withDefaults(defineProps<{
	note: Misskey.entities.Note;
	pinned?: boolean;
	mock?: boolean;
	withHardMute?: boolean;
}>(), {
	mock: false,
});

const emit = defineEmits<{
	(ev: 'reaction', emoji: string): void;
	(ev: 'removeReaction', emoji: string): void;
}>();

provide(DI.mock, props.mock);

// 周辺コンテキストのインジェクト
const inTimeline = inject<boolean>('inTimeline', false);
const tl_withSensitive = inject<Ref<boolean>>('tl_withSensitive', ref(true));
const inChannel = inject(DI.inChannel, null);
const currentClip = inject<Ref<Misskey.entities.Clip> | null>('currentClip', null);
const currentAntenna = inject<Ref<Misskey.entities.Antenna | null> | null>('currentAntenna', null);

// Template Refsの定義
const rootEl = useTemplateRef('rootEl');
const menuButton = useTemplateRef('menuButton');
const renoteButton = useTemplateRef('renoteButton');
const renoteTime = useTemplateRef('renoteTime');
const reactButton = useTemplateRef('reactButton');
const clipButton = useTemplateRef('clipButton');
const galleryEl = useTemplateRef('galleryEl');

// コンポーサブルの呼び出し
const {
	note,
	appearNote,
	$appearNote,
	hideByPlugin,
	isRenote,
	showContent,
	translating,
	translation,
	muted,
	hardMuted,
	collapsed,
	renoteCollapsed,
	parsed,
	urls,
	isLong,
	showTicker,
	canRenote,

	renote,
	reply,
	react,
	reactViaMfmEmoji,
	toggleReact,
	onContextmenu,
	showMenu,
	clip,
	showRenoteMenu,
	blur,
} = useNote(props, {
	rootEl,
	menuButton,
	renoteButton,
	renoteTime,
	reactButton,
	clipButton,
}, {
	inTimeline,
	tl_withSensitive,
	inChannel,
	currentClip,
	currentAntenna,
});

// provide
provide(DI.mfmEmojiReactCallback, reactViaMfmEmoji);

// MkNote固有
const showSoftWordMutedWord = computed(() => prefer.s.showSoftWordMutedWord);

function handleToggleReact() {
	toggleReact((reaction) => {
		if ($appearNote.myReaction === reaction) {
			emit('removeReaction', reaction);
		} else {
			emit('reaction', reaction);
			$appearNote.reactions[reaction] = 1;
			$appearNote.reactionCount++;
			$appearNote.myReaction = reaction;
		}
	});
}

function emitUpdReaction(emoji: string, delta: number) {
	if (delta < 0) {
		emit('removeReaction', emoji);
	} else if (delta > 0) {
		emit('reaction', emoji);
	}
}

// キーボードショートカットマップ
const keymap = {
	'r': () => {
		if (renoteCollapsed.value) return;
		reply();
	},
	'e|a|plus': () => {
		if (renoteCollapsed.value) return;
		react();
	},
	'q': () => {
		if (renoteCollapsed.value) return;
		renote();
	},
	'm': () => {
		if (renoteCollapsed.value) return;
		showMenu();
	},
	'c': () => {
		if (renoteCollapsed.value) return;
		if (!prefer.s.showClipButtonInNoteFooter) return;
		clip();
	},
	'o': () => {
		if (renoteCollapsed.value) return;
		galleryEl.value?.openGallery();
	},
	'v|enter': () => {
		if (renoteCollapsed.value) {
			renoteCollapsed.value = false;
		} else if (appearNote.cw != null) {
			showContent.value = !showContent.value;
		} else if (isLong) {
			collapsed.value = !collapsed.value;
		}
	},
	'esc': {
		allowRepeat: true,
		callback: () => blur(),
	},
	'up|k|shift+tab': {
		allowRepeat: true,
		callback: () => focusPrev(rootEl.value),
	},
	'down|j|tab': {
		allowRepeat: true,
		callback: () => focusNext(rootEl.value),
	},
} as const satisfies Keymap;
</script>

<style lang="scss" module>
.root {
	position: relative;
	font-size: 1.05em;
	overflow: clip;
	contain: content;

	&:focus-visible {
		outline: none;

		&::after {
			content: "";
			pointer-events: none;
			display: block;
			position: absolute;
			z-index: 10;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			margin: auto;
			width: calc(100% - 8px);
			height: calc(100% - 8px);
			border: dashed 2px var(--MI_THEME-focus);
			border-radius: var(--MI-radius);
			box-sizing: border-box;
		}
	}

}

.skipRender {
	// TODO: これが有効だとTransitionGroupでnoteを追加するときに一瞬がくっとなってしまうのをどうにかしたい
	// Transitionが完了するのを待ってからskipRenderを付与すれば解決しそうだけどパフォーマンス的な影響が不明
	content-visibility: auto;
	contain-intrinsic-size: 0 150px;
}

.tip {
	display: flex;
	align-items: center;
	padding: 16px 32px 8px 32px;
	line-height: 24px;
	font-size: 90%;
	white-space: pre;
	color: #d28a3f;
}

.replyTo {
	opacity: 0.7;
	padding-bottom: 0;
}

.renote {
	position: relative;
	display: flex;
	align-items: center;
	padding: 16px 32px 8px 32px;
	line-height: 28px;
	white-space: pre;
	color: var(--MI_THEME-renote);

}

.renoteAvatar {
	flex-shrink: 0;
	display: inline-block;
	width: 28px;
	height: 28px;
	margin: 0 8px 0 0;
}

.renoteText {
	overflow: hidden;
	flex-shrink: 1;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.renoteUserName {
	font-weight: bold;
}

.renoteInfo {
	margin-left: auto;
	font-size: 0.9em;
}

.renoteTime {
	flex-shrink: 0;
	color: inherit;
}

.renoteMenu {
	margin-right: 4px;
}

.collapsedRenoteTarget {
	display: flex;
	align-items: center;
	line-height: 28px;
	white-space: pre;
	padding: 0 32px 18px;
}

.collapsedRenoteTargetAvatar {
	flex-shrink: 0;
	display: inline-block;
	width: 28px;
	height: 28px;
	margin: 0 8px 0 0;
}

.collapsedRenoteTargetText {
	overflow: hidden;
	flex-shrink: 1;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 90%;
	opacity: 0.7;
	cursor: pointer;

	&:hover {
		text-decoration: underline;
	}
}

.cw {
	cursor: default;
	display: block;
	margin: 0;
	padding: 0;
	overflow-wrap: break-word;
}

.showLess {
	width: 100%;
	margin-top: 14px;
	position: sticky;
	bottom: calc(var(--MI-stickyBottom, 0px) + 14px);
}

.showLessLabel {
	display: inline-block;
	background: var(--MI_THEME-popup);
	padding: 6px 10px;
	font-size: 0.8em;
	border-radius: 999px;
	box-shadow: 0 2px 6px rgb(0 0 0 / 20%);
}

.contentCollapsed {
	position: relative;
	max-height: 9em;
	overflow: clip;
}

.collapsed {
	display: block;
	position: absolute;
	bottom: 0;
	left: 0;
	z-index: 2;
	width: 100%;
	height: 64px;
	background: linear-gradient(0deg, var(--MI_THEME-panel), color(from var(--MI_THEME-panel) srgb r g b / 0));

	&:hover > .collapsedLabel {
		background: var(--MI_THEME-panelHighlight);
	}
}

.collapsedLabel {
	display: inline-block;
	background: var(--MI_THEME-panel);
	padding: 6px 10px;
	font-size: 0.8em;
	border-radius: 999px;
	box-shadow: 0 2px 6px rgb(0 0 0 / 20%);
}

.text {
	overflow-wrap: break-word;
}

.replyIcon {
	color: var(--MI_THEME-accent);
	margin-right: 0.5em;
}

.translation {
	border: solid 0.5px var(--MI_THEME-divider);
	border-radius: var(--MI-radius);
	padding: 12px;
	margin-top: 8px;
}

.urlPreview {
	margin-top: 8px;
}

.poll {
	font-size: 80%;
}

.quote {
	padding: 8px 0;
}

.quoteNote {
	padding: 16px;
	border: dashed 1px var(--MI_THEME-renote);
	border-radius: 8px;
	overflow: clip;
}

.footerButtonCount {
	display: inline;
	margin: 0 0 0 8px;
}

@container (max-width: 580px) {
	.root {
		font-size: 0.95em;
	}

	.renote {
		padding: 12px 26px 0 26px;
	}

}

@container (max-width: 500px) {
	.root {
		font-size: 0.9em;
	}

	.renote {
		padding: 10px 22px 0 22px;
	}

}

@container (max-width: 480px) {
	.renote {
		padding: 8px 16px 0 16px;
	}

	.tip {
		padding: 8px 16px 0 16px;
	}

	.collapsedRenoteTarget {
		padding: 0 16px 9px;
		margin-top: 4px;
	}

}

@container (max-width: 450px) {
}

@container (max-width: 400px) {
}

@container (max-width: 350px) {
}

@container (max-width: 300px) {

}

@container (max-width: 250px) {
	.quoteNote {
		padding: 12px;
	}
}

.muted {
	padding: 8px;
	text-align: center;
	opacity: 0.7;
}

.reactionOmitted {
	display: inline-block;
	margin-left: 8px;
	opacity: .8;
	font-size: 95%;
}

.deleted {
	text-align: center;
	padding: 32px;
	margin: 6px 32px 28px;
	--color: light-dark(rgba(0, 0, 0, 0.05), rgba(0, 0, 0, 0.15));
	background-size: auto auto;
	background-image: repeating-linear-gradient(135deg, transparent, transparent 10px, var(--color) 4px, var(--color) 14px);
	border-radius: 8px;
}
</style>
