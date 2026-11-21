<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="!deleted && !hideByPlugin" ref="article" :class="[$style.note, { [$style.detailed]: detailed, [$style.renoteWrapper]: !quotePreview && isPureRenote && note.renote, [$style.nested]: nested }]" data-gridspace-private-note>
	<template v-if="!quotePreview && isPureRenote && note.renote">
		<div :class="$style.renoteHeader">
			<MkNoteChannel v-if="channel" :channel="channel" display="bar" compact/>
			<MkAvatar :user="displayAuthor" :class="$style.renoteAvatar" link/>
			<i class="ti ti-repeat"></i>
			<I18n :src="i18n.ts.renotedBy" tag="span"><template #user><MkUserName :user="displayAuthor"/></template></I18n>
			<button v-if="!readOnly" class="_button" :class="$style.renoteMenu" :aria-label="i18n.ts.more" @click="showMenu"><i class="ti ti-dots"></i> <MkTime :time="note.createdAt"/></button>
		</div>
		<MkGridspacePrivateNote :note="note.renote" :readOnly="readOnly" :detailed="detailed" compactTop nested @unavailable="emit('unavailable')" @replied="emit('replied')"/>
	</template>
	<MkGridspaceReferenceRenote v-else-if="!readOnly && !quotePreview && isGridspaceReferenceRenote(note)" :note="{ user: displayAuthor, createdAt: note.createdAt, gridspaceQuote: note.gridspaceQuote, visibility: headerNote.visibility, localOnly: note.localOnly, channel, multiNoteKind: note.multiNoteKind, channelPlacements: note.channelPlacements }" :detailed="detailed" @menu="showMenu"/>
	<MkNoteSimple v-else-if="quotePreview" :note="null">
		<template #avatar="{ avatarClass }"><MkAvatar :class="avatarClass" :user="displayAuthor" link :preview="false"/></template>
		<template #header="{ headerClass }"><MkNoteHeader :class="headerClass" :note="headerNote" :mini="true" :noteUrl="readOnly ? note.uri : noteLink(note.id)" :externalNoteUrl="readOnly" :userPreview="`@${displayAuthor.username}${displayAuthor.host ? `@${displayAuthor.host}` : ''}`"/></template>
		<p v-if="displayNote.cw != null" :class="$style.quoteCw">
			<Mfm v-if="displayNote.cw" :text="displayNote.cw" :author="displayAuthor" :emojiUrls="displayNote.emojis ?? {}"/>
			<MkCwButton v-model="expanded" :text="displayNote.text" :files="note.files" :poll="note.poll ? { ...note.poll, choices: note.poll.choices.map(choice => ({ ...choice, isVoted: choice.isVoted === true })) } : null"/>
		</p>
		<div v-if="displayNote.cw == null || expanded" :class="[$style.quoteContent, { [$style.quoteCollapsed]: quoteLong && quoteCollapsed }]">
			<div>
				<MkA v-if="!readOnly && note.replyId" :to="noteLink(note.replyId)" :aria-label="i18n.ts.reply"><i class="ti ti-arrow-back-up"></i></MkA>
				<span v-if="isUnavailableGridspaceNote(note, true)"><i class="ti ti-lock"></i> {{ i18n.ts._gridspace.unavailableNote }}</span>
				<MkNoteText v-else :text="displayNote.text ?? ''" :author="displayAuthor" :emojiUrls="displayNote.emojis ?? {}"/>
				<MkA v-if="!readOnly && note.renoteId" :to="noteLink(note.renoteId)">{{ i18n.ts.quote }}</MkA>
			</div>
			<details v-if="note.files.length" :key="`${note.id}:files`" :open="quoteFilesExpanded" @toggle="toggleQuoteFiles">
				<summary>({{ i18n.tsx.withNFiles({ n: note.files.length }) }})</summary>
				<MkMediaList v-if="quoteFilesExpanded && media.length" :mediaList="media" :raw="true" :ephemeral="!directMedia"/>
				<MkButton v-for="file in note.files.filter(item => !directMedia && !blobs[item.id])" :key="file.id" small :disabled="loading === file.id" @click="loadFile(file.id)">
					<i :class="file.isSensitive ? 'ti ti-eye-exclamation' : 'ti ti-photo'"></i> {{ file.isSensitive ? i18n.ts.sensitive : i18n.ts.clickToShow }}: {{ file.name }}
				</MkButton>
				<p v-if="error" role="alert">{{ i18n.ts._gridspace.privateFileError }}</p>
			</details>
			<details v-if="note.poll" :key="`${note.id}:poll`" :open="quotePollExpanded" @toggle="quotePollExpanded = ($event.target as HTMLDetailsElement).open">
				<summary>{{ i18n.ts.poll }}</summary>
				<MkPoll v-if="quotePollExpanded && readOnly" :noteId="note.id" :choices="note.poll.choices.map(choice => ({ ...choice, isVoted: false }))" :multiple="note.poll.multiple" :expiresAt="note.poll.expiresAt" :emojiUrls="note.emojis" readOnly/>
				<MkGridspaceNoteActions v-else-if="quotePollExpanded" :note="note" compact pollOnly @changed="updated = $event" @unavailable="emit('unavailable')"/>
			</details>
			<button v-if="quoteLong" class="_button" :class="$style.quoteExpand" @click="quoteCollapsed = !quoteCollapsed">{{ quoteCollapsed ? i18n.ts.showMore : i18n.ts.showLess }}</button>
		</div>
	</MkNoteSimple>
	<component :is="detailed ? MkNoteDetailedArticle : MkNoteArticle" v-else :user="displayAuthor" :channel="channel" :placements="note.multiNoteKind === 'root' ? note.channelPlacements : undefined" :channelTo="channel ? `/gridspace/channels/${channel.id}` : undefined" :showChannelLink="!inChannel" :avatarPreview="false" :stickyAvatar="prefer.s.useStickyIcons" :compactTop="compactTop" :dense="dense" :footerOnHover="prefer.s.showNoteActionsOnlyHover">
		<template #header>
			<MkNoteDetailedHeader v-if="detailed" :user="displayAuthor" :visibility="headerNote.visibility" :localOnly="note.localOnly" :noRelay="note.noRelay" :preview="false"><MkInstanceTicker v-if="showTicker" :host="displayAuthor.host" :instance="displayAuthor.instance"/></MkNoteDetailedHeader>
			<MkNoteHeader v-else :note="headerNote" :noteUrl="readOnly ? note.uri : noteLink(note.id)" :externalNoteUrl="readOnly" :userPreview="`@${displayAuthor.username}${displayAuthor.host ? `@${displayAuthor.host}` : ''}`"/>
			<MkInstanceTicker v-if="showTicker && !detailed" :host="displayAuthor.host" :instance="displayAuthor.instance"/>
		</template>
		<MkNotePlacements v-if="note.multiNoteKind === 'root'" :placements="note.channelPlacements" :unavailable="note.channelPlacementsUnavailable" :includeDefault="note.includeDefault"/>
		<div v-if="!readOnly && note.replyId" :class="$style.parentLinks"><MkA :to="noteLink(note.replyId)"><i class="ti ti-arrow-back-up"></i> {{ i18n.ts._gridspace.privateReply }}</MkA></div>
		<MkNoteCw v-if="displayNote.cw != null" v-model="expanded" :cw="displayNote.cw" :text="displayNote.text" :author="displayNote.author" :emojiUrls="displayNote.emojis ?? {}" :files="note.files" :poll="note.poll ? { ...note.poll, choices: note.poll.choices.map(choice => ({ ...choice, isVoted: choice.isVoted === true })) } : null"/>
		<div v-if="displayNote.cw == null || expanded" :class="$style.body"><span v-if="isUnavailableGridspaceNote(note, true)"><i class="ti ti-lock"></i> {{ i18n.ts._gridspace.unavailableNote }}</span><MkNoteText v-else :text="translation?.text ?? displayNote.text ?? ''" :author="displayNote.author" :emojiUrls="displayNote.emojis ?? {}"/></div>
		<div v-if="note.renoteId && (displayNote.cw == null || expanded)" :class="$style.quote">
			<MkGridspacePrivateNote v-if="note.renote" :note="note.renote" :readOnly="readOnly" :class="$style.quoteNote" quotePreview nested @unavailable="emit('unavailable')" @replied="emit('replied')"/>
			<MkA v-else-if="!readOnly" :to="noteLink(note.renoteId)">{{ i18n.ts._gridspace.privateRenote }}</MkA>
		</div>
		<div v-if="note.gridspaceQuote && (displayNote.cw == null || expanded)" :class="$style.quote"><div :class="$style.quoteNote"><MkGridspaceNoteLinkPreview :url="note.gridspaceQuote" quote/></div></div>
		<button v-if="translation" class="_textButton" @click="translation = null">{{ i18n.ts._autoTranslation.showOriginal }}</button>
		<div v-if="visible && isEnabledUrlPreview && (displayNote.cw == null || expanded)">
			<MkUrlPreview v-for="link in urls" :key="link" :url="link" :compact="true" :detail="detailed" :class="$style.urlPreview"/>
		</div>
		<div v-if="displayNote.cw == null || expanded" class="_gaps_s">
			<MkMediaList v-if="media.length" :mediaList="media" :raw="true" :ephemeral="!directMedia"/>
			<MkButton v-for="file in note.files.filter(item => !directMedia && !blobs[item.id])" :key="file.id" small :disabled="loading === file.id" @click="loadFile(file.id)">
				<i :class="file.isSensitive ? 'ti ti-eye-exclamation' : 'ti ti-photo'"></i> {{ file.isSensitive ? i18n.ts.sensitive : i18n.ts.clickToShow }}: {{ file.name }}
			</MkButton>
		</div>
		<template #reactions>
			<MkPoll v-if="readOnly && note.poll && (displayNote.cw == null || expanded)" :noteId="note.id" :choices="note.poll.choices.map(choice => ({ ...choice, isVoted: false }))" :multiple="note.poll.multiple" :expiresAt="note.poll.expiresAt" :emojiUrls="note.emojis" readOnly/>
			<MkGridspaceNoteActions v-if="!readOnly" v-show="displayNote.cw == null || expanded" ref="actions" :note="note" :compact="true" @changed="updated = $event" @unavailable="emit('unavailable')"/>
			<p v-if="error" role="alert">{{ i18n.ts._gridspace.privateFileError }}</p>
		</template>
		<template #footer="{ buttonClass }">
			<div v-if="readOnly">
				{{ i18n.ts._multiNote.mirrorUnavailable }}
				<a class="_link" :href="note.uri" target="_blank" rel="noopener noreferrer">{{ i18n.ts.showOnRemote }} <i class="ti ti-external-link" aria-hidden="true"></i></a>
			</div>
			<template v-else>
				<MkNoteInfo v-if="detailed" :to="noteLink(note.id)" :createdAt="note.createdAt" :visibility="headerNote.visibility"/>
				<button class="_button" :class="buttonClass" :aria-label="i18n.ts.reply" :title="i18n.ts.reply" @click="reply"><i class="ti ti-arrow-back-up"></i></button>
				<button ref="renoteButton" class="_button" :class="buttonClass" :aria-label="i18n.ts.renote" :title="canRenote ? i18n.ts.renote : i18n.ts.cantRenote" :disabled="!canRenote || renoteLoading" @click="renote"><i :class="renoteLoading ? 'ti ti-loader ti-spin' : canRenote ? 'ti ti-repeat' : 'ti ti-ban'"></i></button>
				<button class="_button" :class="buttonClass" :aria-label="i18n.ts.reaction" :title="i18n.ts.reaction" @click="actions?.react($event)"><i class="ti ti-plus"></i></button>
				<button class="_button" :class="buttonClass" :aria-label="i18n.ts.more" :title="i18n.ts.more" @click="showMenu"><i class="ti ti-dots"></i></button>
				<p v-if="deleteError" role="alert">{{ i18n.ts._gridspace.channelDeleteFailed }}</p>
			</template>
		</template>
	</component>
</div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, inject, onBeforeUnmount, onDeactivated, onMounted, ref, useTemplateRef, watch } from 'vue';
import MkGridspaceReferenceRenote from '@/components/MkGridspaceReferenceRenote.vue';
import { isGridspaceReferenceRenote } from '@/utility/is-gridspace-reference-renote.js';
import * as mfm from 'mfm-js';
import { url } from '@@/js/config.js';
import { shouldCollapsed } from '@@/js/collapsed.js';
import type { Ref } from 'vue';
import type { LinkedClipContext } from '@/utility/gridspace-note-menu.js';
import { useGlobalEvent } from '@/events.js';
import type { entities } from 'misskey-js';
import MkPoll from '@/components/MkPoll.vue';
import MkNotePlacements from '@/components/MkNotePlacements.vue';
import { getPlacementMenu } from '@/utility/multi-note-menu.js';
import { placementRenoteMenu, placementSources } from '@/utility/placement-renote-menu.js';
import { conversationTarget, gridspaceDetailPath } from '@/utility/gridspace-conversation.js';
import { rememberReplyRequest, forgetReplyRequest } from '@/utility/gridspace-reply-request.js';
import MkGridspaceNoteActions from '@/components/MkGridspaceNoteActions.vue';
import MkButton from '@/components/MkButton.vue';
import MkMediaList from '@/components/MkMediaList.vue';
import MkNoteText from '@/components/MkNoteText.vue';
import MkNoteSimple from '@/components/MkNoteSimple.vue';
import MkCwButton from '@/components/MkCwButton.vue';
import MkNoteCw from '@/components/MkNoteCw.vue';
import MkNoteDetailedArticle from '@/components/MkNoteDetailedArticle.vue';
import MkNoteDetailedHeader from '@/components/MkNoteDetailedHeader.vue';
import MkNoteInfo from '@/components/MkNoteInfo.vue';
import MkNoteHeader from '@/components/MkNoteHeader.vue';
import MkNoteArticle from '@/components/MkNoteArticle.vue';
import MkNoteChannel from '@/components/MkNoteChannel.vue';
import MkAvatar from '@/components/global/MkAvatar.vue';
import MkInstanceTicker from '@/components/MkInstanceTicker.vue';
import MkUrlPreview from '@/components/MkUrlPreview.vue';
import { extractUrlFromMfm } from '@/utility/extract-url-from-mfm.js';
import { isEnabledUrlPreview } from '@/utility/url-preview.js';
import { DI } from '@/di.js';
import { gridspacePost } from '@/utility/gridspace-post.js';
import { GridspaceChannelRenoteError, selfRenoteGridspace } from '@/utility/gridspace-channel-renote.js';
import { getRenoteMenu } from '@/utility/get-note-menu.js';
import { getGridspaceRenoteMenu } from '@/utility/gridspace-renote-menu.js';
import { getGridspaceNoteMenu } from '@/utility/gridspace-note-menu.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { isUnavailableGridspaceNote } from '@/utility/is-unavailable-gridspace-note.js';
import { applyGridspaceNoteViewPlugins } from '@/utility/gridspace-note-plugins.js';
import { prefer } from '@/preferences.js';
import { $i } from '@/i.js';
import * as os from '@/os.js';

const MkGridspaceNoteLinkPreview = defineAsyncComponent(() => import('@/components/MkGridspaceNoteLinkPreview.vue').then(module => module.default));
const props = withDefaults(defineProps<{ note: entities.GridspacePrivateNotesResponse['notes'][number]; readOnly?: boolean; compactTop?: boolean; dense?: boolean; nested?: boolean; detailed?: boolean; quotePreview?: boolean }>(), { compactTop: false, dense: false, nested: false, detailed: false, quotePreview: false });
const updated = ref<entities.GridspacePrivateNotesResponse['notes'][number] | null>(null);
const note = computed(() => updated.value ?? props.note);
const dedicated = computed(() => !!conversationTarget(note.value).conversationUri);
const directMedia = computed(() => props.readOnly || dedicated.value);
const pluginNote = computed(() => applyGridspaceNoteViewPlugins(props.note));
const hideByPlugin = computed(() => pluginNote.value == null);
const displayNote = computed(() => pluginNote.value ?? note.value);
const displayAuthor = computed<entities.UserLite>(() => ({ ...displayNote.value.author, id: note.value.author.uri, host: note.value.author.host === new URL(url).host ? null : note.value.author.host,
																																								avatarBlurhash: note.value.author.avatarBlurhash ?? null, avatarDecorations: note.value.author.avatarDecorations ?? [], isBot: note.value.author.isBot ?? false, isCat: displayNote.value.author.isCat ?? false,
																																									emojis: displayNote.value.author.emojis ?? {}, onlineStatus: 'unknown', instance: note.value.author.instance ? { name: null, faviconUrl: null, themeColor: null, softwareName: null, softwareVersion: null, iconUrl: null, ...note.value.author.instance } : undefined }));
const channelContext = inject(DI.linkedChannel, undefined);
const inChannel = computed(() => channelContext?.value?.id === note.value.channelId);
const channel = computed(() => { const value = channelContext?.value; return note.value.channel ?? (value && value.id === note.value.channelId ? value : undefined); });
const headerNote = computed(() => ({ id: note.value.id, createdAt: note.value.createdAt, user: displayAuthor.value, visibility: (['public', 'home', 'followers', 'specified'].includes(note.value.visibility) ? note.value.visibility : 'specified') as entities.Note['visibility'], localOnly: note.value.localOnly, noRelay: note.value.noRelay, channel: note.value.channelId ? { name: channel.value?.name ?? i18n.ts.channel } : null }));
const showTicker = computed(() => prefer.s.instanceTicker === 'always' || (prefer.s.instanceTicker === 'remote' && displayAuthor.value.host != null && displayAuthor.value.instance != null));
const urls = computed(() => extractUrlFromMfm(mfm.parse(displayNote.value.text ?? '')));
watch(() => props.note, () => { updated.value = null; });
const emit = defineEmits<{ (event: 'unavailable'): void; (event: 'replied'): void }>();
const actions = useTemplateRef('actions');
const article = useTemplateRef('article');
const renoteButton = useTemplateRef('renoteButton');
const isPureRenote = computed(() => !!note.value.renoteId && note.value.text == null && note.value.cw == null && !note.value.replyId && !note.value.files.length && !note.value.poll);
const placementChannel = inject(DI.placementChannel, null);
const canRenote = computed(() => !!$i && !props.readOnly && !isUnavailableGridspaceNote(note.value, true) && (dedicated.value
	? note.value.multiNoteKind === 'root' && placementSources(note.value, placementChannel?.value).length > 0
	: (['public', 'home'].includes(note.value.visibility) || (!note.value.channelId && note.value.canSelfRenote)) && (!note.value.channelId || !note.value.renoteId || !!(note.value.text || note.value.cw || note.value.replyId || note.value.files.length || note.value.poll))));
const renoteLoading = ref(false);
const expanded = defineModel<boolean>('expanded', { default: false });
const quoteLong = computed(() => shouldCollapsed(displayNote.value, []));
const quoteCollapsed = ref(true);
const quoteFilesExpanded = ref(false);
const quotePollExpanded = ref(false);
const deleted = ref(false);
const translation = ref<entities.NotesTranslateResponse | null>(null);
const translating = ref(false);
const deleting = ref(false);
const deleteError = ref(false);
const isOwnGridNote = computed(() => !!$i && props.note.author.uri === `${url}/users/${$i.id}`);
const blobs = ref<Record<string, string>>({});
const media = computed<entities.DriveFile[]>(() => note.value.files.filter(file => directMedia.value ? file.url : blobs.value[file.id]).map(file => ({
	...file, id: `gridspace:${note.value.origin}:${file.id}`, createdAt: note.value.createdAt,
	url: directMedia.value ? file.url! : blobs.value[file.id], thumbnailUrl: directMedia.value ? file.thumbnailUrl ?? null : file.type.startsWith('image/') ? blobs.value[file.id] : null, properties: {}, blurhash: null, md5: '',
	userId: null, user: null, folderId: null, folder: null,
})));
const loading = ref<string | null>(null);
const error = ref(false);
const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];
let generation = 0;
let observer: IntersectionObserver | undefined;
const visible = ref(false);

function reply() {
	void gridspacePost({ channelId: note.value.channelId ?? undefined, reply: note.value }, () => emit('replied'));
}

async function renote() {
	if (!canRenote.value || renoteLoading.value) return;
	const current = generation;
	const target = note.value;
	if (dedicated.value && $i) {
		const source = placementChannel?.value;
		await os.popupMenu(placementRenoteMenu(target, $i.id, source ?? null, () => current === generation && source === placementChannel?.value, () => emit('replied')), renoteButton.value);
		return;
	}
	if (!target.channelId && target.canSelfRenote) {
		await os.popupMenu([{
			text: i18n.tsx._gridspace.selfRenoteAs({ account: `@${target.author.username}@${target.author.host}` }), icon: 'ti ti-repeat', action: async () => {
				if (current !== generation || renoteLoading.value || !$i) return;
				renoteLoading.value = true;
				try {
					await selfRenoteGridspace($i.id, target.id, target.author.uri, AbortSignal.timeout(20000));
					if (current === generation) { os.toast(i18n.ts.renoted); emit('replied'); }
				} catch (error) {
					if (current === generation) await os.alert({ type: 'error', text: error instanceof GridspaceChannelRenoteError && error.permissionRequired ? i18n.ts._gridspace.replyConsent : error instanceof GridspaceChannelRenoteError && !error.uncertain ? i18n.ts._gridspace.replyUnavailable : i18n.ts._gridspace.replyUncertain });
				} finally { renoteLoading.value = false; }
			},
		}], renoteButton.value);
		return;
	}
	if (target.channelId && $i) {
		await os.popupMenu(getGridspaceRenoteMenu(target, $i.id, () => current === generation, () => emit('replied')), renoteButton.value);
		return;
	}

	renoteLoading.value = true;
	try {
		const target = await misskeyApi('gridspace/renote-target', { noteId: note.value.id }, undefined, AbortSignal.timeout(20000));
		if (current !== generation) return;
		const { menu } = getRenoteMenu({ note: target, renoteButton });
		await os.popupMenu(menu, renoteButton.value);
	} catch (error) {
		if (current === generation) await os.alert({ type: 'error', text: (error as { code?: string }).code === 'GRIDSPACE_RENOTE_UNAVAILABLE' ? i18n.ts.cantRenote : i18n.ts._gridspace.connectionError });
	} finally { renoteLoading.value = false; }
}

const linkedClip = inject<Ref<LinkedClipContext | null> | null>('gridspaceClip', null);
useGlobalEvent('gridspaceNoteDeleted', id => { if (id === note.value.id) { clear(); deleted.value = true; } });
let disposeMenu: (() => void) | null = null;

async function showMenu(event: MouseEvent) {
	disposeMenu?.();
	const anchor = event.currentTarget ?? event.target;
	const current = generation;
	const { menu, cleanup } = await getGridspaceNoteMenu(note.value, noteLink(note.value.id), translation, translating, props.nested ? null : linkedClip?.value, () => current === generation);
	if (current !== generation) { cleanup(); return; }
	disposeMenu = cleanup;
	if (note.value.multiNoteKind === 'root') {
		menu.push(...getPlacementMenu(note.value.channelPlacements, note.value.uri, async () => {
			if (current !== generation) return;
			emit('replied');
			try {
				const page = await misskeyApi('gridspace/private-notes', { mode: 'show', ...conversationTarget(note.value), limit: 1 }, undefined, AbortSignal.timeout(15000));
				if (current !== generation) return;
				const original = page.notes.find(item => item.uri === note.value.uri);
				if (original) updated.value = original;
				else emit('unavailable');
			} catch {
				if (current === generation) emit('unavailable');
			}
		}));
	}
	if ((dedicated.value && note.value.multiNoteKind === 'conversation-reply' && note.value.canDelete) || (note.value.channelId && (note.value.canDelete || isOwnGridNote.value))) menu.push({ text: i18n.ts.delete, icon: 'ti ti-trash', danger: true, action: () => { if (current === generation) return deleteNote(); return undefined; } });
	await os.popupMenu(menu, anchor).finally(() => { cleanup(); if (disposeMenu === cleanup) disposeMenu = null; });
}

async function deleteNote() {
	if (deleting.value || !$i) return;
	const target = props.note;
	const current = generation;
	if ((await os.confirm({ type: 'warning', text: dedicated.value ? i18n.ts.noteDeleteConfirm : i18n.ts._gridspace.channelDeleteConfirm })).canceled || current !== generation) return;
	deleting.value = true; deleteError.value = false;
	try {
		if (dedicated.value && target.multiNoteKind === 'conversation-reply' && target.canDelete) {
			const key = `delete:${target.uri}`;
			const requestId = rememberReplyRequest($i.id, key, crypto.randomUUID());
			await misskeyApi('gridspace/delete-reply', { canonicalUri: target.uri, requestId }, undefined, AbortSignal.timeout(15000));
			forgetReplyRequest($i.id, key, requestId);
		} else if (target.channelId) {
			await misskeyApi('gridspace/channel-delete', { noteId: target.id, channelId: target.channelId, asCurrentAccount: isOwnGridNote.value }, undefined, AbortSignal.timeout(15000));
		} else {
			return;
		}
		if (current === generation) { clear(); deleted.value = true; }
	} catch { if (current === generation) deleteError.value = true; } finally { deleting.value = false; }
}

function noteLink(id: string) {
	return gridspaceDetailPath(note.value, id);
}

function clearFile(id: string) {
	if (blobs.value[id]) URL.revokeObjectURL(blobs.value[id]);
	delete blobs.value[id];
}

function toggleQuoteFiles(event: Event) {
	quoteFilesExpanded.value = (event.target as HTMLDetailsElement).open;
	if (!quoteFilesExpanded.value) {
		generation++;
		for (const id of Object.keys(blobs.value)) clearFile(id);
		loading.value = null;
	}
}

function clear() {
	generation++;
	quoteFilesExpanded.value = false;
	quotePollExpanded.value = false;
	disposeMenu?.(); disposeMenu = null;
	translation.value = null;
	updated.value = null;
	for (const id of Object.keys(blobs.value)) clearFile(id);
	loading.value = null;
}

async function loadFile(fileId: string) {
	if (loading.value) return;
	const current = generation;
	loading.value = fileId;
	error.value = false;
	try {
		const result = await misskeyApi('gridspace/private-file', { noteId: props.note.id, fileId, channelId: props.note.channelId ?? undefined }, undefined, AbortSignal.timeout(15000));
		if (current !== generation) return;
		const data = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
		const type = imageTypes.includes(result.type) || /^(?:video|audio)\//.test(result.type) ? result.type : 'application/octet-stream';
		blobs.value[fileId] = URL.createObjectURL(new Blob([data], { type }));
	} catch (err) {
		if (current !== generation) return;
		error.value = true;
		const reason = (err as { info?: { reason?: string } }).info?.reason;
		if (reason === 'AUTHORIZATION_REVOKED' || reason === 'LINK_REVOKED') { clear(); emit('unavailable'); }
	} finally { if (current === generation) loading.value = null; }
}

watch([() => props.note.id, () => props.note.uri], () => { quoteCollapsed.value = true; quoteFilesExpanded.value = false; quotePollExpanded.value = false; clear(); deleted.value = false; deleteError.value = false; });
watch(() => props.note.cw, () => { expanded.value = false; clear(); });
watch(expanded, value => { if (!value) clear(); });
watch(() => props.note.files, files => {
	for (const id of Object.keys(blobs.value)) if (!files.some(file => file.id === id)) clearFile(id);
});
watch([visible, expanded, quoteFilesExpanded, () => props.note.id], async () => {
	if (directMedia.value || !visible.value || hideByPlugin.value || prefer.s.dataSaver.media || (props.quotePreview && !quoteFilesExpanded.value) || (displayNote.value.cw != null && !expanded.value)) return;
	const current = generation;
	for (const file of note.value.files) {
		if (current !== generation) return;
		if (!file.isSensitive && file.size <= 16 * 1024 * 1024 && imageTypes.includes(file.type) && !blobs.value[file.id]) await loadFile(file.id);
	}
});
onMounted(() => {
	if (!article.value) return;
	observer = new IntersectionObserver(entries => { visible.value = entries.some(entry => entry.isIntersecting); });
	observer.observe(article.value);
});
onBeforeUnmount(() => { observer?.disconnect(); clear(); });
onDeactivated(clear);
</script>

<style lang="scss" module>
.note { position: relative; font-size: 1.05em; border-bottom: 1px solid var(--MI_THEME-divider); overflow-wrap: anywhere; }
.renoteWrapper { display: block; padding: 0; }
.renoteHeader { position: relative; display: flex; align-items: center; gap: 6px; padding: 16px 32px 0; color: var(--MI_THEME-renote); }
.renoteAvatar { width: 24px; height: 24px; }
.renoteMenu { margin-left: auto; font-size: 0.85em; }
.quote { padding: 8px 0; }
.quoteNote { padding: 16px; border: dashed 1px var(--MI_THEME-renote); border-radius: 8px; overflow: clip; }
.quoteCw { margin: 0; padding: 0; overflow-wrap: break-word; }
.quoteContent { overflow-wrap: break-word; }
.quoteCollapsed { position: relative; max-height: 9em; overflow: clip; padding-bottom: 32px; }
.quoteExpand { display: block; width: 100%; margin-top: 14px; }
.quoteCollapsed > .quoteExpand { position: absolute; bottom: 0; margin: 0; background: var(--MI_THEME-panel); }
.note.detailed { font-size: 1em; }
.note.nested { font-size: inherit; }
.header { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; font-size: 0.95em; }
.account { color: var(--MI_THEME-fgTransparentWeak); font-size: 0.85em; }
.parentLinks { margin-block: 4px; font-size: 0.85em; color: var(--MI_THEME-accent); display: flex; gap: 8px; }
.text { overflow-wrap: anywhere; }
.body { overflow-wrap: break-word; }
.media { display: block; max-width: 100%; max-height: 420px; }
.urlPreview { margin-top: 8px; }
@container (max-width: 580px) { .note { font-size: 0.95em; } }
@container (max-width: 500px) { .note { font-size: 0.9em; } }
@container (max-width: 250px) { .quoteNote { padding: 12px; } }
</style>
