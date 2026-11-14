<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<article v-if="!deleted" ref="article" :class="[$style.note, { [$style.renoteWrapper]: isPureRenote && note.renote }]" data-gridspace-private-note>
	<template v-if="isPureRenote && note.renote">
		<div :class="$style.renoteHeader">
			<MkAvatar :user="displayAuthor" :class="$style.renoteAvatar" link/>
			<i class="ti ti-repeat"></i>
			<I18n :src="i18n.ts.renotedBy" tag="span"><template #user><MkUserName :user="displayAuthor"/></template></I18n>
			<button class="_button" :class="$style.renoteMenu" :aria-label="i18n.ts.more" @click="showMenu"><i class="ti ti-dots"></i> <MkTime :time="note.createdAt"/></button>
		</div>
		<MkGridspacePrivateNote :note="note.renote" @unavailable="emit('unavailable')" @replied="emit('replied')"/>
	</template>
	<template v-else>
	<div v-if="channel" :class="$style.colorBar" :style="{ background: channel.color }"></div>
	<MkAvatar :user="displayAuthor" :class="$style.avatar" link/>
	<div :class="$style.content">
	<MkNoteHeader :note="headerNote" :noteUrl="noteLink(note.id)" :userPreview="`@${displayAuthor.username}${displayAuthor.host ? `@${displayAuthor.host}` : ''}`"/>
	<MkInstanceTicker v-if="showTicker" :host="displayAuthor.host" :instance="displayAuthor.instance"/>
	<div v-if="(note.replyId || note.renoteId)" :class="$style.parentLinks"><MkA v-if="note.replyId" :to="noteLink(note.replyId)"><i class="ti ti-arrow-back-up"></i> {{ i18n.ts._gridspace.privateReply }}</MkA><MkA v-if="note.renoteId" :to="noteLink(note.renoteId)">{{ i18n.ts._gridspace.privateRenote }}</MkA></div>
	<template v-if="note.cw != null">
		<div :class="$style.body"><Mfm :text="note.cw || i18n.ts._gridspace.privateContentWarning" :author="note.author" :emojiUrls="note.emojis ?? {}" :enableEmojiMenu="false"/><MkCwButton v-model="expanded" :text="note.text" :files="note.files" :poll="note.poll ? { ...note.poll, choices: note.poll.choices.map(choice => ({ ...choice, isVoted: choice.isVoted === true })) } : null"/></div>
		<div v-if="expanded" :class="[$style.body, $style.text]"><Mfm :text="translation?.text ?? note.text ?? ''" :author="note.author" :emojiUrls="note.emojis ?? {}" :enableEmojiMenu="false" :enableEmojiMenuReaction="false" :nyaize="'respect'" class="_selectable"/></div>
	</template>
	<div v-else-if="isUnavailableGridspaceNote(note, true)" :class="$style.body"><i class="ti ti-lock"></i> {{ i18n.ts._gridspace.unavailableNote }}</div>
	<div v-else :class="[$style.body, $style.text]"><Mfm :text="translation?.text ?? note.text ?? ''" :author="note.author" :emojiUrls="note.emojis ?? {}" :enableEmojiMenu="false" :enableEmojiMenuReaction="false" :nyaize="'respect'" class="_selectable"/></div>
	<MkGridspacePrivateNote v-if="note.renote && (note.cw == null || expanded)" :note="note.renote" :class="$style.quote" @unavailable="emit('unavailable')" @replied="emit('replied')"/>
	<button v-if="translation" class="_textButton" @click="translation = null">{{ i18n.ts._autoTranslation.showOriginal }}</button>
	<div v-if="visible && isEnabledUrlPreview && (note.cw == null || expanded)">
		<MkUrlPreview v-for="link in urls" :key="link" :url="link" :compact="true" :detail="false" :class="$style.urlPreview"/>
	</div>
	<div v-if="note.cw == null || expanded" class="_gaps_s">
		<MkMediaList v-if="media.length" :mediaList="media" :raw="true" ephemeral/>
		<MkButton v-for="file in note.files.filter(item => !blobs[item.id])" :key="file.id" small :disabled="loading === file.id" @click="loadFile(file.id)">
			<i :class="file.isSensitive ? 'ti ti-eye-exclamation' : 'ti ti-photo'"></i> {{ file.isSensitive ? i18n.ts.sensitive : i18n.ts.clickToShow }}: {{ file.name }}
		</MkButton>
	</div>
	<MkGridspaceNoteActions v-show="note.cw == null || expanded" ref="actions" :note="note" :compact="true" @changed="updated = $event" @unavailable="emit('unavailable')"/>
	<p v-if="error" role="alert">{{ i18n.ts._gridspace.privateFileError }}</p>
	<footer :class="$style.footer">
		<button class="_button" :class="$style.footerButton" :aria-label="i18n.ts.reply" :title="i18n.ts.reply" @click="reply"><i class="ti ti-arrow-back-up"></i></button>
		<button ref="renoteButton" class="_button" :class="$style.footerButton" :aria-label="i18n.ts.renote" :title="canRenote ? i18n.ts.renote : i18n.ts.cantRenote" :disabled="!canRenote || renoteLoading" @click="renote"><i :class="renoteLoading ? 'ti ti-loader ti-spin' : canRenote ? 'ti ti-repeat' : 'ti ti-ban'"></i></button>
		<button class="_button" :class="$style.footerButton" :aria-label="i18n.ts.reaction" :title="i18n.ts.reaction" @click="actions?.react($event)"><i class="ti ti-plus"></i></button>
		<button class="_button" :class="$style.footerButton" :aria-label="i18n.ts.more" :title="i18n.ts.more" @click="showMenu"><i class="ti ti-dots"></i></button>
	</footer>
	<p v-if="deleteError" role="alert">{{ i18n.ts._gridspace.channelDeleteFailed }}</p>
	</div>
	</template>
</article>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onDeactivated, onMounted, ref, useTemplateRef, watch } from 'vue';
import * as mfm from 'mfm-js';
import type { entities } from 'misskey-js';
import MkGridspaceNoteActions from '@/components/MkGridspaceNoteActions.vue';
import MkButton from '@/components/MkButton.vue';
import MkMediaList from '@/components/MkMediaList.vue';
import MkCwButton from '@/components/MkCwButton.vue';
import MkNoteHeader from '@/components/MkNoteHeader.vue';
import MkAvatar from '@/components/global/MkAvatar.vue';
import MkInstanceTicker from '@/components/MkInstanceTicker.vue';
import MkUrlPreview from '@/components/MkUrlPreview.vue';
import { extractUrlFromMfm } from '@/utility/extract-url-from-mfm.js';
import { isEnabledUrlPreview } from '@/utility/url-preview.js';
import { DI } from '@/di.js';
import { gridspacePost } from '@/utility/gridspace-post.js';
import { GridspaceChannelRenoteError, renoteGridspaceChannel } from '@/utility/gridspace-channel-renote.js';
import { getRenoteMenu } from '@/utility/get-note-menu.js';
import { getGridspaceNoteMenu } from '@/utility/gridspace-note-menu.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { isUnavailableGridspaceNote } from '@/utility/is-unavailable-gridspace-note.js';
import { prefer } from '@/preferences.js';
import { url } from '@@/js/config.js';
import { $i } from '@/i.js';
import * as os from '@/os.js';

const props = defineProps<{ note: entities.GridspacePrivateNotesResponse['notes'][number] }>();
const updated = ref<entities.GridspacePrivateNotesResponse['notes'][number] | null>(null);
const note = computed(() => updated.value ?? props.note);
const displayAuthor = computed<entities.UserLite>(() => ({ ...note.value.author, id: note.value.author.uri, host: note.value.author.host === new URL(url).host ? null : note.value.author.host,
	avatarBlurhash: note.value.author.avatarBlurhash ?? null, avatarDecorations: note.value.author.avatarDecorations ?? [], isBot: note.value.author.isBot ?? false, isCat: note.value.author.isCat ?? false,
	emojis: note.value.author.emojis ?? {}, onlineStatus: 'unknown', instance: note.value.author.instance ? { name: null, faviconUrl: null, themeColor: null, softwareName: null, softwareVersion: null, iconUrl: null, ...note.value.author.instance } : undefined }));
const channelContext = inject(DI.linkedChannel, undefined);
const channel = computed(() => { const value = channelContext?.value; return value && value.id === note.value.channelId ? value : undefined; });
const headerNote = computed(() => ({ id: note.value.id, createdAt: note.value.createdAt, user: displayAuthor.value, visibility: (['public', 'home', 'followers', 'specified'].includes(note.value.visibility) ? note.value.visibility : 'specified') as entities.Note['visibility'], localOnly: note.value.localOnly, channel: note.value.channelId ? { name: channel.value?.name ?? i18n.ts.channel } : null }));
const showTicker = computed(() => prefer.s.instanceTicker === 'always' || (prefer.s.instanceTicker === 'remote' && displayAuthor.value.host != null && displayAuthor.value.instance != null));
const urls = computed(() => extractUrlFromMfm(mfm.parse(note.value.text ?? '')));
watch(() => props.note, () => { updated.value = null; });
const emit = defineEmits<{ (event: 'unavailable'): void; (event: 'replied'): void }>();
const actions = useTemplateRef('actions');
const article = useTemplateRef('article');
const renoteButton = useTemplateRef('renoteButton');
const isPureRenote = computed(() => !!note.value.renoteId && note.value.text == null && note.value.cw == null && !note.value.replyId && !note.value.files.length && !note.value.poll);
const canRenote = computed(() => !!$i && ['public', 'home'].includes(note.value.visibility) && (!note.value.channelId || !note.value.renoteId || !!(note.value.text || note.value.cw || note.value.replyId || note.value.files.length || note.value.poll)) && !isUnavailableGridspaceNote(note.value, true));
const renoteLoading = ref(false);
const expanded = defineModel<boolean>('expanded', { default: false });
const deleted = ref(false);
const translation = ref<entities.NotesTranslateResponse | null>(null);
const translating = ref(false);
const deleting = ref(false);
const deleteError = ref(false);
const isOwnGridNote = computed(() => !!$i && props.note.author.uri === `${url}/users/${$i.id}`);
const blobs = ref<Record<string, string>>({});
// Ephemeral blobs only: source file IDs never enter normal drive APIs or caches.
const media = computed<entities.DriveFile[]>(() => note.value.files.filter(file => blobs.value[file.id]).map(file => ({
	...file, id: `gridspace:${note.value.origin}:${file.id}`, createdAt: note.value.createdAt,
	url: blobs.value[file.id], thumbnailUrl: file.type.startsWith('image/') ? blobs.value[file.id] : null, properties: {}, blurhash: null, md5: '',
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
	if (target.channelId) {
		const channelId = target.channelId;
		await os.popupMenu([{
			text: i18n.ts.inChannelRenote, icon: 'ti ti-repeat', action: async () => {
				if (current !== generation || renoteLoading.value || !$i) return;
				renoteLoading.value = true;
				try {
					await renoteGridspaceChannel($i.id, channelId, target.id, AbortSignal.timeout(20000));
					if (current === generation) { os.toast(i18n.ts.renoted); emit('replied'); }
				} catch (error) {
					if (current === generation) await os.alert({ type: 'error', text: error instanceof GridspaceChannelRenoteError && !error.uncertain ? i18n.ts._gridspace.replyUnavailable : i18n.ts._gridspace.replyUncertain });
				} finally { renoteLoading.value = false; }
			},
		}, {
			text: i18n.ts.inChannelQuote, icon: 'ti ti-quote', action: () => {
				if (current !== generation) return;
				void gridspacePost({ channelId, channel: channel.value, renote: target }, () => emit('replied'));
			},
		}], renoteButton.value);
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

let disposeMenu: (() => void) | null = null;

async function showMenu(event: MouseEvent) {
	disposeMenu?.();
	const anchor = event.currentTarget ?? event.target;
	const current = generation;
	const { menu, cleanup } = await getGridspaceNoteMenu(note.value, noteLink(note.value.id), translation, translating);
	if (current !== generation) { cleanup(); return; }
	disposeMenu = cleanup;
	if (note.value.channelId && (note.value.canDelete || isOwnGridNote.value)) menu.push({ text: i18n.ts.delete, icon: 'ti ti-trash', danger: true, action: deleteNote });
	await os.popupMenu(menu, anchor).finally(() => { cleanup(); if (disposeMenu === cleanup) disposeMenu = null; });
}

async function deleteNote() {
	if (deleting.value || !props.note.channelId) return;
	const target = { noteId: props.note.id, channelId: props.note.channelId, asCurrentAccount: isOwnGridNote.value };
	if ((await os.confirm({ type: 'warning', text: i18n.ts._gridspace.channelDeleteConfirm })).canceled) return;
	deleting.value = true; deleteError.value = false;
	try {
		await misskeyApi('gridspace/channel-delete', target, undefined, AbortSignal.timeout(15000));
		clear(); deleted.value = true;
	} catch { deleteError.value = true; } finally { deleting.value = false; }
}

function noteLink(id: string) {
	return `/gridspace/private?noteId=${id}${props.note.channelId ? `&channelId=${props.note.channelId}` : ''}`;
}

function clearFile(id: string) {
	if (blobs.value[id]) URL.revokeObjectURL(blobs.value[id]);
	delete blobs.value[id];
}

function clear() {
	generation++;
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

watch(() => props.note.id, clear);
watch(() => props.note.cw, () => { expanded.value = false; clear(); });
watch(expanded, value => { if (!value) clear(); });
watch(() => props.note.files, files => {
	for (const id of Object.keys(blobs.value)) if (!files.some(file => file.id === id)) clearFile(id);
});
watch([visible, expanded, () => props.note.id], async () => {
	if (!visible.value || prefer.s.dataSaver.media || (note.value.cw != null && !expanded.value)) return;
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
.note { position: relative; display: flex; gap: 14px; padding: 28px 32px; border-bottom: 1px solid var(--MI_THEME-divider); overflow-wrap: anywhere; }
.renoteWrapper { display: block; padding: 0; }
.renoteHeader { display: flex; align-items: center; gap: 6px; padding: 16px 32px 0; color: var(--MI_THEME-renote); }
.renoteAvatar { width: 24px; height: 24px; }
.renoteMenu { margin-left: auto; font-size: 0.85em; }
.quote { margin-top: 8px; padding: 16px; border: 1px solid var(--MI_THEME-divider); border-radius: var(--MI-radius); }
.colorBar { position: absolute; top: 8px; left: 8px; width: 5px; height: calc(100% - 16px); border-radius: 999px; pointer-events: none; }
.avatar { flex: none; display: block; width: 58px; height: 58px; }
.content { flex: 1; min-width: 0; }
.header { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; font-size: 0.95em; }
.account { color: var(--MI_THEME-fgTransparentWeak); font-size: 0.85em; }
.body { margin-block: 4px; }
.parentLinks { margin-block: 4px; font-size: 0.85em; color: var(--MI_THEME-accent); display: flex; gap: 8px; }
.text { overflow-wrap: anywhere; }
.media { display: block; max-width: 100%; max-height: 420px; }
.footer { display: flex; align-items: center; margin-top: 4px; }
.footerButton { margin: 0; padding: 8px; color: color-mix(in srgb, var(--MI_THEME-panel), var(--MI_THEME-fg) 70%); &:not(:last-child) { margin-right: 28px; } &:hover { color: var(--MI_THEME-fgHighlighted); } }
.urlPreview { margin-top: 8px; }
@container (max-width: 500px) {
	.note { gap: 12px; padding: 20px 16px; }
	.avatar { width: 46px; height: 46px; }
}
</style>
