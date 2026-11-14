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
				<MkClipPreview v-else-if="kind === 'clips'" :clip="item as Misskey.entities.Clip" :peerOrigin="item.gridspaceOrigin" noUserInfo/>
				<MkGalleryPostPreview v-else :post="item as Misskey.entities.GalleryPost"/>
			</template>
		</div>
		<MkError v-if="failed" @retry="load"/>
		<MkLoading v-if="loading"/>
		<MkResult v-else-if="!failed && !items.length" type="empty"/>
		<MkTimelineLoadMore :hasMore="hasMore" :loading="loading" :disabled="failed" @load="load"/>
	</div>
</component>
</template>

<script lang="ts" setup>
import { computed, markRaw, onActivated, onDeactivated, onBeforeUnmount, ref, watch } from 'vue';
import type * as Misskey from 'misskey-js';
import MkPaginationControl from '@/components/MkPaginationControl.vue';
import MkClipPreview from '@/components/MkClipPreview.vue';
import MkPagePreview from '@/components/MkPagePreview.vue';
import MkGalleryPostPreview from '@/components/MkGalleryPostPreview.vue';
import MkTimelineLoadMore from '@/components/MkTimelineLoadMore.vue';
import MkPullToRefresh from '@/components/MkPullToRefresh.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { prefer } from '@/preferences.js';
import { $i } from '@/i.js';

const props = withDefaults(defineProps<{
	kind: 'pages' | 'gallery' | 'clips';
	mode?: 'recent' | 'featured' | 'mine' | 'liked';
	userId?: string;
}>(), { mode: 'recent' });

type Item = (Misskey.entities.Page | Misskey.entities.GalleryPost | Misskey.entities.Clip) & { gridspaceLikedAt?: string; gridspaceLikeId?: string; gridspaceOriginalId?: string };
const local = ref<Item[]>([]), remote = ref<Item[]>([]);
const loading = ref(false), failed = ref(false);
const localMore = ref(true), remoteMore = ref(true);
let localBefore: string | undefined, remoteBefore: string | undefined;
let generation = 0;
let checking: AbortController | undefined;

function cancelCheck() { checking?.abort(); checking = undefined; }

let resolvedLocalUserId: string | undefined;
let identityResolved = false;
const limit = 12;
const control = markRaw({ order: ref<'newest' | 'oldest'>('newest'), initialDirection: 'older' as 'older' | 'newer', initialDate: null as number | null, canSearch: false, searchQuery: ref<string | null>(null), reload });
const ascending = computed(() => control.order.value === 'oldest');
const chronological = (a: Item, b: Item) => Date.parse(props.mode === 'liked' ? b.gridspaceLikedAt ?? b.createdAt : b.createdAt) - Date.parse(props.mode === 'liked' ? a.gridspaceLikedAt ?? a.createdAt : a.createdAt) || b.id.localeCompare(a.id) || (b.gridspaceOrigin ?? '').localeCompare(a.gridspaceOrigin ?? '');
const compare = (a: Item, b: Item) => chronological(a, b) * (ascending.value ? -1 : 1);
const items = computed(() => {
	const all = [...local.value, ...remote.value];
	if (props.mode === 'featured') return all.sort(props.kind === 'pages' ? (a, b) => ('likedCount' in b ? b.likedCount : 0) - ('likedCount' in a ? a.likedCount : 0) || chronological(a, b) : chronological);
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
		if (props.mode === 'liked') {
			const likes = props.kind === 'pages' ? await misskeyApi('i/page-likes', params) : await misskeyApi('i/gallery/likes', params);
			rows = likes.map(like => ({ ...('page' in like ? like.page : like.post), gridspaceLikedAt: like.createdAt }));
			if (current !== generation) return;
			local.value.push(...rows.filter(item => !local.value.some(old => old.id === item.id)));
			localBefore = likes.at(-1)?.id;
			localMore.value = likes.length === limit;
			return;
		} else if (props.kind === 'clips') {
			rows = userId ? await misskeyApi('users/clips', { ...params, userId: localUserId! }) : [];
		} else if (props.kind === 'pages') {
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
		if (props.mode === 'mine' || props.mode === 'liked') {
			const result = await misskeyApi('gridspace/managed-resource', { kind: props.kind === 'pages' ? 'page' : 'gallery', action: props.mode === 'liked' ? 'liked' : 'list', data: props.mode === 'liked' ? { limit, before: remoteBefore } : { limit, untilId: remoteBefore } });
			if (current !== generation) return;
			const rows = result.items as unknown as Item[];
			const ids = new Set(remote.value.map(item => item.id));
			remote.value.push(...rows.filter(item => !ids.has(item.id)));
			remoteBefore = props.mode === 'liked' ? result.next ?? undefined : rows.at(-1)?.gridspaceOriginalId;
			remoteMore.value = props.mode === 'liked' ? result.next != null : rows.length === limit;
			return;
		}
		const result = await misskeyApi('gridspace/content', { kind: props.kind, mode: props.mode === 'featured' ? 'featured' : 'recent', userId, ...(ascending.value ? { after: remoteBefore ?? (control.initialDate ? undefined : '0'), sinceDate: remoteBefore ? undefined : control.initialDate ?? undefined } : { before: remoteBefore, untilDate: remoteBefore ? undefined : control.initialDate ?? undefined }), limit });
		if (current !== generation) return;
		const rows = props.kind === 'pages' ? result.pages : props.kind === 'clips' ? result.clips ?? [] : result.gallery;
		const ids = new Set(remote.value.map(item => item.id));
		remote.value.push(...rows.filter(item => !ids.has(item.id)));
		remoteBefore = result.next ?? undefined;
		remoteMore.value = result.next != null;
	})());
	const result = await Promise.allSettled(requests);
	if (current !== generation) return;
	failed.value = result.some(item => item.status === 'rejected');
	if (failed.value && props.mode === 'liked') remote.value = [];
	loading.value = false;
}

async function reload() {
	cancelCheck();
	generation++;
	identityResolved = false; resolvedLocalUserId = undefined;
	loading.value = false;
	local.value = []; remote.value = [];
	localMore.value = true; remoteMore.value = true;
	localBefore = undefined; remoteBefore = undefined;
	await load();
}

let active = true;
watch(() => [props.kind, props.mode, props.userId], reload, { immediate: true });

async function validateLikes() {
	if (!active || window.document.hidden || checking || props.mode !== 'liked' || loading.value || !remote.value.length) return;
	const controller = new AbortController();
	checking = controller;
	const current = generation;
	const snapshot = [...remote.value];
	const checked: Item[] = [];
	try {
		for (let offset = 0; offset < snapshot.length; offset += 20) {
			const ids = snapshot.slice(offset, offset + 20).map(item => item.gridspaceLikeId!).filter(Boolean);
			const result = await misskeyApi('gridspace/managed-resource', { kind: props.kind === 'pages' ? 'page' : 'gallery', action: 'liked', data: { ids, limit: 20 } }, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
			if (current !== generation) return;
			checked.push(...result.items as unknown as Item[]);
		}
		const ids = new Set(snapshot.map(item => item.gridspaceLikeId));
		remote.value = [...checked, ...remote.value.filter(item => !ids.has(item.gridspaceLikeId))];
	} catch { if (current === generation) { remote.value = []; failed.value = true; } } finally { if (checking === controller) checking = undefined; }
}

function visibility() { if (props.mode === 'liked') { if (window.document.hidden) { cancelCheck(); generation++; remote.value = []; } else void reload(); } }

window.document.addEventListener('visibilitychange', visibility);
const timer = window.setInterval(() => { void validateLikes(); }, 15000);
onDeactivated(() => { active = false; if (props.mode === 'liked') { cancelCheck(); generation++; remote.value = []; } });
onActivated(() => { if (!active) { active = true; if (props.mode === 'liked') void reload(); } });
onBeforeUnmount(() => { cancelCheck(); generation++; window.clearInterval(timer); window.document.removeEventListener('visibilitychange', visibility); });
</script>

<style lang="scss" module>
.gallery {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
	gap: 12px;
}
</style>
