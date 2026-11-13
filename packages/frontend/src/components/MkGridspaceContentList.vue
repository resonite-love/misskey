<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<component :is="prefer.s.enablePullToRefresh ? MkPullToRefresh : 'div'" :refresher="reload">
	<div class="_gaps" :aria-busy="loading" data-gridspace-content-list>
		<MkPaginationControl v-if="userId" :paginator="control"/>
		<div :class="kind === 'gallery' ? $style.gallery : '_gaps'">
			<template v-for="item in items" :key="`${item.gridspaceOrigin ?? ''}:${item.id}`">
				<MkPagePreview v-if="kind === 'pages'" :page="item as Misskey.entities.Page"/>
				<MkGalleryPostPreview v-else :post="item as Misskey.entities.GalleryPost"/>
			</template>
		</div>
		<MkError v-if="failed" @retry="load"/>
		<MkLoading v-if="loading"/>
		<MkResult v-else-if="!failed && !items.length" type="empty"/>
		<div v-if="hasMore && !loading && !failed" ref="sentinel">
			<MkButton @click="load">{{ i18n.ts.loadMore }}</MkButton>
		</div>
	</div>
</component>
</template>

<script lang="ts" setup>
import { computed, markRaw, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue';
import type * as Misskey from 'misskey-js';
import MkPaginationControl from '@/components/MkPaginationControl.vue';
import MkPagePreview from '@/components/MkPagePreview.vue';
import MkGalleryPostPreview from '@/components/MkGalleryPostPreview.vue';
import MkButton from '@/components/MkButton.vue';
import MkPullToRefresh from '@/components/MkPullToRefresh.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import { $i } from '@/i.js';

const props = withDefaults(defineProps<{
	kind: 'pages' | 'gallery';
	mode?: 'recent' | 'featured' | 'mine';
	userId?: string;
}>(), { mode: 'recent' });

type Item = Misskey.entities.Page | Misskey.entities.GalleryPost;
const local = ref<Item[]>([]), remote = ref<Item[]>([]);
const loading = ref(false), failed = ref(false);
const localMore = ref(true), remoteMore = ref(true);
let localBefore: string | undefined, remoteBefore: string | undefined;
let generation = 0;
let resolvedLocalUserId: string | undefined;
let identityResolved = false;
const limit = 12;
const control = markRaw({ order: ref<'newest' | 'oldest'>('newest'), initialDirection: 'older' as 'older' | 'newer', initialDate: null as number | null, canSearch: false, searchQuery: ref<string | null>(null), reload });
const ascending = computed(() => control.order.value === 'oldest');
const chronological = (a: Item, b: Item) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id) || (b.gridspaceOrigin ?? '').localeCompare(a.gridspaceOrigin ?? '');
const compare = (a: Item, b: Item) => chronological(a, b) * (ascending.value ? -1 : 1);
const items = computed(() => {
	const all = [...local.value, ...remote.value];
	if (props.mode === 'featured') return all.sort(props.kind === 'pages' ? (a, b) => b.likedCount - a.likedCount || chronological(a, b) : chronological);
	// Only expose the merged prefix for which both sources have been scanned.
	// Later batches cannot insert above already visible rows.
	const tails = [localMore.value ? local.value.at(-1) : undefined, remoteMore.value ? remote.value.at(-1) : undefined].filter((item): item is Item => item != null).sort(compare);
	return all.sort(compare).filter(item => !tails[0] || compare(item, tails[0]) <= 0);
});
const hasMore = computed(() => localMore.value || remoteMore.value);

async function load() {
	if (loading.value) return;
	loading.value = true;
	failed.value = false;
	const current = generation;
	const userId = props.mode === 'mine' ? $i?.id : props.userId;
	let localUserId = identityResolved ? resolvedLocalUserId : userId;
	if (userId && !identityResolved) {
		try {
			const member = await misskeyApi('gridspace/member', { userId });
			localUserId = member.accounts.find(account => account.host == null)?.id ?? userId;
		} catch { /* The native list remains available if identity lookup fails. */ }
		if (current !== generation) return;
		resolvedLocalUserId = localUserId;
		identityResolved = true;
	}
	const params: { limit: number; sinceId?: string; untilId?: string; sinceDate?: number; untilDate?: number } = { limit, ...(ascending.value ? { sinceId: localBefore ?? '0', sinceDate: control.initialDate ?? undefined } : { untilId: localBefore, untilDate: localBefore ? undefined : control.initialDate ?? undefined }) };
	if (ascending.value && !localBefore && control.initialDate) delete params.sinceId;
	const requests: Promise<void>[] = [];
	if (localMore.value) requests.push((async () => {
		let rows: Item[];
		if (props.kind === 'pages') {
			rows = props.mode === 'mine' ? await misskeyApi('i/pages', params) : userId ? await misskeyApi('users/pages', { ...params, userId: localUserId! }) : await misskeyApi('pages/featured');
		} else {
			rows = props.mode === 'mine' ? await misskeyApi('i/gallery/posts', params) : userId ? await misskeyApi('users/gallery/posts', { ...params, userId: localUserId! }) : props.mode === 'featured' ? await misskeyApi('gallery/featured', params) : await misskeyApi('gallery/posts', params);
		}
		if (current !== generation) return;
		const ids = new Set(local.value.map(item => item.id));
		local.value.push(...rows.filter(item => !ids.has(item.id)));
		localBefore = rows.at(-1)?.id;
		localMore.value = props.mode !== 'featured' && !(props.kind === 'pages' && !userId) && rows.length === limit;
	})());
	if (remoteMore.value) requests.push((async () => {
		if (props.mode === 'mine') {
			const result = await misskeyApi('gridspace/managed-resource', { kind: props.kind === 'pages' ? 'page' : 'gallery', action: 'list', data: { limit, untilId: remoteBefore } });
			if (current !== generation) return;
			const rows = result.items as unknown as Item[];
			const ids = new Set(remote.value.map(item => item.id));
			remote.value.push(...rows.filter(item => !ids.has(item.id)));
			remoteBefore = rows.at(-1)?.gridspaceOriginalId;
			remoteMore.value = rows.length === limit;
			return;
		}
		const result = await misskeyApi('gridspace/content', { kind: props.kind, mode: props.mode === 'featured' ? 'featured' : 'recent', userId, ...(ascending.value ? { after: remoteBefore ?? (control.initialDate ? undefined : '0'), sinceDate: remoteBefore ? undefined : control.initialDate ?? undefined } : { before: remoteBefore, untilDate: remoteBefore ? undefined : control.initialDate ?? undefined }), limit });
		if (current !== generation) return;
		const rows = props.kind === 'pages' ? result.pages : result.gallery;
		const ids = new Set(remote.value.map(item => item.id));
		remote.value.push(...rows.filter(item => !ids.has(item.id)));
		remoteBefore = result.next ?? undefined;
		remoteMore.value = result.next != null;
	})());
	const result = await Promise.allSettled(requests);
	if (current !== generation) return;
	failed.value = result.some(item => item.status === 'rejected');
	loading.value = false;
}

async function reload() {
	generation++;
	identityResolved = false; resolvedLocalUserId = undefined;
	loading.value = false;
	local.value = []; remote.value = [];
	localMore.value = true; remoteMore.value = true;
	localBefore = undefined; remoteBefore = undefined;
	await load();
}

const sentinel = useTemplateRef('sentinel');
let observer: IntersectionObserver | undefined;
watch([sentinel, prefer.r.enableInfiniteScroll], ([element, enabled]) => {
	observer?.disconnect();
	if (!element || !enabled) return;
	observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void load(); }, { rootMargin: '200px' });
	observer.observe(element);
});
watch(() => [props.kind, props.mode, props.userId], reload, { immediate: true });
onBeforeUnmount(() => { generation++; observer?.disconnect(); });
</script>

<style lang="scss" module>
.gallery {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
	gap: 12px;
}
</style>
