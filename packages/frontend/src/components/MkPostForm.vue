<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div
	:class="[$style.root]"
	:inert="preparing || posting"
	@dragover.stop="onDragover"
	@dragenter="onDragenter"
	@dragleave="onDragleave"
	@drop.stop="onDrop"
>
	<MkPostFormHeader :fixed="fixed" @cancel="cancel">
		<template #account>
			<button ref="accountMenuEl" v-click-anime v-tooltip="i18n.ts.account" class="_button" @click="openAccountMenu">
				<img :class="$style.avatar" :src="(postAccount ?? $i).avatarUrl" style="border-radius: 100%;"/>
			</button>
		</template>
		<template v-if="placementForm || !(targetChannel != null && fixed)">
			<button v-if="!fixedQuoteDestination && (targetChannel == null || placementForm)" ref="visibilityButton" v-tooltip="i18n.ts.visibility" :class="['_button', $style.headerRightItem, $style.visibility]" @click="setVisibility">
				<span v-if="visibility === 'public'"><i class="ti ti-world"></i></span>
				<span v-if="visibility === 'home'"><i class="ti ti-home"></i></span>
				<span v-if="visibility === 'followers'"><i class="ti ti-lock"></i></span>
				<span v-if="visibility === 'specified'"><i class="ti ti-mail"></i></span>
				<span :class="$style.headerRightButtonText">{{ i18n.ts._visibility[visibility] }}</span>
			</button>
			<button v-else class="_button" :class="[$style.headerRightItem, $style.visibility]" disabled>
				<span><i class="ti ti-device-tv"></i></span>
				<span :class="$style.headerRightButtonText">{{ fixedQuoteDestination?.name ?? targetChannel?.name }}</span>
			</button>
		</template>
		<button v-if="visibility !== 'specified'" ref="deliveryButton" v-tooltip="deliveryLabel" class="_button" :class="[$style.headerRightItem, { [$style.danger]: delivery === 'local' }]" :disabled="localDeliveryRequired" :aria-label="deliveryLabel" aria-haspopup="menu" :aria-expanded="deliveryMenuOpen" data-testid="post-form-delivery" @click="openDeliveryMenu">
			<i :class="deliveryOption.icon" aria-hidden="true"></i>
		</button>
		<button ref="otherSettingsButton" v-tooltip="i18n.ts.other" class="_button" :class="$style.headerRightItem" @click="showOtherSettings"><i class="ti ti-dots"></i></button>
		<button ref="submitButtonEl" v-click-anime class="_button" :class="$style.submit" :disabled="!canPost" data-testid="post-form-submit" @click="post">
			<div :class="$style.submitInner">
				<template v-if="posted"></template>
				<template v-else-if="posting"><MkEllipsis/></template>
				<template v-else>{{ submitText }}</template>
				<i style="margin-left: 6px;" :class="submitIcon"></i>
			</div>
		</button>
	</MkPostFormHeader>
	<MkNoteDestinations v-if="placementForm" v-model="destinations" :localOrigin="localOrigin" :localOnly="effectiveLocalOnly" :visibility="visibility" :disabled="posting || preparing || posted" :peerEnabled="instance.features?.multiNotePeer === true" :token="candidateToken"/>
	<MkInfo v-for="key in otherPendingDrafts" :key="key">
		<button type="button" class="_textButton" @click="openPendingDraft(key)">{{ i18n.ts._multiNote.openPendingDraft }}</button>
	</MkInfo>
	<MkInfo v-if="missingDraftAccountId && !pendingCreate" warn>{{ i18n.ts._multiNote.chooseAccount }}</MkInfo>
	<MkInfo v-if="placementsUnavailable || (explicitDestinations && !placementSubmission)" warn>{{ i18n.ts._multiNote.placementsUnavailable }}</MkInfo>
	<MkInfo v-if="pendingCreate">
		{{ i18n.ts._multiNote.pendingCreate }}
		<button type="button" class="_textButton" :disabled="posting || preparing" @click="recoverPending">{{ i18n.ts._multiNote.checkResult }}</button>
	</MkInfo>
	<MkNoteSimple v-if="replyTargetNote" :class="$style.targetNote" :note="replyTargetNote"/>
	<MkNoteSimple v-if="renoteTargetNote" :class="$style.targetNote" :note="renoteTargetNote"/>
	<MkGridspaceNoteLinkPreview v-if="gridspaceQuote" :class="$style.targetNote" :url="gridspaceQuote" composing :quoteDestination="fixedQuoteDestination" quote/>
	<div v-if="gridspaceQuote" :class="$style.withQuote"><i class="ti ti-quote"></i> {{ i18n.ts.quoteAttached }}<button v-if="!fixedQuoteDestination" class="_button" :aria-label="i18n.ts.remove" @click="gridspaceQuote = null"><i class="ti ti-x"></i></button></div>
	<div v-if="quoteId" :class="$style.withQuote"><i class="ti ti-quote"></i> {{ i18n.ts.quoteAttached }}<button @click="quoteId = null; renoteTargetNote = null;"><i class="ti ti-x"></i></button></div>
	<div v-if="visibility === 'specified'" :class="$style.toSpecified">
		<span style="margin-right: 8px;">{{ i18n.ts.recipient }}</span>
		<div :class="$style.visibleUsers">
			<span v-for="u in visibleUsers" :key="u.id" :class="$style.visibleUser">
				<MkAcct :user="u"/>
				<button class="_button" style="padding: 4px 8px;" @click="removeVisibleUser(u.id)"><i class="ti ti-x"></i></button>
			</span>
			<button class="_buttonPrimary" style="padding: 4px; border-radius: 8px;" @click="addVisibleUser"><i class="ti ti-plus ti-fw"></i></button>
		</div>
	</div>
	<MkInfo v-if="!store.r.tips.value.postForm" :class="$style.showHowToUse" closable @close="closeTip('postForm')">
		<button class="_textButton" @click="showTour">{{ i18n.ts._postForm.showHowToUse }}</button>
	</MkInfo>
	<MkInfo v-if="scheduledAt != null" :class="$style.scheduledAt">
		<I18n :src="i18n.ts.scheduleToPostOnX" tag="span">
			<template #x>
				<MkTime :time="scheduledAt" :mode="'detail'" style="font-weight: bold;"/>
			</template>
		</I18n> - <button class="_textButton" @click="cancelSchedule()">{{ i18n.ts.cancel }}</button>
	</MkInfo>
	<MkInfo v-if="hasNotSpecifiedMentions" warn :class="$style.hasNotSpecifiedMentions">{{ i18n.ts.notSpecifiedMentionWarning }} - <button class="_textButton" @click="addMissingMention()">{{ i18n.ts.add }}</button></MkInfo>
	<MkPostFormFields :useCw="useCw" :channelColor="targetChannel?.color"><template #cw><input ref="cwInputEl" v-model="cw" :class="$style.cw" :placeholder="i18n.ts.annotation" @keydown="onKeydown" @keyup="onKeyup" @compositionend="onCompositionEnd"><div v-if="maxCwTextLength - cwTextLength < 20" :class="['_acrylic', $style.cwTextCount, { [$style.cwTextOver]: cwTextLength > maxCwTextLength }]">{{ maxCwTextLength - cwTextLength }}</div></template><textarea ref="textareaEl" v-model="text" :class="[$style.text]" :disabled="preparing || posting || posted" :readonly="textAreaReadOnly" :placeholder="placeholder" data-testid="post-form-text" @keydown="onKeydown" @keyup="onKeyup" @paste="onPaste" @compositionupdate="onCompositionUpdate" @compositionend="onCompositionEnd"></textarea><template #counter><div v-if="maxTextLength - textLength < 100" :class="['_acrylic', $style.textCount, { [$style.textOver]: textLength > maxTextLength }]">{{ maxTextLength - textLength }}</div></template></MkPostFormFields>
	<input v-show="withHashtags" ref="hashtagsInputEl" v-model="hashtags" :class="$style.hashtags" :placeholder="i18n.ts.hashtags" list="hashtags">
	<XPostFormAttaches v-model="files" @detach="detachFile" @changeSensitive="updateFileSensitive" @changeName="updateFileName"/>
	<div v-if="uploader.items.value.length > 0" style="padding: 12px;">
		<MkTip k="postFormUploader">
			{{ i18n.ts._postForm.uploaderTip }}
		</MkTip>
		<MkUploaderItems :items="uploader.items.value" @showMenu="(item, ev) => showPerUploadItemMenu(item, ev)" @showMenuViaContextmenu="(item, ev) => showPerUploadItemMenuViaContextmenu(item, ev)"/>
	</div>
	<MkPollEditor v-if="poll" v-model="poll" @destroyed="poll = null"/>
	<MkNotePreview v-if="showPreview" :class="$style.preview" :text="text" :files="files" :poll="poll ?? undefined" :useCw="useCw" :cw="cw" :user="postAccount ?? $i"/>
	<div v-if="showingOptions" style="padding: 8px 16px;">
	</div>
	<footer ref="footerEl" :class="$style.footer"><MkPostFormActionBar :poll="!!poll" :useCw="useCw" drive showHashtags :hashtags="withHashtags" :mfm="showAddMfmFunction" :plugins="postFormActions.length > 0" @upload="chooseFileFromPc" @drive="chooseFileFromDrive" @poll="togglePoll" @cw="useCw = !useCw" @hashtags="withHashtags = !withHashtags" @mention="insertMention" @mfm="insertMfmFunction" @plugins="showActions" @emoji="insertEmoji"/></footer>
	<datalist id="hashtags">
		<option v-for="hashtag in recentHashtags" :key="hashtag" :value="hashtag"></option>
	</datalist>
</div>
</template>

<script lang="ts" setup>
import { watch, nextTick, onMounted, defineAsyncComponent, provide, shallowRef, ref, computed, useTemplateRef, onUnmounted, onBeforeUnmount } from 'vue';
import * as mfm from 'mfm-js';
import * as Misskey from 'misskey-js';
import insertTextAtCursor from 'insert-text-at-cursor';
import { toASCII } from 'punycode.js';
import { host, url } from '@@/js/config.js';
import MkUploaderItems from './MkUploaderItems.vue';
import type { ShallowRef } from 'vue';
import type { PostFormProps } from '@/types/post-form.js';
import type { MenuItem } from '@/types/menu.js';
import type { PollEditorModelValue } from '@/components/MkPollEditor.vue';
import type { UploaderItem } from '@/composables/use-uploader.js';
import MkPostFormActionBar from '@/components/MkPostFormActionBar.vue';
import MkNoteDestinations from '@/components/MkNoteDestinations.vue';
import { sameChannel, canUseDestinations, initialDestinations, noteInputHash, placementParams, recoverNoteCreate, startNoteCreate, withDraftLock } from '@/utility/multi-note.js';
import type { NoteDestinations, PendingNoteCreate } from '@/utility/multi-note.js';
import MkPostFormFields from '@/components/MkPostFormFields.vue';
import MkPostFormHeader from '@/components/MkPostFormHeader.vue';
import MkNotePreview from '@/components/MkNotePreview.vue';
import XPostFormAttaches from '@/components/MkPostFormAttaches.vue';
import XTextCounter from '@/components/MkPostForm.TextCounter.vue';
import MkPollEditor from '@/components/MkPollEditor.vue';
import MkNoteSimple from '@/components/MkNoteSimple.vue';
import MkGridspaceNoteLinkPreview from '@/components/MkGridspaceNoteLinkPreview.vue';
import { erase, unique } from '@/utility/array.js';
import { extractMentions } from '@/utility/extract-mentions.js';
import { formatTimeString } from '@/utility/format-time-string.js';
import { Autocomplete } from '@/utility/autocomplete.js';
import * as os from '@/os.js';
import { getApiErrorStatus, misskeyApi } from '@/utility/misskey-api.js';
import { chooseDriveFile } from '@/utility/drive.js';
import { store } from '@/store.js';
import MkInfo from '@/components/MkInfo.vue';
import { i18n } from '@/i18n.js';
import { instance } from '@/instance.js';
import { ensureSignin, notesCount, incNotesCount } from '@/i.js';
import { getAccounts, getAccountMenu } from '@/accounts.js';
import { deepClone } from '@/utility/clone.js';
import MkRippleEffect from '@/components/MkRippleEffect.vue';
import { miLocalStorage } from '@/local-storage.js';
import { claimAchievement } from '@/utility/achievements.js';
import { emojiPicker } from '@/utility/emoji-picker.js';
import { mfmFunctionPicker } from '@/utility/mfm-function-picker.js';
import { prefer } from '@/preferences.js';
import { getPluginHandlers } from '@/plugin.js';
import { DI } from '@/di.js';
import { globalEvents } from '@/events.js';
import { checkDragDataType, getDragData } from '@/drag-and-drop.js';
import { useUploader } from '@/composables/use-uploader.js';
import { startTour } from '@/utility/tour.js';
import { closeTip } from '@/tips.js';
import type { LinkedQuoteAttachment } from '@/utility/gridspace-note-link.js';
import { isGridspaceNoteLink, isConfiguredGridspaceNoteLink, parsePlacementReference } from '@/utility/gridspace-note-link.js';
import { gridspacePost } from '@/utility/gridspace-post.js';
import { getDefaultNoteDelivery, getNoteDelivery, getNoteDeliveryFlags, getNoteDeliveryOptions } from '@/utility/note-delivery.js';
import type { NoteDelivery } from '@/utility/note-delivery.js';

const $i = ensureSignin();

const props = withDefaults(defineProps<PostFormProps & {
	fixed?: boolean;
	autofocus?: boolean;
	freezeAfterPosted?: boolean;
	mock?: boolean;
}>(), {
	initialVisibleUsers: () => [],
	autofocus: true,
	mock: false,
	initialLocalOnly: undefined,
});

provide(DI.mock, props.mock);

const emit = defineEmits<{
	(ev: 'posted'): void;
	(ev: 'cancel'): void;
	(ev: 'esc'): void;

	// Mock用
	(ev: 'fileChangeSensitive', fileId: string, to: boolean): void;
}>();

const textareaEl = useTemplateRef('textareaEl');
const cwInputEl = useTemplateRef('cwInputEl');
const hashtagsInputEl = useTemplateRef('hashtagsInputEl');
const visibilityButton = useTemplateRef('visibilityButton');
const deliveryButton = useTemplateRef('deliveryButton');
const otherSettingsButton = useTemplateRef('otherSettingsButton');
const accountMenuEl = useTemplateRef('accountMenuEl');
const footerEl = useTemplateRef('footerEl');
const submitButtonEl = useTemplateRef('submitButtonEl');

const resolvingLinkedQuote = ref(false);
let linkedQuoteGeneration = 0;

function expireLinkedQuote() { if (window.document.hidden) linkedQuoteGeneration++; }

window.document.addEventListener('visibilitychange', expireLinkedQuote);
onBeforeUnmount(() => { linkedQuoteGeneration++; window.document.removeEventListener('visibilitychange', expireLinkedQuote); });
const posting = ref(false);
const posted = ref(false);
const text = ref(props.initialText ?? '');
const files = ref(props.initialFiles ?? []);
const poll = ref<PollEditorModelValue | null>(null);
const useCw = ref<boolean>(!!props.initialCw);
const showPreview = ref(store.s.showPreview);
watch(showPreview, () => store.set('showPreview', showPreview.value));
const showAddMfmFunction = ref(prefer.s.enableQuickAddMfmFunction);
watch(showAddMfmFunction, () => prefer.commit('enableQuickAddMfmFunction', showAddMfmFunction.value));
const cw = ref<string | null>(props.initialCw ?? null);
const initialDelivery = prefer.s.rememberNoteVisibility ? store.s : getNoteDeliveryFlags(getDefaultNoteDelivery(prefer.s.defaultNoteLocalOnly));
const localOnly = ref(props.initialLocalOnly ?? initialDelivery.localOnly);
const noRelay = ref(props.initialLocalOnly == null && initialDelivery.noRelay);
const visibility = ref(props.initialVisibility ?? (prefer.s.rememberNoteVisibility ? store.s.visibility : prefer.s.defaultNoteVisibility));
const visibleUsers = ref<Misskey.entities.UserLite[]>([]);
if (props.initialVisibleUsers) {
	props.initialVisibleUsers.forEach(u => pushVisibleUser(u));
}
const reactionAcceptance = ref(store.s.reactionAcceptance);
const scheduledAt = ref<number | null>(null);
const draghover = ref(false);
const quoteId = ref<string | null>(null);
const hasNotSpecifiedMentions = ref(false);
const recentHashtags = ref(JSON.parse(miLocalStorage.getItem('hashtags') ?? '[]'));
const imeText = ref('');
const showingOptions = ref(false);
const textAreaReadOnly = ref(false);
const justEndedComposition = ref(false);
const renoteTargetNote: ShallowRef<PostFormProps['renote'] | null> = shallowRef(props.renote);
const gridspaceQuote = ref(props.gridspaceQuote ?? props.initialNote?.gridspaceQuote ?? null);
const replyTargetNote: ShallowRef<PostFormProps['reply'] | null> = shallowRef(props.reply);
const targetChannel = shallowRef(props.channel);
const localOrigin = new URL(url).origin;
const fixedQuoteDestination = ref(props.fixedQuoteDestination);
const initialChannel = props.fixedQuoteDestination ?? props.initialChannelDestination ?? (props.channel ? {
	origin: localOrigin, channelId: props.channel.id, name: props.channel.name, color: props.channel.color,
	isSensitive: props.channel.isSensitive, allowRenoteToExternal: props.channel.allowRenoteToExternal,
} : null);
const destinations = ref(initialDestinations(initialChannel));
const pendingCreate = shallowRef<PendingNoteCreate | null>(null);
const preparing = ref(false);
const otherPendingDrafts = ref<string[]>([]);
let pauseDraftSaving = false;
let lastDraftRevision: string | undefined;
const initiallyPlaced = !props.reply && !props.renote && !props.gridspaceQuote && !props.initialNote?.gridspaceQuote && !props.instant && initialChannel != null &&
	(props.initialChannelDestination != null || instance.features?.multiNote === true);
const keepDestinationSelection = ref(initiallyPlaced);
watch(destinations, value => {
	if (!props.instant && !replyTargetNote.value && !renoteTargetNote.value && !quoteId.value && !gridspaceQuote.value && !scheduledAt.value && (value.channels.length || !value.includeDefault)) keepDestinationSelection.value = true;
}, { deep: true, flush: 'sync' });
const placementForm = computed(() => !fixedQuoteDestination.value && (instance.features?.multiNote === true || keepDestinationSelection.value) && !props.instant &&
	!replyTargetNote.value && !renoteTargetNote.value && !quoteId.value && !gridspaceQuote.value && !scheduledAt.value);
const fixedReference = computed(() => !!fixedQuoteDestination.value && !!gridspaceQuote.value && !!parsePlacementReference(gridspaceQuote.value) &&
	!replyTargetNote.value && !renoteTargetNote.value && !quoteId.value && !scheduledAt.value &&
	!destinations.value.includeDefault && destinations.value.channels.length === 1 && sameChannel(destinations.value.channels[0], fixedQuoteDestination.value));
const placementSubmission = computed(() => placementForm.value || fixedReference.value);
const explicitDestinations = computed(() => !!fixedQuoteDestination.value || (keepDestinationSelection.value && (!destinations.value.includeDefault || destinations.value.channels.length > 0)));
const hasPlacements = computed(() => placementSubmission.value && destinations.value.channels.length > 0);
const placementsUnavailable = computed(() => hasPlacements.value && (instance.features?.multiNote !== true ||
	(destinations.value.channels.some(item => item.origin !== localOrigin) && instance.features?.multiNotePeer !== true)));
const serverDraftChannel = computed(() => {
	if (!placementForm.value) return targetChannel.value?.id ?? null;
	const [only] = destinations.value.channels;
	return !destinations.value.includeDefault && destinations.value.channels.length === 1 && only.origin === localOrigin ? only.channelId : null;
});
const postAccount = ref<Misskey.entities.UserDetailed | null>(null);
const missingDraftAccountId = ref<string | null>(null);
const candidateToken = computed(() => postAccount.value ? store.s.accountTokens[host + '/' + postAccount.value.id] : undefined);
const localDeliveryRequired = computed(() => gridspaceQuote.value != null || replyTargetNote.value?.localOnly === true || renoteTargetNote.value?.localOnly === true ||
	(placementForm.value ? !destinations.value.includeDefault : targetChannel.value != null));
const effectiveLocalOnly = computed(() => localDeliveryRequired.value || localOnly.value);
const delivery = computed(() => getNoteDelivery({ localOnly: effectiveLocalOnly.value, noRelay: noRelay.value }));
const deliveryOption = computed(() => getNoteDeliveryOptions()[delivery.value]);
const deliveryLabel = computed(() => `${i18n.ts._visibility.delivery}：${deliveryOption.value.label}`);
const deliveryMenuOpen = ref(false);
const relayDeliveryDisabled = computed(() => delivery.value === 'noRelay' && visibility.value !== 'specified');

const serverDraftId = ref<string | null>(null);
const postFormActions = getPluginHandlers('post_form_action');

let textAutocomplete: Autocomplete | null = null;
let cwAutocomplete: Autocomplete | null = null;
let hashtagAutocomplete: Autocomplete | null = null;

const uploader = useUploader({
	multiple: true,
});

onUnmounted(() => {
	uploader.dispose();
});

uploader.events.on('itemUploaded', ctx => {
	files.value.push(ctx.item.uploaded!);
	uploader.removeItem(ctx.item);
});

const draftKey = computed((): string => {
	if (props.initialPendingDraftKey) return props.initialPendingDraftKey;
	const initialDestination = props.fixedQuoteDestination ?? props.initialChannelDestination;
	let key = initialDestination ? `channel:${initialDestination.origin}:${initialDestination.channelId}` : targetChannel.value ? `channel:${targetChannel.value.id}` : '';

	if (gridspaceQuote.value) {
		key += `gridspaceQuote:${gridspaceQuote.value}`;
	} else if (renoteTargetNote.value) {
		key += `renote:${renoteTargetNote.value.id}`;
	} else if (replyTargetNote.value) {
		key += `reply:${replyTargetNote.value.id}`;
	} else {
		key += `note:${$i.id}`;
		if (props.specified) key += `:specified:${props.specified.id}`;
		else if (props.mention) key += `:mention:${props.mention.id}`;
	}

	// Old channel/reply drafts used shared keys. Keep the owner's legacy draft usable.
	const drafts = readDrafts();
	const accountKey = `account:${$i.id}:${key}`;
	return fixedQuoteDestination.value || drafts[accountKey] || (drafts[key]?.ownerId && drafts[key].ownerId !== $i.id) ? accountKey : key;
});

const placeholder = computed((): string => {
	if (renoteTargetNote.value || gridspaceQuote.value) {
		return i18n.ts._postForm.quotePlaceholder;
	} else if (replyTargetNote.value) {
		return i18n.ts._postForm.replyPlaceholder;
	} else if (targetChannel.value) {
		return i18n.ts._postForm.channelPlaceholder;
	} else {
		const xs = [
			i18n.ts._postForm._placeholders.a,
			i18n.ts._postForm._placeholders.b,
			i18n.ts._postForm._placeholders.c,
			i18n.ts._postForm._placeholders.d,
			i18n.ts._postForm._placeholders.e,
			i18n.ts._postForm._placeholders.f,
		];
		return xs[Math.floor(Math.random() * xs.length)];
	}
});

const submitText = computed((): string => {
	return scheduledAt.value != null
		? i18n.ts.schedule
		: renoteTargetNote.value || gridspaceQuote.value
			? i18n.ts.quote
			: replyTargetNote.value
				? i18n.ts.reply
				: i18n.ts.note;
});

const submitIcon = computed((): string => {
	return posted.value ? 'ti ti-check' : scheduledAt.value != null ? 'ti ti-calendar-time' : replyTargetNote.value ? 'ti ti-arrow-back-up' : renoteTargetNote.value || gridspaceQuote.value ? 'ti ti-quote' : 'ti ti-send';
});

const textLength = computed((): number => {
	return (text.value + imeText.value).length;
});

const maxTextLength = computed((): number => {
	return instance ? instance.maxNoteTextLength : 1000;
});

const cwTextLength = computed((): number => {
	return cw.value?.length ?? 0;
});

const maxCwTextLength = 100;

const canPost = computed((): boolean => {
	return !missingDraftAccountId.value && !placementsUnavailable.value && (!explicitDestinations.value || placementSubmission.value) && (!placementSubmission.value || canUseDestinations(destinations.value, visibility.value)) && !preparing.value &&
		!props.mock && !resolvingLinkedQuote.value && !posting.value && !posted.value && !uploader.uploading.value && (uploader.items.value.length === 0 || uploader.readyForUpload.value) &&
		(
			1 <= textLength.value ||
			1 <= files.value.length ||
			1 <= uploader.items.value.length ||
			poll.value != null ||
			renoteTargetNote.value != null ||
			quoteId.value != null ||
			gridspaceQuote.value != null
		) &&
		(textLength.value <= maxTextLength.value) &&
		(
			useCw.value ?
				(
					cw.value != null && cw.value.trim() !== '' &&
					cwTextLength.value <= maxCwTextLength
				) : true
		) &&
		(files.value.length <= 16) &&
		(!poll.value || poll.value.choices.length >= 2);
});

// cannot save pure renote as draft
const canSaveAsServerDraft = computed((): boolean => {
	return !fixedQuoteDestination.value && (!explicitDestinations.value || serverDraftChannel.value != null) && !pendingCreate.value && canPost.value && (textLength.value > 0 || files.value.length > 0 || poll.value != null);
});

const withHashtags = store.model('postFormWithHashtags');
const hashtags = store.model('postFormHashtags');

watch(text, () => {
	checkMissingMention();
}, { immediate: true });

watch(visibility, () => {
	checkMissingMention();
}, { immediate: true });

watch(visibleUsers, () => {
	checkMissingMention();
}, {
	deep: true,
});

if (props.mention) {
	text.value = props.mention.host ? `@${props.mention.username}@${toASCII(props.mention.host)}` : `@${props.mention.username}`;
	text.value += ' ';
}

if (replyTargetNote.value && (replyTargetNote.value.user.username !== $i.username || (replyTargetNote.value.user.host != null && replyTargetNote.value.user.host !== host))) {
	text.value = `@${replyTargetNote.value.user.username}${replyTargetNote.value.user.host != null ? '@' + toASCII(replyTargetNote.value.user.host) : ''} `;
}

if (replyTargetNote.value && replyTargetNote.value.text != null) {
	const ast = mfm.parse(replyTargetNote.value.text);
	const otherHost = replyTargetNote.value.user.host;

	for (const x of extractMentions(ast)) {
		const mention = x.host ?
			`@${x.username}@${toASCII(x.host)}` :
			(otherHost == null || otherHost === host) ?
				`@${x.username}` :
				`@${x.username}@${toASCII(otherHost)}`;

		// 自分は除外
		if ($i.username === x.username && (x.host == null || x.host === host)) continue;

		// 重複は除外
		if (text.value.includes(`${mention} `)) continue;

		text.value += `${mention} `;
	}
}

if ($i.isSilenced && visibility.value === 'public') {
	visibility.value = 'home';
}

if (fixedQuoteDestination.value || (targetChannel.value && !placementForm.value)) {
	visibility.value = 'public';
	localOnly.value = true; // TODO: チャンネルが連合するようになった折には消す
}

// 公開以外へのリプライ時は元の公開範囲を引き継ぐ
if (replyTargetNote.value && ['home', 'followers', 'specified'].includes(replyTargetNote.value.visibility)) {
	if (replyTargetNote.value.visibility === 'home' && visibility.value === 'followers') {
		visibility.value = 'followers';
	} else if (['home', 'followers'].includes(replyTargetNote.value.visibility) && visibility.value === 'specified') {
		visibility.value = 'specified';
	} else {
		visibility.value = replyTargetNote.value.visibility;
	}

	if (visibility.value === 'specified') {
		if (replyTargetNote.value.visibleUserIds) {
			misskeyApi('users/show', {
				userIds: replyTargetNote.value.visibleUserIds.filter(uid => uid !== $i.id && uid !== replyTargetNote.value?.userId),
			}).then(users => {
				users.forEach(u => pushVisibleUser(u));
			});
		}

		if (replyTargetNote.value.userId !== $i.id) {
			pushVisibleUser(replyTargetNote.value.user);
		}
	}
}

if (props.specified) {
	visibility.value = 'specified';
	pushVisibleUser(props.specified);
}

// keep cw when reply
if (prefer.s.keepCw && replyTargetNote.value && replyTargetNote.value.cw) {
	useCw.value = true;
	cw.value = replyTargetNote.value.cw;
}

function watchForDraft() {
	watch(destinations, () => saveDraft(), { deep: true });
	watch([withHashtags, hashtags], () => saveDraft());
	watch([postAccount, missingDraftAccountId], () => saveDraft());
	watch(text, () => saveDraft());
	watch(useCw, () => saveDraft());
	watch(cw, () => saveDraft());
	watch(poll, () => saveDraft());
	watch(files, () => saveDraft(), { deep: true });
	watch(visibility, () => saveDraft());
	watch(localOnly, () => saveDraft());
	watch(noRelay, () => saveDraft());
	watch(quoteId, () => saveDraft());
	watch(gridspaceQuote, () => saveDraft());
	watch(reactionAcceptance, () => saveDraft());
	watch(scheduledAt, () => saveDraft());
}

function checkMissingMention() {
	if (visibility.value === 'specified') {
		const ast = mfm.parse(text.value);

		for (const x of extractMentions(ast)) {
			if (!visibleUsers.value.some(u => (u.username === x.username) && ((u.host === x.host) || (x.host === host && u.host == null)))) {
				hasNotSpecifiedMentions.value = true;
				return;
			}
		}
	}
	hasNotSpecifiedMentions.value = false;
}

function addMissingMention() {
	const ast = mfm.parse(text.value);

	for (const x of extractMentions(ast)) {
		if (!visibleUsers.value.some(u => (u.username === x.username) && (u.host === x.host))) {
			misskeyApi('users/show', { username: x.username, host: x.host }).then(user => {
				pushVisibleUser(user);
			});
		}
	}
}

function togglePoll() {
	if (poll.value) {
		poll.value = null;
	} else {
		poll.value = {
			choices: ['', ''],
			multiple: false,
			expiresAt: null,
			expiredAfter: null,
		};
	}
}

function addTag(tag: string) {
	if (textareaEl.value == null) return;
	insertTextAtCursor(textareaEl.value, ` #${tag} `);
}

function focus() {
	if (textareaEl.value) {
		textareaEl.value.focus();
		textareaEl.value.setSelectionRange(textareaEl.value.value.length, textareaEl.value.value.length);
	}
}

function chooseFileFromPc(ev: PointerEvent) {
	if (props.mock) return;

	os.chooseFileFromPc({ multiple: true }).then(files => {
		if (files.length === 0) return;
		uploader.addFiles(files);
	});
}

function chooseFileFromDrive(ev: PointerEvent) {
	if (props.mock) return;

	chooseDriveFile({ multiple: true }).then(driveFiles => {
		files.value.push(...driveFiles);
	});
}

function detachFile(id: Misskey.entities.DriveFile['id']) {
	files.value = files.value.filter(x => x.id !== id);
}

function updateFileSensitive(file: Misskey.entities.DriveFile, isSensitive: boolean) {
	if (props.mock) {
		emit('fileChangeSensitive', file.id, isSensitive);
	}
	files.value[files.value.findIndex(x => x.id === file.id)].isSensitive = isSensitive;
}

function updateFileName(file: Misskey.entities.DriveFile, name: Misskey.entities.DriveFile['name']) {
	files.value[files.value.findIndex(x => x.id === file.id)].name = name;
}

function setVisibility() {
	if (fixedQuoteDestination.value || (targetChannel.value && !placementForm.value)) {
		visibility.value = 'public';
		localOnly.value = true; // TODO: チャンネルが連合するようになった折には消す
		return;
	}

	const { dispose } = os.popup(defineAsyncComponent(() => import('@/components/MkVisibilityPicker.vue')), {
		currentVisibility: visibility.value,
		isSilenced: $i.isSilenced,
		anchorElement: visibilityButton.value,
		...(replyTargetNote.value ? { isReplyVisibilitySpecified: replyTargetNote.value.visibility === 'specified' } : {}),
	}, {
		changeVisibility: v => {
			visibility.value = v;
			if (prefer.s.rememberNoteVisibility) {
				store.set('visibility', visibility.value);
			}
		},
		closed: () => dispose(),
	});
}

function openDeliveryMenu() {
	if (localDeliveryRequired.value || deliveryMenuOpen.value) return;
	deliveryMenuOpen.value = true;
	os.popupMenu([
		{ type: 'label', text: i18n.ts._visibility.delivery },
		...Object.values(getNoteDeliveryOptions()).map(option => ({
			text: option.label,
			caption: option.description,
			icon: delivery.value === option.value ? 'ti ti-check' : option.icon,
			active: delivery.value === option.value,
			action: () => { void setDelivery(option.value); },
		})),
	], deliveryButton.value, { onClosed: () => { deliveryMenuOpen.value = false; } });
}

async function setDelivery(mode: NoteDelivery) {
	if (localDeliveryRequired.value || visibility.value === 'specified' || mode === delivery.value) return;
	const neverShowInfo = miLocalStorage.getItem('neverShowLocalOnlyInfo');

	if (mode === 'local' && neverShowInfo !== 'true') {
		const confirm = await os.actions({
			type: 'question',
			title: i18n.ts.disableFederationConfirm,
			text: i18n.ts.disableFederationConfirmWarn,
			actions: [
				{
					value: 'yes' as const,
					text: i18n.ts.disableFederationOk,
					primary: true,
				},
				{
					value: 'neverShow' as const,
					text: `${i18n.ts.disableFederationOk} (${i18n.ts.neverShow})`,
					danger: true,
				},
				{
					value: 'no' as const,
					text: i18n.ts.cancel,
				},
			],
		});
		if (confirm.canceled) return;
		if (confirm.result === 'no') return;

		if (confirm.result === 'neverShow') {
			miLocalStorage.setItem('neverShowLocalOnlyInfo', 'true');
		}
	}

	const flags = getNoteDeliveryFlags(mode);
	localOnly.value = flags.localOnly;
	noRelay.value = flags.noRelay;
	if (prefer.s.rememberNoteVisibility) {
		store.set('localOnly', flags.localOnly);
		store.set('noRelay', flags.noRelay);
	}
}

async function toggleReactionAcceptance() {
	const select = await os.select({
		title: i18n.ts.reactionAcceptance,
		items: [
			{ value: null, label: i18n.ts.all },
			{ value: 'likeOnlyForRemote' as const, label: i18n.ts.likeOnlyForRemote },
			{ value: 'nonSensitiveOnly' as const, label: i18n.ts.nonSensitiveOnly },
			{ value: 'nonSensitiveOnlyForLocalLikeOnlyForRemote' as const, label: i18n.ts.nonSensitiveOnlyForLocalLikeOnlyForRemote },
			{ value: 'likeOnly' as const, label: i18n.ts.likeOnly },
		],
		default: reactionAcceptance.value,
	});
	if (select.canceled) return;
	reactionAcceptance.value = select.result;
}

//#region その他の設定メニューpopup
function showOtherSettings() {
	let reactionAcceptanceIcon = 'ti ti-icons';
	let reactionAcceptanceCaption = '';

	switch (reactionAcceptance.value) {
		case 'likeOnly':
			reactionAcceptanceIcon = 'ti ti-heart _love';
			reactionAcceptanceCaption = i18n.ts.likeOnly;
			break;

		case 'likeOnlyForRemote':
			reactionAcceptanceIcon = 'ti ti-heart-plus';
			reactionAcceptanceCaption = i18n.ts.likeOnlyForRemote;
			break;

		case 'nonSensitiveOnly':
			reactionAcceptanceCaption = i18n.ts.nonSensitiveOnly;
			break;

		case 'nonSensitiveOnlyForLocalLikeOnlyForRemote':
			reactionAcceptanceCaption = i18n.ts.nonSensitiveOnlyForLocalLikeOnlyForRemote;
			break;

		default:
			reactionAcceptanceCaption = i18n.ts.all;
			break;
	}

	const menuItems = [{
		type: 'component',
		component: XTextCounter,
		props: {
			textLength: textLength,
		},
	}, { type: 'divider' }, {
		icon: reactionAcceptanceIcon,
		text: i18n.ts.reactionAcceptance,
		caption: reactionAcceptanceCaption,
		action: () => {
			toggleReactionAcceptance();
		},
	}, { type: 'divider' }, {
		type: 'button',
		text: i18n.ts._drafts.saveToDraft,
		icon: 'ti ti-cloud-upload',
		action: async () => {
			if (!canSaveAsServerDraft.value) {
				return os.alert({
					type: 'error',
					text: i18n.ts._drafts.cannotCreateDraft,
				});
			}
			saveServerDraft();
		},
	}, ...(!explicitDestinations.value && !pendingCreate.value && $i.policies.scheduledNoteLimit > 0 ? [{
		icon: 'ti ti-calendar-time',
		text: i18n.ts.schedulePost + '...',
		action: () => {
			schedule();
		},
	}] : []), { type: 'divider' }, {
		type: 'switch',
		icon: 'ti ti-eye',
		text: i18n.ts.preview,
		ref: showPreview,
	}, {
		icon: 'ti ti-trash',
		text: i18n.ts.reset,
		danger: true,
		action: async () => {
			if (props.mock) return;
			const { canceled } = await os.confirm({
				type: 'question',
				text: i18n.ts.resetAreYouSure,
			});
			if (canceled) return;
			clear();
		},
	}] satisfies MenuItem[];

	os.popupMenu(menuItems, otherSettingsButton.value);
}
//#endregion

function pushVisibleUser(user: Misskey.entities.UserLite) {
	if (!visibleUsers.value.some(u => u.username === user.username && u.host === user.host)) {
		visibleUsers.value.push(user);
	}
}

function addVisibleUser() {
	os.selectUser().then(user => {
		pushVisibleUser(user);

		if (!text.value.toLowerCase().includes(`@${user.username.toLowerCase()}`)) {
			text.value = `@${Misskey.acct.toString(user)} ${text.value}`;
		}
	});
}

function removeVisibleUser(id: string) {
	visibleUsers.value = visibleUsers.value.filter(u => u.id !== id);
}

function clear() {
	destinations.value = initialDestinations(initialChannel);
	keepDestinationSelection.value = initiallyPlaced;
	text.value = '';
	cw.value = null;
	files.value = [];
	poll.value = null;
	quoteId.value = null;
	scheduledAt.value = null;
	uploader.reset();
}

function onKeydown(ev: KeyboardEvent) {
	if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && canPost.value) post();

	// justEndedComposition.value is for Safari, which keyDown occurs after compositionend.
	// ev.isComposing is for another browsers.
	if (ev.key === 'Escape' && !justEndedComposition.value && !ev.isComposing) emit('esc');
}

function onKeyup(ev: KeyboardEvent) {
	justEndedComposition.value = false;
}

function onCompositionUpdate(ev: CompositionEvent) {
	imeText.value = ev.data;
}

function onCompositionEnd(ev: CompositionEvent) {
	imeText.value = '';
	justEndedComposition.value = true;
}

const pastedFileName = 'yyyy-MM-dd HH-mm-ss [{{number}}]';

async function onPaste(ev: ClipboardEvent) {
	if (props.mock) return;
	if (resolvingLinkedQuote.value || posting.value) { ev.preventDefault(); return; }
	if (ev.clipboardData == null) return;
	if (textareaEl.value == null) return;

	let pastedFiles: File[] = [];
	for (const { item, i } of Array.from(ev.clipboardData.items, (data, x) => ({ item: data, i: x }))) {
		if (item.kind === 'file') {
			const file = item.getAsFile();
			if (!file) continue;
			const lio = file.name.lastIndexOf('.');
			const ext = lio >= 0 ? file.name.slice(lio) : '';
			const formattedName = `${formatTimeString(new Date(file.lastModified), pastedFileName).replace(/{{number}}/g, `${i + 1}`)}${ext}`;
			const renamedFile = new File([file], formattedName, { type: file.type });
			pastedFiles.push(renamedFile);
		}
	}
	if (pastedFiles.length > 0) {
		ev.preventDefault();
		uploader.addFiles(pastedFiles);
		return;
	}

	const paste = ev.clipboardData.getData('text');

	if (!explicitDestinations.value && !pendingCreate.value && !gridspaceQuote.value && !renoteTargetNote.value && !quoteId.value && !replyTargetNote.value && isGridspaceNoteLink(paste.trim())) {
		ev.preventDefault();
		resolvingLinkedQuote.value = true;
		textAreaReadOnly.value = true;
		const current = ++linkedQuoteGeneration;
		const draftState = () => JSON.stringify([text.value, cw.value, useCw.value, withHashtags.value, hashtags.value, poll.value, postAccount.value?.id, scheduledAt.value, destinations.value, targetChannel.value?.id, visibility.value, localOnly.value, noRelay.value, visibleUsers.value.map(u => u.id), files.value.map(f => [f.id, f.name, f.isSensitive, f.comment]), uploader.items.value.map(f => [f.id, f.name, f.caption, f.isSensitive])]);
		const initialState = draftState();
		const unchanged = () => current === linkedQuoteGeneration && !window.document.hidden && !!textareaEl.value?.isConnected && draftState() === initialState;
		try {
			if (postAccount.value || scheduledAt.value || !await isConfiguredGridspaceNoteLink(paste.trim()) || (await os.confirm({ type: 'info', text: i18n.ts.quoteQuestion })).canceled) {
				if (unchanged()) insertTextAtCursor(textareaEl.value!, paste); return;
			}
			if (!unchanged()) return;
			const resolved = await misskeyApi('gridspace/note-link', { url: paste.trim() });
			if (!unchanged()) return;
			const quoteChannel = resolved.note?.channel ?? resolved.localNote?.channel;
			if (quoteChannel && targetChannel.value?.id !== quoteChannel.id) {
				if ((await os.confirm({ type: 'warning', text: i18n.tsx._gridspace.quoteInChannel({ name: quoteChannel.name }) })).canceled) { if (unchanged()) insertTextAtCursor(textareaEl.value!, paste); return; }
				if (!unchanged()) return;
			}
			if (resolved.localNote) {
				if (resolved.localNote.channel) {
					const channel = await misskeyApi('channels/show', { channelId: resolved.localNote.channel.id });
					if (!unchanged()) return;
					targetChannel.value = channel;
					visibility.value = 'public';
					visibleUsers.value = [];
					localOnly.value = true;
				}
				renoteTargetNote.value = resolved.localNote; quoteId.value = resolved.localNote.id;
			} else if (resolved.note?.channelId) {
				// Keep the original draft until the delegated quote is successfully sent.
				// Copy only attachment bytes into the new composer, never a foreign file ID.
				textAreaReadOnly.value = true;
				const copiedText = withHashtags.value && hashtags.value.trim() ? `${text.value}\n${hashtags.value.trim().split(/\s+/).map(tag => tag.startsWith('#') ? tag : `#${tag}`).join(' ')}` : text.value, copiedCw = cw.value, copiedPoll = poll.value;
				const attachedFiles = [...files.value], pendingFiles = [...uploader.items.value];
				const copiedFiles: LinkedQuoteAttachment[] = [];
				if (attachedFiles.length + pendingFiles.length > 16 || attachedFiles.some(file => !file.size || file.size > 16 * 1024 * 1024) || pendingFiles.some(item => item.preprocessing || item.uploading || !(item.preprocessedFile ?? item.file).size || (item.preprocessedFile ?? item.file).size > 16 * 1024 * 1024)) throw new Error('Attachment cannot be transferred');
				for (const file of attachedFiles) {
					if (file.size > 16 * 1024 * 1024) throw new Error('Attachment too large');
					const response = await window.fetch(file.url, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
					if (!response.ok) throw new Error('Attachment unavailable');
					copiedFiles.push({ file: new File([await response.blob()], file.name, { type: file.type }), isSensitive: file.isSensitive, caption: file.comment });
				}
				for (const item of pendingFiles) {
					if (item.preprocessing || item.uploading) throw new Error('Attachment still processing');
					copiedFiles.push({ file: new File([item.preprocessedFile ?? item.file], item.name, { type: item.file.type }), isSensitive: item.isSensitive, caption: item.caption });
				}
				if (!unchanged()) return;
				await gridspacePost({ channelId: resolved.note.channelId, channel: resolved.note.channel ?? undefined, renote: resolved.note,
					initialText: copiedText, initialCw: useCw.value ? copiedCw ?? '' : undefined, initialFiles: copiedFiles, initialPoll: copiedPoll ? { ...copiedPoll, choices: [...copiedPoll.choices] } : null }, () => {
					if (unchanged()) { clear(); deleteDraft(); emit('posted'); }
				});
			} else if (resolved.note && ['public', 'home'].includes(resolved.note.visibility)) {
				const local = await misskeyApi('gridspace/renote-target', { noteId: resolved.note.id });
				if (!unchanged()) return;
				renoteTargetNote.value = local; quoteId.value = local.id;
			} else {
				await os.alert({ type: 'info', text: i18n.ts.cantRenote });
				insertTextAtCursor(textareaEl.value, paste);
			}
		} catch {
			if (unchanged()) {
				await os.alert({ type: 'error', text: i18n.ts.invisibleNote });
				if (unchanged()) insertTextAtCursor(textareaEl.value!, paste);
			}
		} finally { textAreaReadOnly.value = false; resolvingLinkedQuote.value = false; }
		return;
	}

	if (!explicitDestinations.value && !pendingCreate.value && !gridspaceQuote.value && !renoteTargetNote.value && !quoteId.value && paste.startsWith(url + '/notes/')) {
		ev.preventDefault();

		const { canceled } = await os.confirm({
			type: 'info',
			text: i18n.ts.quoteQuestion,
		});

		if (canceled) {
			insertTextAtCursor(textareaEl.value, paste);
			return;
		}

		quoteId.value = paste.substring(url.length).match(/^\/notes\/(.+?)\/?$/)?.[1] ?? null;
	}

	if (paste.length > 1000) {
		ev.preventDefault();

		const { canceled } = await os.confirm({
			type: 'info',
			text: i18n.ts.attachAsFileQuestion,
		});

		if (canceled) {
			insertTextAtCursor(textareaEl.value, paste);
			return;
		}

		const fileName = formatTimeString(new Date(), pastedFileName).replace(/{{number}}/g, '0');
		const file = new File([paste], `${fileName}.txt`, { type: 'text/plain' });
		uploader.addFiles([file]);
	}
}

function onDragover(ev: DragEvent) {
	if (ev.dataTransfer == null) return;
	if (ev.dataTransfer.items[0] == null) return;

	const isFile = ev.dataTransfer.items[0].kind === 'file';
	if (isFile || checkDragDataType(ev, ['driveFiles'])) {
		ev.preventDefault();
		draghover.value = true;
		switch (ev.dataTransfer.effectAllowed) {
			case 'all':
			case 'uninitialized':
			case 'copy':
			case 'copyLink':
			case 'copyMove':
				ev.dataTransfer.dropEffect = 'copy';
				break;
			case 'linkMove':
			case 'move':
				ev.dataTransfer.dropEffect = 'move';
				break;
			default:
				ev.dataTransfer.dropEffect = 'none';
				break;
		}
	}
}

function onDragenter() {
	draghover.value = true;
}

function onDragleave() {
	draghover.value = false;
}

function onDrop(ev: DragEvent): void {
	draghover.value = false;

	// ファイルだったら
	if (ev.dataTransfer && ev.dataTransfer.files.length > 0) {
		ev.preventDefault();
		uploader.addFiles(Array.from(ev.dataTransfer.files));
		return;
	}

	//#region ドライブのファイル
	{
		const droppedData = getDragData(ev, 'driveFiles');
		if (droppedData != null) {
			files.value.push(...droppedData);
			ev.preventDefault();
		}
	}
	//#endregion
}

type StoredDrafts = {
	[key: string]: {
		updatedAt: string;
		ownerId?: string;
		revision?: string;
		data: {
			text: string;
			useCw: boolean;
			cw: string | null;
			visibility: 'public' | 'home' | 'followers' | 'specified';
			localOnly: boolean;
			noRelay?: boolean;
			files: Misskey.entities.DriveFile[];
			poll: PollEditorModelValue | null;
			visibleUserIds?: string[];
			quoteId: string | null;
			gridspaceQuote?: string | null;
			reactionAcceptance: 'likeOnly' | 'likeOnlyForRemote' | 'nonSensitiveOnly' | 'nonSensitiveOnlyForLocalLikeOnlyForRemote' | null;
			scheduledAt: number | null;
			destinations?: NoteDestinations;
			fixedQuoteDestination?: PostFormProps['fixedQuoteDestination'];
			pendingCreate?: PendingNoteCreate | null;
			postAccountId?: string;
			withHashtags?: boolean;
			hashtags?: string;
		};
	};
};

function updatePendingDrafts() {
	if (props.instant || props.mock || props.initialPendingDraftKey || props.reply || props.renote || props.gridspaceQuote) return;
	const drafts = JSON.parse(miLocalStorage.getItem('drafts') ?? '{}') as StoredDrafts;
	otherPendingDrafts.value = Object.keys(drafts).filter(key => key !== draftKey.value && drafts[key].ownerId === $i.id && drafts[key].data.pendingCreate != null);
}

async function openPendingDraft(key: string) {
	updatePendingDrafts();
	if (!otherPendingDrafts.value.includes(key)) return;
	await os.post({ initialPendingDraftKey: key });
	updatePendingDrafts();
}

type DraftData = StoredDrafts[string]['data'];

function readDrafts(): StoredDrafts {
	return JSON.parse(miLocalStorage.getItem('drafts') ?? '{}');
}

function ownedPendingCreate() {
	const draft = readDrafts()[draftKey.value];
	return draft?.ownerId === $i.id ? draft.data.pendingCreate ?? null : null;
}

function writeDrafts(drafts: StoredDrafts) {
	miLocalStorage.setItem('drafts', JSON.stringify(drafts));
}

function snapshotDraft(): DraftData {
	return JSON.parse(JSON.stringify({
		text: text.value, useCw: useCw.value, cw: cw.value, visibility: visibility.value, localOnly: localOnly.value,
		noRelay: noRelay.value || undefined, gridspaceQuote: gridspaceQuote.value ?? undefined,
		files: files.value, poll: poll.value, visibleUserIds: visibleUsers.value.map(user => user.id),
		quoteId: quoteId.value, reactionAcceptance: reactionAcceptance.value, scheduledAt: scheduledAt.value,
		destinations: placementSubmission.value || explicitDestinations.value ? destinations.value : undefined,
		fixedQuoteDestination: fixedQuoteDestination.value,
		postAccountId: postAccount.value?.id ?? missingDraftAccountId.value ?? undefined,
		withHashtags: withHashtags.value, hashtags: hashtags.value,
	}));
}

function draftContent(data: DraftData): string {
	return JSON.stringify({ ...data, pendingCreate: undefined });
}

async function saveDraft(reserve?: PendingNoteCreate, submitted?: DraftData): Promise<boolean> {
	if (props.instant || props.mock || pauseDraftSaving) return false;
	const key = draftKey.value;
	const data = submitted ?? snapshotDraft();
	const content = draftContent(data);
	return await withDraftLock(() => {
		const drafts = readDrafts();
		const previous = drafts[key];
		if (previous?.ownerId && previous.ownerId !== $i.id) return false;
		if (reserve && draftContent(snapshotDraft()) !== content) {
			pendingCreate.value = previous?.data.pendingCreate ?? null;
			return false;
		}
		const previousRequest = previous?.data.pendingCreate;
		const sameContent = previous != null && draftContent(previous.data) === content;
		if (reserve && (previousRequest || (lastDraftRevision != null && (!previous || !sameContent)))) {
			pendingCreate.value = previousRequest ?? null;
			return false;
		}
		const revision = reserve?.clientRequestId ?? (sameContent && previous?.revision ? previous.revision : crypto.randomUUID?.());
		data.pendingCreate = reserve ?? previousRequest ?? null;
		drafts[key] = { ownerId: $i.id, updatedAt: new Date().toISOString(), revision, data };
		writeDrafts(drafts);
		lastDraftRevision = revision;
		return true;
	}, reserve != null);
}

async function updateRequestDraft(request: PendingNoteCreate, update: (latest: StoredDrafts[string]) => 'keep' | 'delete' | 'skip'): Promise<boolean> {
	const key = draftKey.value;
	return await withDraftLock(() => {
		const drafts = readDrafts();
		const latest = drafts[key];
		if (latest?.ownerId !== $i.id || latest.data.pendingCreate?.clientRequestId !== request.clientRequestId) return false;
		const change = update(latest);
		if (change === 'skip') return false;
		if (change === 'delete') delete drafts[key];
		writeDrafts(drafts);
		lastDraftRevision = drafts[key]?.revision;
		return true;
	}, true);
}

async function finishPendingDraft(request: PendingNoteCreate) {
	await updateRequestDraft(request, latest => {
		if (latest.revision === request.clientRequestId) return 'delete';
		latest.data.pendingCreate = null;
		return 'keep';
	});
}

async function releaseRejectedCreate(request: PendingNoteCreate, error: unknown, token?: string) {
	const status = getApiErrorStatus(error);
	if (status == null || status < 400 || status >= 500 || !error || typeof error !== 'object' ||
		!('kind' in error) || (error.kind !== 'client' && error.kind !== 'permission')) return;
	const receipt = await misskeyApi('notes/create-status', { clientRequestId: request.clientRequestId }, token, AbortSignal.timeout(20000)).catch(() => null);
	if (receipt?.status !== 'missing') return;
	const released = await updateRequestDraft(request, latest => {
		// A retry in another tab could still commit after our first attempt was rejected.
		if (latest.data.pendingCreate?.retried) return 'skip';
		latest.data.pendingCreate = null;
		return 'keep';
	});
	if (released) pendingCreate.value = null;
}

async function deleteDraft() {
	const key = draftKey.value;
	await withDraftLock(() => {
		const drafts = readDrafts();
		if (drafts[key]?.data.pendingCreate || (drafts[key]?.ownerId && drafts[key].ownerId !== $i.id)) return;
		delete drafts[key];
		writeDrafts(drafts);
		lastDraftRevision = undefined;
	});
}

function allowServerDraft() {
	if (!relayDeliveryDisabled.value) return true;
	void os.alert({ type: 'info', text: i18n.ts._postForm.noRelayServerDraft });
	return false;
}

async function saveServerDraft(options: {
	isActuallyScheduled?: boolean;
} = {}) {
	if (!allowServerDraft()) return;
	return await os.apiWithDialog(serverDraftId.value == null ? 'notes/drafts/create' : 'notes/drafts/update', {
		...(serverDraftId.value == null ? {} : { draftId: serverDraftId.value }),
		text: text.value,
		cw: useCw.value ? cw.value || null : null,
		visibility: visibility.value,
		localOnly: effectiveLocalOnly.value,
		hashtag: hashtags.value,
		fileIds: files.value.map(f => f.id),
		poll: poll.value,
		visibleUserIds: visibleUsers.value.map(x => x.id),
		renoteId: renoteTargetNote.value ? renoteTargetNote.value.id : quoteId.value ? quoteId.value : null,
		gridspaceQuote: gridspaceQuote.value,
		replyId: replyTargetNote.value ? replyTargetNote.value.id : null,
		channelId: serverDraftChannel.value,
		reactionAcceptance: reactionAcceptance.value,
		scheduledAt: scheduledAt.value,
		isActuallyScheduled: options.isActuallyScheduled ?? false,
	});
}

function isAnnoying(text: string): boolean {
	return text.includes('$[x2') ||
		text.includes('$[x3') ||
		text.includes('$[x4') ||
		text.includes('$[scale') ||
		text.includes('$[position');
}

async function uploadFiles() {
	await uploader.upload();

	for (const uploadedItem of uploader.items.value.filter(x => x.uploaded != null)) {
		files.value.push(uploadedItem.uploaded!);
		uploader.removeItem(uploadedItem);
	}
}

async function post(ev?: PointerEvent) {
	if (preparing.value || posting.value || !canPost.value) return;
	preparing.value = true;
	try {
		pendingCreate.value ??= await withDraftLock(ownedPendingCreate);
		if (pendingCreate.value) {
			await recoverPendingResult(true);
		} else {
			await sendPost(ev);
		}
	} catch (error) {
		await os.alert({ type: 'error', text: error instanceof Error ? error.message : i18n.ts.somethingHappened });
	} finally {
		preparing.value = false;
	}
}

async function sendPost(ev?: PointerEvent) {
	if (ev != null) {
		const el = (ev.currentTarget ?? ev.target) as HTMLElement | null;

		if (el && prefer.s.animation) {
			const rect = el.getBoundingClientRect();
			const x = rect.left + (el.offsetWidth / 2);
			const y = rect.top + (el.offsetHeight / 2);
			const { dispose } = os.popup(MkRippleEffect, { x, y }, {
				end: () => dispose(),
			});
		}
	}

	if (scheduledAt.value != null) {
		if (!allowServerDraft()) return;
		if (uploader.items.value.some(x => x.uploaded == null)) {
			await uploadFiles();

			// アップロード失敗したものがあったら中止
			if (uploader.items.value.some(x => x.uploaded == null)) {
				return;
			}
		}

		if (await postAsScheduled()) clear();
		return;
	}

	if (props.mock) return;

	if (visibility.value === 'public' && (
		(useCw.value && cw.value != null && cw.value.trim() !== '' && isAnnoying(cw.value)) || // CWが迷惑になる場合
		((!useCw.value || cw.value == null || cw.value.trim() === '') && text.value != null && text.value.trim() !== '' && isAnnoying(text.value)) // CWが無い かつ 本文が迷惑になる場合
	)) {
		const { canceled, result } = await os.actions({
			type: 'warning',
			text: i18n.ts.thisPostMayBeAnnoying,
			actions: [...(fixedQuoteDestination.value ? [] : [{
				value: 'home',
				text: i18n.ts.thisPostMayBeAnnoyingHome,
				primary: true,
			}]), {
				value: 'cancel',
				text: i18n.ts.thisPostMayBeAnnoyingCancel,
			}, {
				value: 'ignore',
				text: i18n.ts.thisPostMayBeAnnoyingIgnore,
			}],
		});

		if (canceled) return;
		if (result === 'cancel') return;
		if (result === 'home') {
			if (fixedQuoteDestination.value) return;
			visibility.value = 'home';
		}
	}

	if (placementSubmission.value && !canUseDestinations(destinations.value, visibility.value)) return;

	if (uploader.items.value.some(x => x.uploaded == null)) {
		await uploadFiles();

		// アップロード失敗したものがあったら中止
		if (uploader.items.value.some(x => x.uploaded == null)) {
			return;
		}
	}

	const submittedDraft = hasPlacements.value ? snapshotDraft() : null;
	const skipRelays = relayDeliveryDisabled.value;
	let postData = {
		text: text.value === '' ? null : text.value,
		fileIds: files.value.length > 0 ? files.value.map(f => f.id) : undefined,
		replyId: replyTargetNote.value ? replyTargetNote.value.id : undefined,
		renoteId: renoteTargetNote.value ? renoteTargetNote.value.id : quoteId.value ? quoteId.value : undefined,
		gridspaceQuote: gridspaceQuote.value,
		channelId: !placementSubmission.value ? targetChannel.value?.id : undefined,
		poll: poll.value,
		cw: useCw.value ? cw.value ?? '' : null,
		localOnly: visibility.value === 'specified' ? false : effectiveLocalOnly.value,
		noRelay: skipRelays,
		visibility: visibility.value,
		visibleUserIds: visibility.value === 'specified' ? visibleUsers.value.map(u => u.id) : undefined,
		reactionAcceptance: reactionAcceptance.value,
	};

	if (withHashtags.value && hashtags.value && hashtags.value.trim() !== '') {
		const hashtags_ = hashtags.value.trim().split(' ').map(x => x.startsWith('#') ? x : '#' + x).join(' ');
		if (!postData.text) {
			postData.text = hashtags_;
		} else {
			const postTextLines = postData.text.split('\n');
			if (postTextLines[postTextLines.length - 1].trim() === '') {
				postTextLines[postTextLines.length - 1] += hashtags_;
			} else {
				postTextLines[postTextLines.length - 1] += ' ' + hashtags_;
			}
			postData.text = postTextLines.join('\n');
		}
	}

	// plugin
	const notePostInterruptors = getPluginHandlers('note_post_interruptor');
	if (notePostInterruptors.length > 0) {
		for (const interruptor of notePostInterruptors) {
			try {
				postData = await interruptor.handler(deepClone(postData)) as typeof postData;
			} catch (err) {
				console.error(err);
			}
		}
	}

	if (skipRelays) postData = { ...postData, noRelay: true };

	let token: string | undefined = undefined;

	if (postAccount.value) {
		const storedAccounts = await getAccounts();
		const storedAccount = storedAccounts.find(x => x.host === host && x.id === postAccount.value?.id);
		if (storedAccount && storedAccount.token != null) {
			token = storedAccount.token;
		} else {
			await os.alert({
				type: 'error',
				text: 'cannot find the token of the selected account.',
			});
			return;
		}
	}

	const accountId = postAccount.value?.id ?? $i.id;
	if (placementsUnavailable.value) throw new Error(i18n.ts._multiNote.placementsUnavailable);
	let placementRequest: Misskey.entities.NotesCreateRequest | undefined;
	if (submittedDraft?.destinations) {
		if (!hasPlacements.value || draftContent(submittedDraft) !== draftContent(snapshotDraft())) return;
		const input = { ...postData, ...placementParams(submittedDraft.destinations, localOrigin) };
		pendingCreate.value = await startNoteCreate(accountId, input, await noteInputHash(submittedDraft));
		if (!await saveDraft(pendingCreate.value, submittedDraft)) {
			throw new Error(i18n.ts._multiNote.otherRequest);
		}
		placementRequest = { ...pendingCreate.value.input, clientRequestId: pendingCreate.value.clientRequestId };
	} else if (explicitDestinations.value) {
		return;
	}

	posting.value = true;
	await misskeyApi('notes/create', placementRequest ?? postData, token, placementRequest ? AbortSignal.timeout(30000) : undefined).then(async (res) => {
		const completedRequest = pendingCreate.value;
		if (completedRequest) await finishPendingDraft(completedRequest);
		const unchanged = !completedRequest || completedRequest.draftSnapshot === await currentDraftHash();
		pauseDraftSaving = completedRequest != null && unchanged;
		pendingCreate.value = null;
		if (unchanged) {
			if (props.freezeAfterPosted) posted.value = true;
			else clear();
		}

		globalEvents.emit('notePosted', res.createdNote);
		void showPlacementResult(res.createdNote);

		nextTick(() => {
			if (!completedRequest) void deleteDraft();
			if (unchanged) emit('posted');
			if (postData.text && postData.text !== '') {
				const hashtags_ = mfm.parse(postData.text).map(x => x.type === 'hashtag' && x.props.hashtag).filter(x => x) as string[];
				const history = JSON.parse(miLocalStorage.getItem('hashtags') ?? '[]') as string[];
				miLocalStorage.setItem('hashtags', JSON.stringify(unique(hashtags_.concat(history))));
			}
			posting.value = false;
			if (unchanged) postAccount.value = null;
			nextTick(() => { pauseDraftSaving = false; });

			incNotesCount();
			if (notesCount === 1) {
				claimAchievement('notes1');
			}

			const text = postData.text ?? '';
			const lowerCase = text.toLowerCase();
			if ((lowerCase.includes('love') || lowerCase.includes('❤')) && lowerCase.includes('misskey')) {
				claimAchievement('iLoveMisskey');
			}
			if ([
				'https://youtu.be/Efrlqw8ytg4',
				'https://www.youtube.com/watch?v=Efrlqw8ytg4',
				'https://m.youtube.com/watch?v=Efrlqw8ytg4',

				'https://youtu.be/XVCwzwxdHuA',
				'https://www.youtube.com/watch?v=XVCwzwxdHuA',
				'https://m.youtube.com/watch?v=XVCwzwxdHuA',

				'https://open.spotify.com/track/3Cuj0mZrlLoXx9nydNi7RB',
				'https://open.spotify.com/track/7anfcaNPQWlWCwyCHmZqNy',
				'https://open.spotify.com/track/5Odr16TvEN4my22K9nbH7l',
				'https://open.spotify.com/album/5bOlxyl4igOrp2DwVQxBco',
			].some(url => text.includes(url))) {
				claimAchievement('brainDiver');
			}

			if (renoteTargetNote.value && (renoteTargetNote.value.userId === $i.id) && text.length > 0) {
				claimAchievement('selfQuote');
			}

			const date = new Date();
			const h = date.getHours();
			const m = date.getMinutes();
			const s = date.getSeconds();
			if (h >= 0 && h <= 3) {
				claimAchievement('postedAtLateNight');
			}
			if (m === 0 && s === 0) {
				claimAchievement('postedAt0min0sec');
			}

			if (serverDraftId.value != null) {
				misskeyApi('notes/drafts/delete', { draftId: serverDraftId.value });
			}
		});
	}).catch(async err => {
		posting.value = false;
		if (placementRequest && pendingCreate.value) await releaseRejectedCreate(pendingCreate.value, err, token);
		os.alert({
			type: 'error',
			text: err.message + '\n' + (err as any).id,
		});
	});
}

async function postAsScheduled() {
	if (props.mock || explicitDestinations.value || pendingCreate.value) return;

	return await saveServerDraft({
		isActuallyScheduled: true,
	});
}

function cancel() {
	emit('cancel');
}

function insertMention() {
	os.selectUser({ localOnly: localOnly.value, includeSelf: true }).then(user => {
		if (textareaEl.value == null) return;
		insertTextAtCursor(textareaEl.value, '@' + Misskey.acct.toString(user) + ' ');
	});
}

async function insertEmoji(ev: PointerEvent) {
	textAreaReadOnly.value = true;
	const target = ev.currentTarget ?? ev.target;
	if (target == null) return;

	// emojiPickerはダイアログが閉じずにtextareaとやりとりするので、
	// focustrapをかけているとinsertTextAtCursorが効かない
	// そのため、投稿フォームのテキストに直接注入する
	// See: https://github.com/misskey-dev/misskey/pull/14282
	//      https://github.com/misskey-dev/misskey/issues/14274

	let pos = textareaEl.value?.selectionStart ?? 0;
	let posEnd = textareaEl.value?.selectionEnd ?? text.value.length;
	emojiPicker.show(
		target as HTMLElement,
		emoji => {
			const textBefore = text.value.substring(0, pos);
			const textAfter = text.value.substring(posEnd);
			text.value = textBefore + emoji + textAfter;
			pos += emoji.length;
			posEnd += emoji.length;
		},
		() => {
			textAreaReadOnly.value = false;
			nextTick(() => {
				if (textareaEl.value) {
					textareaEl.value.focus();
					textareaEl.value.setSelectionRange(pos, posEnd);
				}
			});
		},
	);
}

async function insertMfmFunction(ev: PointerEvent) {
	if (textareaEl.value == null) return;
	let pos = textareaEl.value.selectionStart ?? 0;
	let posEnd = textareaEl.value.selectionEnd ?? text.value.length;
	mfmFunctionPicker(
		ev.currentTarget ?? ev.target,
		(tag) => {
			if (pos === posEnd) {
				text.value = `${text.value.substring(0, pos)}$[${tag} ]${text.value.substring(pos)}`;
				pos += tag.length + 3;
				posEnd = pos;
			} else {
				text.value = `${text.value.substring(0, pos)}$[${tag} ${text.value.substring(pos, posEnd)}]${text.value.substring(posEnd)}`;
				pos += tag.length + 3;
				posEnd = pos;
			}
		},
		() => {
			nextTick(() => {
				if (textareaEl.value) {
					textareaEl.value.focus();
					textareaEl.value.setSelectionRange(pos, posEnd);
				}
			});
		},
	);
}

function showActions(ev: PointerEvent) {
	os.popupMenu(postFormActions.map(action => ({
		text: action.title,
		action: () => {
			action.handler({
				text: text.value,
				cw: cw.value,
			}, (key, value) => {
				if (typeof key !== 'string' || typeof value !== 'string') return;
				if (key === 'text') { text.value = value; }
				if (key === 'cw') { useCw.value = value !== null; cw.value = value; }
			});
		},
	})), ev.currentTarget ?? ev.target);
}

async function currentDraftHash(): Promise<string> {
	return await noteInputHash(snapshotDraft());
}

async function showPlacementResult(note: Misskey.entities.Note): Promise<boolean> {
	if (note.multiNoteKind !== 'root') return false;
	const placements = note.channelPlacements ?? [];
	if (!note.channelPlacementsUnavailable && placements.length && placements.every(item => item.state === 'active')) return false;
	const { canceled, result } = await os.actions({
		type: 'info',
		text: i18n.ts._multiNote.checkPlacements,
		actions: [{ value: 'open', text: i18n.ts._multiNote.openNote, primary: true }, { value: 'close', text: i18n.ts.close }],
	});
	if (!canceled && result === 'open') os.pageWindow(`/notes/${note.id}`);
	return true;
}

async function recoverPendingResult(retryMissing = false): Promise<boolean> {
	const pending = pendingCreate.value;
	if (!pending) return false;
	const token = pending.accountId === $i.id ? undefined : (await getAccounts()).find(account => account.host === host && account.id === pending.accountId)?.token;
	if (pending.accountId !== $i.id && !token) throw new Error(i18n.ts._multiNote.accountUnavailable);
	let result = await recoverNoteCreate<Misskey.entities.Note>(pending, clientRequestId => misskeyApi('notes/create-status', { clientRequestId }, token, AbortSignal.timeout(20000)), currentDraftHash);
	if (!result) {
		if (!retryMissing || !pending.input) return false;
		if (!instance.features?.multiNote || (pending.input.channelTargets?.length && !instance.features.multiNotePeer)) throw new Error(i18n.ts._multiNote.placementsUnavailable);
		if (await noteInputHash(pending.input) !== pending.inputHash) throw new Error(i18n.ts._multiNote.pendingCreate);
		const unchanged = pending.draftSnapshot === await currentDraftHash();
		if (!unchanged && (await os.confirm({ type: 'question', text: i18n.ts._multiNote.retryOriginal })).canceled) return false;
		const canRetry = await updateRequestDraft(pending, latest => {
			latest.data.pendingCreate!.retried = true;
			return 'keep';
		});
		if (!canRetry) {
			pendingCreate.value = ownedPendingCreate();
			return false;
		}
		const { createdNote } = await misskeyApi('notes/create', { ...pending.input, clientRequestId: pending.clientRequestId }, token, AbortSignal.timeout(30000));
		result = { status: 'created', createdNote, clearDraft: pending.draftSnapshot === await currentDraftHash() };
	}
	const unchanged = result.clearDraft;
	await finishPendingDraft(pending);
	pendingCreate.value = null;
	if (unchanged) {
		pauseDraftSaving = true;
		clear();
		await nextTick();
		pauseDraftSaving = false;
	}
	if (result.createdNote) globalEvents.emit('notePosted', result.createdNote);
	if (!result.createdNote || !await showPlacementResult(result.createdNote)) {
		await os.alert({ type: 'info', text: result.status === 'deleted' ? i18n.ts._multiNote.deleted : i18n.ts._multiNote.confirmed });
	}
	if (unchanged) emit('posted');
	return true;
}

async function recoverPending() {
	if (preparing.value || posting.value) return;
	preparing.value = true;
	try {
		await recoverPendingResult();
	} catch {
		await os.alert({ type: 'error', text: i18n.ts._multiNote.pendingCreate });
	} finally {
		preparing.value = false;
	}
}

async function openAccountMenu(ev: PointerEvent) {
	if (props.mock || pendingCreate.value || preparing.value || posting.value) return;

	function showDraftsDialog(scheduled: boolean) {
		const { dispose } = os.popup(defineAsyncComponent(() => import('@/components/MkNoteDraftsDialog.vue')), {
			scheduled,
		}, {
			restore: async (draft: Misskey.entities.NoteDraft) => {
				text.value = draft.text ?? '';
				useCw.value = draft.cw != null;
				cw.value = draft.cw ?? null;
				visibility.value = draft.visibility;
				localOnly.value = draft.localOnly ?? false;
				noRelay.value = false;
				files.value = draft.files ?? [];
				hashtags.value = draft.hashtag ?? '';
				if (draft.hashtag) withHashtags.value = true;
				if (draft.poll) {
					// 投票を一時的に空にしないと反映されないため
					poll.value = null;
					nextTick(() => {
						poll.value = {
							choices: draft.poll!.choices,
							multiple: draft.poll!.multiple,
							expiresAt: draft.poll!.expiresAt ? (new Date(draft.poll!.expiresAt)).getTime() : null,
							expiredAfter: null,
						};
					});
				}
				visibleUsers.value = [];
				if (draft.visibleUserIds != null && draft.visibleUserIds.length > 0) {
					misskeyApi('users/show', { userIds: draft.visibleUserIds }).then(users => {
						users.forEach(u => pushVisibleUser(u));
					});
				}
				quoteId.value = draft.renoteId ?? null;
				gridspaceQuote.value = draft.gridspaceQuote ?? null;
				renoteTargetNote.value = draft.renote;
				replyTargetNote.value = draft.reply;
				reactionAcceptance.value = draft.reactionAcceptance;
				scheduledAt.value = draft.scheduledAt ?? null;
				keepDestinationSelection.value = false;
				targetChannel.value = draft.channel as PostFormProps['channel'];
				destinations.value = initialDestinations(draft.channel ? { origin: localOrigin, channelId: draft.channel.id, name: draft.channel.name, color: draft.channel.color } : null);

				serverDraftId.value = draft.id;
			},
			cancel: () => {

			},
			closed: () => {
				dispose();
			},
		});
	}

	const items = await getAccountMenu({
		withExtraOperation: false,
		includeCurrentAccount: true,
		active: postAccount.value != null ? postAccount.value.id : $i.id,
		onChoose: (account) => {
			missingDraftAccountId.value = null;
			if (account.id === $i.id) {
				postAccount.value = null;
			} else {
				postAccount.value = account;
			}
		},
	});

	os.popupMenu([{
		type: 'button',
		text: i18n.ts._drafts.listDrafts,
		icon: 'ti ti-cloud-download',
		action: () => {
			showDraftsDialog(false);
		},
	}, {
		type: 'button',
		text: i18n.ts._drafts.listScheduledNotes,
		icon: 'ti ti-clock-down',
		action: () => {
			showDraftsDialog(true);
		},
	}, { type: 'divider' }, ...items], (ev.currentTarget ?? ev.target ?? undefined) as HTMLElement | undefined);
}

function showPerUploadItemMenu(item: UploaderItem, ev: PointerEvent) {
	const menu = uploader.getMenu(item);
	os.popupMenu(menu, ev.currentTarget ?? ev.target);
}

function showPerUploadItemMenuViaContextmenu(item: UploaderItem, ev: PointerEvent) {
	const menu = uploader.getMenu(item);
	os.contextMenu(menu, ev);
}

async function schedule() {
	if (explicitDestinations.value || pendingCreate.value) return;
	if (!allowServerDraft()) return;
	const { canceled, result } = await os.inputDatetime({
		title: i18n.ts.schedulePost,
	});
	if (canceled) return;
	if (result.getTime() <= Date.now() || explicitDestinations.value || pendingCreate.value) return;

	scheduledAt.value = result.getTime();
}

function cancelSchedule() {
	scheduledAt.value = null;
}

function showTour() {
	if (textareaEl.value == null ||
		footerEl.value == null ||
		accountMenuEl.value == null ||
		visibilityButton.value == null ||
		otherSettingsButton.value == null ||
		submitButtonEl.value == null) {
		return;
	}

	startTour([{
		element: textareaEl.value,
		title: i18n.ts._postForm._howToUse.content_title,
		description: i18n.ts._postForm._howToUse.content_description,
	}, {
		element: footerEl.value,
		title: i18n.ts._postForm._howToUse.toolbar_title,
		description: i18n.ts._postForm._howToUse.toolbar_description,
	}, {
		element: accountMenuEl.value,
		title: i18n.ts._postForm._howToUse.account_title,
		description: i18n.ts._postForm._howToUse.account_description,
	}, {
		element: visibilityButton.value,
		title: i18n.ts._postForm._howToUse.visibility_title,
		description: i18n.ts._postForm._howToUse.visibility_description,
	}, {
		element: otherSettingsButton.value,
		title: i18n.ts._postForm._howToUse.menu_title,
		description: i18n.ts._postForm._howToUse.menu_description,
	}, {
		element: submitButtonEl.value,
		title: i18n.ts._postForm._howToUse.submit_title,
		description: i18n.ts._postForm._howToUse.submit_description,
	}]).then(() => {
		closeTip('postForm');
	});
}

onMounted(() => {
	updatePendingDrafts();
	window.addEventListener('storage', updatePendingDrafts);
	window.addEventListener('focus', updatePendingDrafts);
	if (props.autofocus) {
		focus();

		nextTick(() => {
			focus();
		});
	}

	if (textareaEl.value) textAutocomplete = new Autocomplete(textareaEl.value, text);
	if (cwInputEl.value) cwAutocomplete = new Autocomplete(cwInputEl.value, cw);
	if (hashtagsInputEl.value) hashtagAutocomplete = new Autocomplete(hashtagsInputEl.value, hashtags);

	nextTick(() => {
		// 書きかけの投稿を復元
		if (!props.instant && !props.mock) {
			const draft = JSON.parse(miLocalStorage.getItem('drafts') ?? '{}')[draftKey.value] as StoredDrafts[string] | undefined;
			if (draft != null && (draft.ownerId === $i.id || (!draft.ownerId && !props.initialPendingDraftKey && !draft.data.pendingCreate)) && ((!props.mention && !props.specified) || draft.data.pendingCreate)) {
				lastDraftRevision = draft.revision;
				text.value = draft.data.text;
				useCw.value = draft.data.useCw;
				cw.value = draft.data.cw;
				visibility.value = draft.data.visibility;
				localOnly.value = draft.data.localOnly;
				noRelay.value = draft.data.noRelay ?? false;
				files.value = (draft.data.files || []).filter(draftFile => draftFile);
				if (draft.data.poll) {
					poll.value = draft.data.poll;
				}
				if (draft.data.visibleUserIds?.length) {
					misskeyApi('users/show', { userIds: draft.data.visibleUserIds }).then(users => {
						users.forEach(u => pushVisibleUser(u));
					});
				}
				quoteId.value = draft.data.quoteId;
				gridspaceQuote.value = draft.data.gridspaceQuote ?? null;
				reactionAcceptance.value = draft.data.reactionAcceptance;
				scheduledAt.value = draft.data.scheduledAt ?? null;
				fixedQuoteDestination.value = draft.data.fixedQuoteDestination ?? props.fixedQuoteDestination;
				if (draft.data.destinations) {
					destinations.value = draft.data.destinations;
					keepDestinationSelection.value = draft.data.destinations.channels.length > 0 || !draft.data.destinations.includeDefault;
				}
				pendingCreate.value = draft.data.pendingCreate ?? null;
				if (draft.data.postAccountId) {
					postAccount.value = store.s.accountInfos[host + '/' + draft.data.postAccountId] ?? null;
					if (!postAccount.value) missingDraftAccountId.value = draft.data.postAccountId;
				}
			}
		}

		// 削除して編集
		if (props.initialNote) {
			const init = props.initialNote;
			gridspaceQuote.value = init.gridspaceQuote ?? null;
			if (init.multiNoteKind === 'root') {
				keepDestinationSelection.value = true;
				destinations.value = { includeDefault: init.includeDefault === true, channels: (init.channelPlacements ?? [])
					.filter(item => item.state === 'active' || item.state === 'pending' || item.state === 'failed')
					.map(({ origin, channelId, color, name }) => ({ origin, channelId, color, name })) };
			}
			text.value = init.text ? init.text : '';
			useCw.value = init.cw != null;
			cw.value = init.cw ?? null;
			visibility.value = init.visibility;
			localOnly.value = init.localOnly ?? false;
			noRelay.value = init.noRelay ?? false;
			files.value = init.files ?? [];
			if (init.poll) {
				poll.value = {
					choices: init.poll.choices.map(x => x.text),
					multiple: init.poll.multiple,
					expiresAt: init.poll.expiresAt ? (new Date(init.poll.expiresAt)).getTime() : null,
					expiredAfter: null,
				};
			}
			if (init.visibleUserIds) {
				misskeyApi('users/show', { userIds: init.visibleUserIds }).then(users => {
					users.forEach(u => pushVisibleUser(u));
				});
			}
			quoteId.value = renoteTargetNote.value ? renoteTargetNote.value.id : null;
			reactionAcceptance.value = init.reactionAcceptance;
		}

		nextTick(() => {
			watchForDraft();
			if (pendingCreate.value) void recoverPending();
		});
	});
});

onBeforeUnmount(() => {
	window.removeEventListener('storage', updatePendingDrafts);
	window.removeEventListener('focus', updatePendingDrafts);
	uploader.abortAll();
	if (textAutocomplete) {
		textAutocomplete.detach();
	}
	if (cwAutocomplete) {
		cwAutocomplete.detach();
	}
	if (hashtagAutocomplete) {
		hashtagAutocomplete.detach();
	}
});

async function canClose() {
	if (!uploader.allItemsUploaded.value) {
		const { canceled } = await os.confirm({
			type: 'question',
			text: i18n.ts._postForm.quitInspiteOfThereAreUnuploadedFilesConfirm,
			okText: i18n.ts.yes,
			cancelText: i18n.ts.no,
		});
		if (canceled) return false;
	}

	return true;
}

defineExpose({
	clear,
	abortUploader: () => uploader.abortAll(),
	canClose,
});
</script>

<style lang="scss" module>
@use './post-form.scss';
</style>
