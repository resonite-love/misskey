<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkGridspaceNoteList v-if="(params.kind ?? 'notes') === 'notes'" :source="{ ...params, kind: 'search' }"/>
<div v-else class="_gaps" :aria-busy="loading">
	<div :class="$style.results">
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
	<p v-else-if="!partial && !error && !hasMore && displayedUsers.length === 0">{{ i18n.ts._gridspace.searchEmpty }}</p>
	<MkButton v-else-if="!partial && !error && hasMore" @click="load">{{ i18n.ts.loadMore }}</MkButton>
</div>
</template>

<script lang="ts" setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import * as Misskey from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import MkGridspaceNoteList from '@/components/MkGridspaceNoteList.vue';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { userPage } from '@@/js/user.js';

const props = defineProps<{ params: Misskey.entities.GridspaceSearchRequest }>();
type UserResult = Misskey.entities.GridspaceSearchResponse['users'][number];
const users = ref<UserResult[]>([]);
const previewUsers = ref<UserResult[]>([]);
const displayedUsers = computed(() => [...users.value, ...previewUsers.value]);
const loading = ref(false);
const error = ref<string | null>(null);
const partial = ref(false);
const hasMore = ref(true);
let cursor: string | undefined;
let generation = 0;

async function load() {
	if (loading.value || !hasMore.value || props.params.kind !== 'users') return;
	const current = generation;
	loading.value = true;
	error.value = null;
	try {
		const page = await misskeyApi('gridspace/search', { ...props.params, limit: 10, cursor });
		if (current !== generation) return;
		const userIds = new Set(users.value.map(item => item.user.id));
		previewUsers.value = page.users.filter(item => !userIds.has(item.user.id));
		partial.value = !page.peerAvailable;
		if (page.peerAvailable) {
			users.value.push(...previewUsers.value);
			previewUsers.value = [];
			cursor = page.cursor ?? undefined;
			hasMore.value = page.cursor != null;
		}
	} catch (err) {
		if (current !== generation) return;
		previewUsers.value = [];
		partial.value = false;
		error.value = (err as { info?: { reason?: string } }).info?.reason ?? 'UNKNOWN';
	} finally {
		if (current === generation) loading.value = false;
	}
}

async function reload() {
	generation++;
	users.value = []; previewUsers.value = [];
	cursor = undefined;
	hasMore.value = true;
	partial.value = false;
	loading.value = false;
	await load();
}

watch(() => props.params, reload, { immediate: true, deep: true });
onBeforeUnmount(() => { generation++; });
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
