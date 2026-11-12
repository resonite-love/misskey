<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps" :aria-busy="loading">
	<MkInfo>{{ i18n.ts._gridspace.searchScope }}</MkInfo>
	<MkGridspacePrivateNotes v-if="$i && (params.kind ?? 'notes') === 'notes'" :params="{ mode: 'search', query: params.query, userId: params.userId, rangeStartAt: params.rangeStartAt, rangeEndAt: params.rangeEndAt }"/>
	<div :class="$style.results">
		<div v-for="note in displayedNotes" :key="note.id" :class="$style.entry">
			<MkNote :note="note" :withHardMute="true"/>
		</div>
		<div v-for="item in displayedUsers" :key="item.user.id" :class="$style.entry">
			<div :class="$style.person">
				<MkAvatar :user="item.user" :class="$style.avatar"/>
				<div :class="$style.identity"><MkA :to="userPage(item.user)"><MkUserName :user="item.user"/></MkA><MkAcct :user="item.user" :detail="true"/></div>
			</div>
			<div v-if="item.linkedAccounts.length" :class="$style.accounts" class="_gaps_s">
				<span>{{ i18n.ts._gridspace.linkedAccounts }}</span>
				<MkA v-for="account in item.linkedAccounts" :key="account.id" :to="userPage(account)"><MkAcct :user="account" :detail="true"/></MkA>
			</div>
		</div>
	</div>
	<div v-if="error || partial" role="status" class="_gaps_s">
		<p>{{ partial ? i18n.ts._gridspace.searchPartial : error === 'INVALID_CURSOR' || error === 'LINK_UNAVAILABLE' ? i18n.ts._gridspace.historyChanged : i18n.ts.somethingHappened }}</p>
		<MkButton :disabled="loading" @click="error === 'INVALID_CURSOR' || error === 'LINK_UNAVAILABLE' ? reload() : load()">{{ i18n.ts.retry }}</MkButton>
	</div>
	<MkLoading v-if="loading"/>
	<p v-else-if="!partial && !error && !hasMore && displayedNotes.length === 0 && displayedUsers.length === 0">{{ i18n.ts._gridspace.searchEmpty }}</p>
	<MkButton v-else-if="!partial && !error && hasMore" @click="load">{{ i18n.ts.loadMore }}</MkButton>
</div>
</template>

<script lang="ts" setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import * as Misskey from 'misskey-js';
import MkNote from '@/components/MkNote.vue';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkGridspacePrivateNotes from '@/components/MkGridspacePrivateNotes.vue';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { userPage } from '@/filters/user.js';
import { useGlobalEvent } from '@/events.js';
import { $i } from '@/i.js';
import { checkNoteWordMute } from '@/composables/use-note.js';

const props = defineProps<{ params: Misskey.entities.GridspaceSearchRequest }>();
type UserResult = Misskey.entities.GridspaceSearchResponse['users'][number];
const notes = ref<Misskey.entities.Note[]>([]);
const users = ref<UserResult[]>([]);
const previewNotes = ref<Misskey.entities.Note[]>([]);
const previewUsers = ref<UserResult[]>([]);
const displayedNotes = computed(() => [...notes.value, ...previewNotes.value].filter(note => !$i || !checkNoteWordMute(Misskey.note.isPureRenote(note) ? note.renote ?? note : note, $i, $i.hardMutedWords)));
const displayedUsers = computed(() => [...users.value, ...previewUsers.value]);
const loading = ref(false);
const error = ref<string | null>(null);
const partial = ref(false);
const hasMore = ref(true);
let cursor: string | undefined;
let generation = 0;

async function load() {
	if (loading.value || !hasMore.value) return;
	const current = generation;
	loading.value = true;
	error.value = null;
	try {
		const page = await misskeyApi('gridspace/search', { ...props.params, limit: 10, cursor });
		if (current !== generation) return;
		const noteIds = new Set(notes.value.map(note => note.id));
		const userIds = new Set(users.value.map(item => item.user.id));
		previewNotes.value = page.notes.filter(note => !noteIds.has(note.id));
		previewUsers.value = page.users.filter(item => !userIds.has(item.user.id));
		partial.value = !page.peerAvailable;
		if (page.peerAvailable) {
			notes.value.push(...previewNotes.value);
			users.value.push(...previewUsers.value);
			previewNotes.value = [];
			previewUsers.value = [];
			cursor = page.cursor ?? undefined;
			hasMore.value = page.cursor != null;
		}
	} catch (err) {
		if (current !== generation) return;
		previewNotes.value = [];
		previewUsers.value = [];
		partial.value = false;
		error.value = (err as { info?: { reason?: string } }).info?.reason ?? 'UNKNOWN';
	} finally {
		if (current === generation) loading.value = false;
	}
}

async function reload() {
	generation++;
	notes.value = []; users.value = []; previewNotes.value = []; previewUsers.value = [];
	cursor = undefined;
	hasMore.value = true;
	partial.value = false;
	loading.value = false;
	await load();
}

watch(() => props.params, reload, { immediate: true, deep: true });
onBeforeUnmount(() => { generation++; });
useGlobalEvent('noteDeleted', id => {
	notes.value = notes.value.filter(note => note.id !== id);
	previewNotes.value = previewNotes.value.filter(note => note.id !== id);
});
</script>

<style lang="scss" module>
.results {
	background: var(--MI_THEME-panel);
	border-radius: var(--MI-radius);
	overflow: clip;
}
.entry {
	border-bottom: solid 0.5px var(--MI_THEME-divider);
}
.accounts {
	padding: 0 16px 16px;
	font-size: 0.85em;
	overflow-wrap: anywhere;
}
.person {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 16px;
}
.avatar {
	width: 40px;
	height: 40px;
	flex-shrink: 0;
}
.identity {
	display: flex;
	flex-direction: column;
	min-width: 0;
	overflow-wrap: anywhere;
}
</style>
