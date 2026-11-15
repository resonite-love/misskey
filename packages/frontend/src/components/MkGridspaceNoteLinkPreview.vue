<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div ref="root" :class="$style.root" data-gridspace-link-preview>
	<template v-if="note">
		<MkNoteHeader :note="header!" :noteUrl="detailUrl" :externalNoteUrl="!!result?.publicUrl" :userPreview="`@${header!.user.username}${header!.user.host ? `@${header!.user.host}` : ''}`"/>
		<MkNoteCw v-if="note.cw != null" v-model="expanded" :cw="note.cw" :text="note.text" :author="header!.user" :emojiUrls="note.emojis ?? {}" :files="note.files"/>
		<template v-if="note.cw == null || expanded">
			<Mfm :text="note.text ?? ''" :author="header!.user" :emojiUrls="note.emojis ?? {}"/>
			<div v-if="(note.files?.length ?? 0)">{{ i18n.tsx.withNFiles({ n: note.files?.length ?? 0 }) }}</div>
		</template>
	</template>
	<MkEllipsis v-else-if="loading"/>
	<span v-else-if="!result?.publicUrl"><i class="ti ti-lock"></i> {{ i18n.ts.invisibleNote }}</span>
	<div>
		<a v-if="result?.publicUrl" class="_link" :href="detailUrl">{{ i18n.ts.details }} <i class="ti ti-chevron-right"></i></a>
		<MkA v-else class="_link" :to="detailUrl">{{ i18n.ts.details }} <i class="ti ti-chevron-right"></i></MkA>
	</div>
</div>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import type { entities } from 'misskey-js';
import MkNoteHeader from '@/components/MkNoteHeader.vue';
import MkNoteCw from '@/components/MkNoteCw.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { $i } from '@/i.js';
import { isVisiblePrivateNote } from '@/utility/gridspace-note-suspension.js';
import { checkTextWordMute } from '@/utility/check-word-mute.js';

const props = defineProps<{ url: string }>();
const result = shallowRef<entities.GridspaceNoteLinkResponse | null>(null);
const root = useTemplateRef('root');
let visible = true;
let observer: IntersectionObserver | undefined;
const loading = ref(false);
const expanded = ref(false);
const note = computed(() => result.value?.note ?? result.value?.localNote ?? null);
const detailUrl = computed(() => result.value?.publicUrl ?? (result.value?.localNote ? `/notes/${result.value.localNote.id}` : props.url));
const header = computed(() => {
	const value = result.value;
	if (value?.localNote) return value.localNote;
	if (!value?.note) return null;
	const n = value.note;
	return { id: n.id, createdAt: n.createdAt, user: { ...n.author, id: n.author.uri }, localOnly: n.localOnly,
		visibility: n.visibility as entities.Note['visibility'], channel: n.channel };
});
let generation = 0;
let active = true;
let controller = new AbortController();

function clear() { generation++; controller.abort(); controller = new AbortController(); result.value = null; loading.value = false; expanded.value = false; }

async function load() {
	if (!active || !visible || window.document.hidden || loading.value) return;
	const current = generation;
	loading.value = true;
	try {
		const value = await misskeyApi('gridspace/note-link', { url: props.url }, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
		if (current === generation && active && !window.document.hidden) result.value = value.note ? isVisiblePrivateNote(value.note) ? value : null : value.localNote ? (!$i || !checkTextWordMute(`${value.localNote.cw ?? ''}\n${value.localNote.text ?? ''}`, $i.hardMutedWords)) ? value : null : value.publicUrl ? value : null;
	} catch { if (current === generation) result.value = null; } finally { if (current === generation) loading.value = false; }
}

function visibility() { if (window.document.hidden) clear(); else void load(); }

watch(() => props.url, () => { clear(); void load(); }, { immediate: true });
onMounted(() => { observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); if (visible) void load(); else clear(); }); if (root.value) observer.observe(root.value); });
const timer = window.setInterval(load, 30000);
window.document.addEventListener('visibilitychange', visibility);
onDeactivated(() => { active = false; clear(); });
onActivated(() => { active = true; void load(); });
onBeforeUnmount(() => { active = false; clear(); window.clearInterval(timer); observer?.disconnect(); window.document.removeEventListener('visibilitychange', visibility); });
</script>

<style lang="scss" module>
.root { padding: 16px; border: 1px solid var(--MI_THEME-divider); border-radius: var(--MI-radius); overflow-wrap: anywhere; font-size: 0.9em; }
</style>
