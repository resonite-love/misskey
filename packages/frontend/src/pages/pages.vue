<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader v-model:tab="tab" :actions="headerActions" :tabs="headerTabs" :swipable="true">
	<div class="_spacer" style="--MI_SPACER-w: 700px;">
		<div v-if="tab === 'featured'">
			<MkGridspaceContentList kind="pages" mode="featured"/>
		</div>

		<div v-else-if="tab === 'my'" class="_gaps">
			<MkButton class="new" @click="create()"><i class="ti ti-plus"></i></MkButton>
			<MkGridspaceContentList kind="pages" mode="mine"/>
		</div>

		<div v-else-if="tab === 'liked'">
			<MkGridspaceContentList kind="pages" mode="liked"/>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue';
import MkGridspaceContentList from '@/components/MkGridspaceContentList.vue';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import { useRouter } from '@/router.js';

const router = useRouter();

const tab = ref('featured');

function create() {
	router.push('/pages/new');
}

const headerActions = computed(() => [{
	icon: 'ti ti-plus',
	text: i18n.ts.create,
	handler: create,
}]);

const headerTabs = computed(() => [{
	key: 'featured',
	title: i18n.ts._pages.featured,
	icon: 'ti ti-flare',
}, {
	key: 'my',
	title: i18n.ts._pages.my,
	icon: 'ti ti-edit',
}, {
	key: 'liked',
	title: i18n.ts._pages.liked,
	icon: 'ti ti-heart',
}]);

definePage(() => ({
	title: i18n.ts.pages,
	icon: 'ti ti-note',
}));
</script>
