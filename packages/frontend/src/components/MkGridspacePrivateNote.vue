<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<article :class="$style.note" data-gridspace-private-note>
	<MkA :to="authorPage" :class="$style.avatar" :aria-label="note.author.name || note.author.username"><img :src="avatarUrl" alt="" loading="lazy" decoding="async"></MkA>
	<div :class="$style.content">
	<header :class="$style.header">
		<MkA :to="authorPage"><strong>{{ note.author.name || note.author.username }}</strong></MkA>
		<span :class="$style.account">@{{ note.author.username }}@{{ note.author.host }}</span>
		<MkA :to="`/gridspace/private?noteId=${note.id}`"><MkTime :time="note.createdAt"/></MkA>
		<span><i class="ti ti-lock" aria-hidden="true"></i> {{ i18n.ts._gridspace.privateProtected }}</span>
	</header>
	<details v-if="note.cw != null" :class="$style.body" :open="expanded" @toggle="toggleContent">
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
		<MkGridspaceNoteActions :note="note" @changed="updated = $event" @unavailable="emit('unavailable')"/>
	</div>
	<p v-if="error" role="alert">{{ i18n.ts._gridspace.privateFileError }}</p>
	<footer class="_buttons">
		<MkButton v-if="!replying" small @click="replying = true"><i class="ti ti-arrow-back-up" aria-hidden="true"></i> {{ i18n.ts._gridspace.replyAction }}</MkButton>
		<MkA v-if="note.replyId" :to="`/gridspace/private?noteId=${note.replyId}`">{{ i18n.ts._gridspace.privateReply }}</MkA>
		<MkA v-if="note.renoteId" :to="`/gridspace/private?noteId=${note.renoteId}`">{{ i18n.ts._gridspace.privateRenote }}</MkA>
	</footer>
	<MkGridspaceReply v-if="replying" :noteId="note.id" @close="replying = false"/>
	</div>
</article>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import type { entities } from 'misskey-js';
import MkGridspaceNoteActions from '@/components/MkGridspaceNoteActions.vue';
import MkButton from '@/components/MkButton.vue';
import MkGridspaceReply from '@/components/MkGridspaceReply.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import { getStaticImageUrl } from '@/utility/media-proxy.js';

const props = defineProps<{ note: entities.GridspacePrivateNotesResponse['notes'][number] }>();
const updated = ref<entities.GridspacePrivateNotesResponse['notes'][number] | null>(null);
const note = computed(() => updated.value ?? props.note);
watch(() => props.note, () => { updated.value = null; });
const emit = defineEmits<{ (event: 'unavailable'): void }>();
const authorPage = computed(() => `/@${props.note.author.username}@${props.note.author.host}`);
const avatarUrl = computed(() => prefer.s.disableShowingAnimatedImages || prefer.s.dataSaver.avatar ? getStaticImageUrl(props.note.author.avatarUrl) : props.note.author.avatarUrl);
const expanded = ref(false);
const replying = ref(false);
const blobs = ref<Record<string, string>>({});
const loading = ref<string | null>(null);
const error = ref(false);
const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];
let generation = 0;

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
		const result = await misskeyApi('gridspace/private-file', { noteId: props.note.id, fileId }, undefined, AbortSignal.timeout(15000));
		if (current !== generation) return;
		const data = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
		const type = imageTypes.includes(result.type) || /^(?:video|audio)\//.test(result.type) ? result.type : 'application/octet-stream';
		blobs.value[fileId] = URL.createObjectURL(new Blob([data], { type }));
	} catch {
		if (current !== generation) return;
		error.value = true;
		clear();
		emit('unavailable');
	} finally { if (current === generation) loading.value = null; }
}

watch(() => props.note.id, clear);
watch(() => props.note.cw, () => { expanded.value = false; clear(); });
watch(() => props.note.files, files => {
	for (const id of Object.keys(blobs.value)) if (!files.some(file => file.id === id)) clearFile(id);
});
onBeforeUnmount(clear);
onDeactivated(clear);
</script>

<style lang="scss" module>
.note { display: flex; gap: 16px; padding: 28px 32px; border-bottom: 1px solid var(--MI_THEME-divider); overflow-wrap: anywhere; }
.avatar { flex: none; width: 58px; height: 58px; img { width: 100%; height: 100%; border-radius: 100%; object-fit: cover; } }
.content { flex: 1; min-width: 0; }
.header { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; }
.account { color: var(--MI_THEME-fgTransparentWeak); font-size: 0.85em; }
.body { margin-block: 12px; }
.text { overflow-wrap: anywhere; }
.media { display: block; max-width: 100%; max-height: 420px; }
@container (max-width: 500px) {
	.note { gap: 12px; padding: 20px 16px; }
	.avatar { width: 46px; height: 46px; }
}
</style>
