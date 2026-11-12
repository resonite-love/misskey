<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<article v-if="!deleted" ref="article" :class="$style.note" data-gridspace-private-note>
	<MkA :to="authorPage" :class="$style.avatar" :aria-label="note.author.name || note.author.username"><img :src="avatarUrl" alt="" loading="lazy" decoding="async"></MkA>
	<div :class="$style.content">
	<MkNoteHeader :note="headerNote" :noteUrl="noteLink(note.id)"/>
	<div v-if="note.channelId && (note.replyId || note.renoteId)" :class="$style.parentLinks"><MkA v-if="note.replyId" :to="noteLink(note.replyId)"><i class="ti ti-arrow-back-up"></i> {{ i18n.ts._gridspace.privateReply }}</MkA><MkA v-if="note.renoteId" :to="noteLink(note.renoteId)">{{ i18n.ts._gridspace.privateRenote }}</MkA></div>
	<template v-if="note.channelId && note.cw != null">
		<div :class="$style.body"><Mfm :text="note.cw || i18n.ts._gridspace.privateContentWarning" :author="note.author" :emojiUrls="note.emojis ?? {}" :plain="true"/><MkCwButton v-model="expanded" :text="note.text" :poll="note.poll ? { ...note.poll, choices: note.poll.choices.map(choice => ({ ...choice, isVoted: choice.isVoted === true })) } : null"/></div>
		<div v-if="expanded" :class="[$style.body, $style.text]"><Mfm :text="note.text ?? ''" :author="note.author" :emojiUrls="note.emojis ?? {}" :enableEmojiMenu="false" :enableEmojiMenuReaction="false"/></div>
	</template>
	<details v-else-if="note.cw != null" :class="$style.body" :open="expanded" @toggle="toggleContent">
		<summary><Mfm :text="note.cw || i18n.ts._gridspace.privateContentWarning" :author="note.author" :emojiUrls="note.emojis ?? {}" :plain="true" :enableEmojiMenu="false"/></summary>
		<div :class="$style.text"><Mfm :text="note.text ?? ''" :author="note.author" :emojiUrls="note.emojis ?? {}" :enableEmojiMenu="false" :enableEmojiMenuReaction="false"/></div>
	</details>
	<div v-else :class="[$style.body, $style.text]"><Mfm :text="note.text ?? ''" :author="note.author" :emojiUrls="note.emojis ?? {}" :enableEmojiMenu="false" :enableEmojiMenuReaction="false"/></div>
	<div v-if="note.cw == null || expanded" class="_gaps_s">
		<div v-for="file in note.files" :key="file.id" class="_gaps_s">
			<MkButton v-if="!blobs[file.id]" small :disabled="loading === file.id" @click="loadFile(file.id)">
				{{ file.isSensitive ? i18n.ts._gridspace.privateSensitiveFile : i18n.ts._gridspace.privateFile }}: {{ file.name }}
			</MkButton>
			<template v-else>
				<img v-if="imageTypes.includes(file.type)" :src="blobs[file.id]" :alt="file.comment || file.name" :class="$style.media">
				<video v-else-if="file.type.startsWith('video/')" :src="blobs[file.id]" controls :class="$style.media"></video>
				<audio v-else-if="file.type.startsWith('audio/')" :src="blobs[file.id]" controls :class="$style.media"></audio>
				<a :href="blobs[file.id]" :download="file.name">{{ file.name }}</a>
				<MkButton small @click="clearFile(file.id)">{{ i18n.ts.hide }}</MkButton>
			</template>
		</div>
	</div>
	<MkGridspaceNoteActions v-show="note.cw == null || expanded" ref="actions" :note="note" :compact="!!note.channelId" @changed="updated = $event" @unavailable="emit('unavailable')"/>
	<p v-if="error" role="alert">{{ i18n.ts._gridspace.privateFileError }}</p>
	<footer v-if="note.channelId" :class="$style.footer">
		<button class="_button" :class="$style.footerButton" :aria-label="i18n.ts.reply" :title="i18n.ts.reply" @click="replyToChannel"><i class="ti ti-arrow-back-up"></i></button>
		<button class="_button" :class="$style.footerButton" :aria-label="i18n.ts.renote" disabled><i class="ti ti-repeat"></i></button>
		<button class="_button" :class="$style.footerButton" :aria-label="i18n.ts.reaction" :title="i18n.ts.reaction" @click="actions?.react($event)"><i class="ti ti-plus"></i></button>
		<button class="_button" :class="$style.footerButton" :aria-label="i18n.ts.more" :title="i18n.ts.more" @click="showMenu"><i class="ti ti-dots"></i></button>
	</footer>
	<footer v-else class="_buttons">
		<MkButton v-if="note.channelId && (note.canDelete || isOwnGridNote)" small danger :disabled="deleting" @click="deleteNote">{{ i18n.ts.delete }}</MkButton>
		<MkButton v-if="!replying" small @click="replying = true"><i class="ti ti-arrow-back-up" aria-hidden="true"></i> {{ note.channelId ? i18n.ts.reply : i18n.ts._gridspace.replyAction }}</MkButton>
		<MkA v-if="note.replyId" :to="noteLink(note.replyId)">{{ i18n.ts._gridspace.privateReply }}</MkA>
		<MkA v-if="note.renoteId" :to="noteLink(note.renoteId)">{{ i18n.ts._gridspace.privateRenote }}</MkA>
	</footer>
	<p v-if="deleteError" role="alert">{{ i18n.ts._gridspace.channelDeleteFailed }}</p>
	<MkGridspaceReply v-if="replying" :noteId="note.id" :channelId="note.channelId ?? undefined" @close="replying = false"/>
	</div>
</article>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, onMounted, ref, useTemplateRef, watch } from 'vue';
import type { entities } from 'misskey-js';
import MkGridspaceNoteActions from '@/components/MkGridspaceNoteActions.vue';
import MkButton from '@/components/MkButton.vue';
import MkGridspaceReply from '@/components/MkGridspaceReply.vue';
import MkCwButton from '@/components/MkCwButton.vue';
import MkNoteHeader from '@/components/MkNoteHeader.vue';
import { gridspacePost } from '@/utility/gridspace-post.js';
import { copyToClipboard } from '@/utility/copy-to-clipboard.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import { getStaticImageUrl } from '@/utility/media-proxy.js';
import { url } from '@@/js/config.js';
import { $i } from '@/i.js';
import * as os from '@/os.js';

const props = defineProps<{ note: entities.GridspacePrivateNotesResponse['notes'][number] }>();
const updated = ref<entities.GridspacePrivateNotesResponse['notes'][number] | null>(null);
const note = computed(() => updated.value ?? props.note);
const headerNote = computed(() => ({ id: note.value.id, createdAt: note.value.createdAt, user: note.value.author, visibility: (['public', 'home', 'followers', 'specified'].includes(note.value.visibility) ? note.value.visibility : 'specified') as entities.Note['visibility'], localOnly: note.value.localOnly, channel: note.value.channelId ? { name: i18n.ts.channel } : null }));
watch(() => props.note, () => { updated.value = null; });
const emit = defineEmits<{ (event: 'unavailable'): void; (event: 'replied'): void }>();
const actions = useTemplateRef('actions');
const article = useTemplateRef('article');
const authorPage = computed(() => `/@${props.note.author.username}@${props.note.author.host}`);
const avatarUrl = computed(() => prefer.s.disableShowingAnimatedImages || prefer.s.dataSaver.avatar ? getStaticImageUrl(props.note.author.avatarUrl) : props.note.author.avatarUrl);
const expanded = ref(false);
const deleted = ref(false);
const deleting = ref(false);
const deleteError = ref(false);
const isOwnGridNote = computed(() => !!$i && props.note.author.uri === `${url}/users/${$i.id}`);
const replying = ref(false);
const blobs = ref<Record<string, string>>({});
const loading = ref<string | null>(null);
const error = ref(false);
const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];
let generation = 0;
let observer: IntersectionObserver | undefined;
const visible = ref(false);

function replyToChannel() {
	if (note.value.channelId) void gridspacePost({ channelId: note.value.channelId, reply: note.value }, () => emit('replied'));
}

function showMenu(event: MouseEvent) {
	os.popupMenu([{
		text: i18n.ts.copyLink, icon: 'ti ti-link', action: () => copyToClipboard(`${url}${noteLink(note.value.id)}`),
	}, ...(note.value.canDelete || isOwnGridNote.value ? [{ text: i18n.ts.delete, icon: 'ti ti-trash', danger: true, action: deleteNote }] : [])], event.currentTarget ?? event.target);
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
	updated.value = null;
	for (const id of Object.keys(blobs.value)) clearFile(id);
	loading.value = null;
}

function toggleContent(event: Event) {
	expanded.value = (event.target as HTMLDetailsElement).open;
	if (!expanded.value) clear();
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
	if (!visible.value || !note.value.channelId || prefer.s.dataSaver.media || (note.value.cw != null && !expanded.value)) return;
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
.note { display: flex; gap: 16px; padding: 28px 32px; border-bottom: 1px solid var(--MI_THEME-divider); overflow-wrap: anywhere; }
.avatar { flex: none; width: 58px; height: 58px; img { width: 100%; height: 100%; border-radius: 100%; object-fit: cover; } }
.content { flex: 1; min-width: 0; }
.header { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; font-size: 0.95em; }
.account { color: var(--MI_THEME-fgTransparentWeak); font-size: 0.85em; }
.body { margin-block: 4px; }
.parentLinks { margin-block: 4px; font-size: 0.85em; color: var(--MI_THEME-accent); display: flex; gap: 8px; }
.text { overflow-wrap: anywhere; }
.media { display: block; max-width: 100%; max-height: 420px; }
.footer { display: flex; align-items: center; margin-top: 4px; }
.footerButton { margin: 0 28px 0 0; padding: 8px; font-size: 1.1em; color: var(--MI_THEME-fgTransparentWeak); &:hover { color: var(--MI_THEME-accent); } }
@container (max-width: 500px) {
	.note { gap: 12px; padding: 20px 16px; }
	.avatar { width: 46px; height: 46px; }
}
</style>
