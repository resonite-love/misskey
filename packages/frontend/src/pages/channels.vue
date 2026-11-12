<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader v-model:tab="tab" :actions="headerActions" :tabs="headerTabs" :swipable="true">
	<div class="_spacer" style="--MI_SPACER-w: 1200px;">
		<div v-if="tab === 'search'" :class="$style.searchRoot">
			<div class="_gaps">
				<MkInput v-model="searchQuery" :large="true" :autofocus="true" type="search" @enter="search">
					<template #prefix><i class="ti ti-search"></i></template>
				</MkInput>
				<MkRadios
					v-model="searchType"
					:options="[
						{ value: 'nameAndDescription', label: i18n.ts._channel.nameAndDescription },
						{ value: 'nameOnly', label: i18n.ts._channel.nameOnly },
					]"
					@update:modelValue="search()"
				>
				</MkRadios>
				<MkButton large primary gradate rounded @click="search">{{ i18n.ts.search }}</MkButton>
			</div>

			<MkFoldableSection v-if="channelPaginator">
				<template #header>{{ i18n.ts.searchResult }}</template>
				<MkCombinedChannelList :key="key" :paginator="channelPaginator" :peerEnabled="peerChannels" :peerParams="searchParams" :grid="false"/>
			</MkFoldableSection>
		</div>
		<div v-if="tab === 'featured'">
			<MkCombinedChannelList :paginator="featuredPaginator" :peerEnabled="peerChannels" :peerParams="{ list: 'featured' }"/>
		</div>
		<div v-else-if="tab === 'favorites'">
			<MkCombinedChannelList :paginator="favoritesPaginator" :peerEnabled="peerChannels" :peerParams="{ list: 'favorites' }"/>
		</div>
		<div v-else-if="tab === 'following'">
			<MkCombinedChannelList :paginator="followingPaginator" :peerEnabled="peerChannels" :peerParams="{ list: 'following' }"/>
		</div>
		<div v-else-if="tab === 'owned'" class="_gaps">
			<MkButton v-if="$i?.policies.canCreateChannel" type="routerLink" primary rounded to="/channels/new"><i class="ti ti-plus"></i> {{ i18n.ts.createNew }}</MkButton>
			<MkCombinedChannelList :paginator="ownedPaginator" :peerEnabled="peerChannels" :peerParams="{ list: 'owned' }"/>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, markRaw, onMounted, ref, shallowRef } from 'vue';
import type { entities } from 'misskey-js';
import MkCombinedChannelList from '@/components/MkCombinedChannelList.vue';
import MkInput from '@/components/MkInput.vue';
import MkRadios from '@/components/MkRadios.vue';
import MkButton from '@/components/MkButton.vue';
import MkFoldableSection from '@/components/MkFoldableSection.vue';
import { definePage } from '@/page.js';
import { i18n } from '@/i18n.js';
import { useRouter } from '@/router.js';
import { Paginator } from '@/utility/paginator.js';
import { $i } from '@/i.js';
import { misskeyApi } from '@/utility/misskey-api.js';

const router = useRouter();
const peerChannels = ref(false);
onMounted(async () => {
	if (!$i) return;
	try {
		const status = await misskeyApi('gridspace/link', {}, undefined, AbortSignal.timeout(10000));
		peerChannels.value = status.channelsEnabled;
	} catch { /* The local channel list remains usable during a peer outage. */ }
});

type SearchType = 'nameAndDescription' | 'nameOnly';

const props = defineProps<{
	query: string;
	type?: SearchType;
}>();

const key = ref('');
const tab = ref('featured');
const searchQuery = ref('');
const searchType = ref<SearchType>('nameAndDescription');
const channelPaginator = shallowRef();
const searchParams = shallowRef<entities.GridspaceChannelsRequest>({ list: 'search' });

onMounted(() => {
	searchQuery.value = props.query ?? '';
	searchType.value = props.type ?? 'nameAndDescription';
});

const featuredPaginator = markRaw(new Paginator('channels/featured', {
	limit: 10,
	noPaging: true,
	minItemsToShow: 1,
}));
const favoritesPaginator = markRaw(new Paginator('channels/my-favorites', {
	limit: 100,
	noPaging: true,
	minItemsToShow: 1,
}));
const followingPaginator = markRaw(new Paginator('channels/followed', {
	limit: 10,
}));
const ownedPaginator = markRaw(new Paginator('channels/owned', {
	limit: 10,
}));

async function search() {
	const query = searchQuery.value.toString().trim();

	if (query == null) return;

	const type = searchType.value.toString().trim();

	if (type !== 'nameAndDescription' && type !== 'nameOnly') {
		console.error(`Unrecognized search type: ${type}`);
		return;
	}

	channelPaginator.value = markRaw(new Paginator('channels/search', {
		limit: 10,
		params: {
			query: searchQuery.value,
			type: type,
		},
	}));

	key.value = query + type;
	searchParams.value = { list: 'search', query, queryType: type };
}

const headerActions = computed(() => []);

const headerTabs = computed(() => [{
	key: 'search',
	title: i18n.ts.search,
	icon: 'ti ti-search',
}, {
	key: 'featured',
	title: i18n.ts._channel.featured,
	icon: 'ti ti-comet',
}, {
	key: 'favorites',
	title: i18n.ts.favorites,
	icon: 'ti ti-star',
}, {
	key: 'following',
	title: i18n.ts._channel.following,
	icon: 'ti ti-eye',
}, {
	key: 'owned',
	title: i18n.ts._channel.owned,
	icon: 'ti ti-edit',
}]);

definePage(() => ({
	title: i18n.ts.channel,
	icon: 'ti ti-device-tv',
}));
</script>

<style lang="scss" module>
.searchRoot {
	width: 100%;
	max-width: 700px;
	margin: 0 auto;
}

</style>
