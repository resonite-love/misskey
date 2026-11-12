<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="member?.linked && (showLinkedAccounts || !member.available)" :class="$style.member" class="_panel _gaps_s">
	<template v-if="showLinkedAccounts">
		<div>{{ i18n.ts._gridspace.linkedAccounts }}</div>
		<div v-for="account in member.accounts" :key="account.id">
			<MkA :to="userPage(account)"><MkAcct :user="account" :detail="true"/></MkA>
		</div>
	</template>
	<template v-if="!member.available">
		<div role="status">{{ i18n.ts._gridspace.historyPeerUnavailable }}</div>
		<MkButton small @click="loadMember">{{ i18n.ts.retry }}</MkButton>
	</template>
</div>
<MkStickyContainer>
	<template #header>
		<MkTab
			v-model="tab"
			:tabs="[
				{ key: 'featured', label: i18n.ts.featured },
				{ key: 'notes', label: i18n.ts.notes },
				{ key: 'all', label: i18n.ts.all },
				{ key: 'files', label: i18n.ts.withFiles },
			]"
			:class="$style.tab"
		>
		</MkTab>
	</template>
	<MkNotesTimeline v-if="tab === 'featured'" :noGap="true" :paginator="featuredPaginator" :pullToRefresh="false" :class="$style.tl"/>
	<XLinkedHistory v-else ref="linkedHistory" :userId="user.id" :linked="!!(member?.available && member.linked)" :withReplies="tab === 'all'" :withRenotes="tab === 'all'" :withFiles="tab === 'files'" :withChannelNotes="tab === 'all'" @unavailable="loadMember"/>
</MkStickyContainer>
</template>

<script lang="ts" setup>
import { ref, markRaw, watch, onBeforeUnmount, useTemplateRef } from 'vue';
import * as Misskey from 'misskey-js';
import MkNotesTimeline from '@/components/MkNotesTimeline.vue';
import MkTab from '@/components/MkTab.vue';
import MkButton from '@/components/MkButton.vue';
import XLinkedHistory from './linked-history.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { userPage } from '@/filters/user.js';
import { i18n } from '@/i18n.js';
import { Paginator } from '@/utility/paginator.js';

const props = withDefaults(defineProps<{
	user: Misskey.entities.UserDetailed;
	showLinkedAccounts?: boolean;
}>(), {
	showLinkedAccounts: true,
});

const tab = ref<'featured' | 'notes' | 'all' | 'files'>('all');
const member = ref<Misskey.entities.GridspaceMemberResponse | null>(null);
const linkedHistory = useTemplateRef('linkedHistory');
let memberRequest = 0;

async function loadMember() {
	const current = ++memberRequest;
	try {
		const result = await misskeyApi('gridspace/member', { userId: props.user.id });
		if (current === memberRequest) member.value = result;
	} catch {
		if (current === memberRequest && member.value?.linked) member.value = { ...member.value, available: false };
	}
}

watch(() => props.user.id, () => { member.value = null; void loadMember(); }, { immediate: true });
onBeforeUnmount(() => { memberRequest++; });

const featuredPaginator = markRaw(new Paginator('users/featured-notes', {
	limit: 10,
	params: {
		userId: props.user.id,
	},
}));

defineExpose({
	reload: async () => {
		await loadMember();
		if (tab.value !== 'featured' && linkedHistory.value) await linkedHistory.value.reload();
		else await featuredPaginator.reload();
	},
});
</script>

<style lang="scss" module>
.member {
	padding: 20px;
	overflow-wrap: anywhere;
}
.tab {
	padding: calc(var(--MI-margin) / 2) 0;
	background: var(--MI_THEME-bg);
}

.tl {
	background: var(--MI_THEME-bg);
	border-radius: var(--MI-radius);
	overflow: clip;
}
</style>
