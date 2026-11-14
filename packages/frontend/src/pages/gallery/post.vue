<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :actions="headerActions" :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 1000px; --MI_SPACER-min: 16px; --MI_SPACER-max: 32px;">
		<div class="_root">
			<Transition :name="prefer.s.animation ? 'fade' : ''" mode="out-in">
				<div v-if="post" class="rkxwuolj">
					<div class="files">
						<div v-for="file in post.files" :key="file.id" class="file">
							<MkMediaImage :image="{ ...file, isSensitive: post.isSensitive || file.isSensitive }" raw/>
						</div>
					</div>
					<div class="body">
						<div class="title">{{ post.title }}</div>
						<div class="description"><Mfm v-if="post.description != null" :text="post.description" :author="post.user" :emojiUrls="post.gridspaceEmojis"/></div>
						<div class="info">
							<i class="ti ti-clock"></i> <MkTime :time="post.createdAt" mode="detail"/>
						</div>
						<div class="actions">
							<div v-if="!post.gridspaceOrigin || post.gridspaceLikeTarget" class="like">
								<MkButton v-if="post.isLiked" v-tooltip="i18n.ts._gallery.unlike" :disabled="likeBusy" class="button" primary @click="unlike()"><i class="ti ti-heart-off"></i><span v-if="post.likedCount > 0" class="count">{{ post.likedCount }}</span></MkButton>
								<MkButton v-else v-tooltip="i18n.ts._gallery.like" :disabled="likeBusy" class="button" @click="like()"><i class="ti ti-heart"></i><span v-if="post.likedCount > 0" class="count">{{ post.likedCount }}</span></MkButton>
							</div>
							<a v-if="post.gridspaceOrigin" :href="sourceUrl" target="_blank" rel="noopener noreferrer" class="_link">{{ i18n.ts.showOnRemote }} <i class="ti ti-external-link"></i></a>
							<div class="other">
								<button v-if="post.gridspaceManagedId || (!post.gridspaceOrigin && $i && $i.id === post.user.id)" v-tooltip="i18n.ts.edit" v-click-anime class="_button" @click="edit"><i class="ti ti-pencil ti-fw"></i></button>
								<button v-tooltip="i18n.ts.shareWithNote" v-click-anime class="_button" @click="shareWithNote"><i class="ti ti-repeat ti-fw"></i></button>
								<button v-tooltip="i18n.ts.copyLink" v-click-anime class="_button" @click="copyLink"><i class="ti ti-link ti-fw"></i></button>
								<button v-if="isSupportShare()" v-tooltip="i18n.ts.share" v-click-anime class="_button" @click="share"><i class="ti ti-share ti-fw"></i></button>
								<button v-if="!post.gridspaceOrigin && $i && $i.id !== post.user.id" v-click-anime class="_button" @click="showMenu"><i class="ti ti-dots ti-fw"></i></button>
							</div>
						</div>
						<div class="user">
							<MkAvatar :user="post.user" class="avatar" link :preview="!post.user.id.startsWith('gridspace:')"/>
							<div class="name">
								<MkUserName :user="post.user" style="display: block;"/>
								<MkAcct :user="post.user"/>
							</div>
							<!--<MkFollowButton v-if="!$i || $i.id != post.user.id" v-model:user="post.user" :inline="true" :transparent="false" :full="true" large class="koudoku"/>-->
						</div>
					</div>
					<MkAd :preferForms="['horizontal', 'horizontal-big']"/>
					<MkContainer v-if="!post.gridspaceOrigin" :max-height="300" :foldable="true" class="other">
						<template #icon><i class="ti ti-clock"></i></template>
						<template #header>{{ i18n.ts.recentPosts }}</template>
						<MkPagination v-slot="{items}" :paginator="otherPostsPaginator">
							<div class="sdrarzaf">
								<MkGalleryPostPreview v-for="post in items" :key="post.id" :post="post" class="post"/>
							</div>
						</MkPagination>
					</MkContainer>
				</div>
				<MkError v-else-if="error" @retry="fetchPost()"/>
				<MkLoading v-else/>
			</Transition>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, watch, ref, defineAsyncComponent, markRaw, onBeforeUnmount } from 'vue';
import * as Misskey from 'misskey-js';
import { url } from '@@/js/config.js';
import type { MenuItem } from '@/types/menu.js';
import MkMediaImage from '@/components/MkMediaImage.vue';
import MkButton from '@/components/MkButton.vue';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { parseManagedId } from '@/utility/gridspace-managed-api.js';
import MkContainer from '@/components/MkContainer.vue';
import MkPagination from '@/components/MkPagination.vue';
import MkGalleryPostPreview from '@/components/MkGalleryPostPreview.vue';
import MkFollowButton from '@/components/MkFollowButton.vue';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import { prefer } from '@/preferences.js';
import { $i } from '@/i.js';
import { isSupportShare } from '@/utility/navigator.js';
import { copyToClipboard } from '@/utility/copy-to-clipboard.js';
import { useRouter } from '@/router.js';
import { Paginator } from '@/utility/paginator.js';

const router = useRouter();

const props = defineProps<{
	postId?: string;
	linkedId?: string;
}>();

const likeBusy = ref(false);
const post = ref<Misskey.entities.GalleryPost | null>(null);
const error = ref<any>(null);
const sourceUrl = computed(() => post.value ? `${post.value.gridspaceOrigin ?? url}/gallery/${post.value.gridspaceOriginalId ?? post.value.id}` : '');
const otherPostsPaginator = markRaw(new Paginator('users/gallery/posts', {
	limit: 6,
	computedParams: computed(() => ({
		userId: post.value!.user.id,
	})),
}));

let requestGeneration = 0;
onBeforeUnmount(() => { requestGeneration++; });

function fetchPost() {
	const current = ++requestGeneration;
	error.value = null;
	post.value = null;
	(props.linkedId ? misskeyApi('gridspace/content', { kind: 'gallery', itemId: parseManagedId(props.linkedId)?.id ?? props.linkedId }).then(result => {
		if (!result.gallery[0]) throw new Error('POST_NOT_FOUND');
		return result.gallery[0];
	}) : misskeyApi('gallery/posts/show', { postId: props.postId! })).then(async _post => {
		if (current !== requestGeneration) return;
		if ($i && _post.gridspaceOrigin) {
			const detail = await misskeyApi('gridspace/managed-resource', { kind: 'gallery', action: 'inspect', id: _post.gridspaceOriginalId ?? _post.id }).catch(() => null);
			if (detail?.item) _post = detail.item as unknown as Misskey.entities.GalleryPost;
			if (current !== requestGeneration) return;
		}
		post.value = _post;
	}).catch(_error => {
		if (current === requestGeneration) error.value = _error;
	});
}

function copyLink() {
	if (!post.value) return;
	copyToClipboard(sourceUrl.value);
}

function share() {
	if (!post.value) return;
	navigator.share({
		title: post.value.title,
		text: post.value.description ?? undefined,
		url: sourceUrl.value,
	});
}

function shareWithNote() {
	if (!post.value) return;
	os.post({
		initialText: `${post.value.title} ${sourceUrl.value}`,
		instant: true,
	});
}

async function setLiked(liked: boolean) {
	const target = post.value;
	if (!target || likeBusy.value) return;
	likeBusy.value = true;
	try {
		if (!liked) {
			const confirm = await os.confirm({ type: 'warning', text: i18n.ts.unlikeConfirm });
			if (confirm.canceled || post.value !== target) return;
		}
		const result = await os.apiWithDialog(liked ? 'gallery/posts/like' : 'gallery/posts/unlike', { postId: target.gridspaceLikeTarget ?? target.id });
		if (post.value !== target) return;
		const updated = result as unknown as { isLiked?: boolean; likedCount?: number } | undefined;
		target.isLiked = updated?.isLiked ?? liked;
		target.likedCount = updated?.likedCount ?? Math.max(0, target.likedCount + (liked ? 1 : -1));
	} finally { likeBusy.value = false; }
}

function like() { return setLiked(true); }

function unlike() { return setLiked(false); }

function edit() {
	router.push('/gallery/:postId/edit', {
		params: {
			postId: post.value!.gridspaceManagedId ?? props.postId!,
		},
	});
}

async function reportAbuse() {
	if (!post.value) return;

	const pageUrl = sourceUrl.value;

	const { dispose } = await os.popupAsyncWithDialog(import('@/components/MkAbuseReportWindow.vue').then(x => x.default), {
		user: post.value.user,
		initialComment: `Post: ${pageUrl}\n-----\n`,
	}, {
		closed: () => dispose(),
	});
}

function showMenu(ev: PointerEvent) {
	if (!post.value) return;

	const menuItems: MenuItem[] = [];

	if ($i && $i.id !== post.value.userId) {
		menuItems.push({
			icon: 'ti ti-exclamation-circle',
			text: i18n.ts.reportAbuse,
			action: reportAbuse,
		});

		if ($i.isModerator || $i.isAdmin) {
			menuItems.push({
				type: 'divider',
			}, {
				icon: 'ti ti-trash',
				text: i18n.ts.delete,
				danger: true,
				action: () => os.confirm({
					type: 'warning',
					text: i18n.ts.deleteConfirm,
				}).then(({ canceled }) => {
					if (canceled || !post.value) return;

					os.apiWithDialog('gallery/posts/delete', { postId: post.value.id });
				}),
			});
		}
	}

	os.popupMenu(menuItems, ev.currentTarget ?? ev.target);
}

watch(() => props.linkedId ?? props.postId, fetchPost, { immediate: true });

const headerActions = computed(() => []);

const headerTabs = computed(() => []);

definePage(() => ({
	title: post.value ? post.value.title : i18n.ts.gallery,
	...post.value ? {
		avatar: post.value.user,
	} : {},
}));
</script>

<style lang="scss" scoped>
.fade-enter-active,
.fade-leave-active {
	transition: opacity 0.125s ease;
}
.fade-enter-from,
.fade-leave-to {
	opacity: 0;
}

.rkxwuolj {
	> .files {
		> .file {
			> img {
				display: block;
				max-width: 100%;
				max-height: 500px;
				margin: 0 auto;
			}

			& + .file {
				margin-top: 16px;
			}
		}
	}

	> .body {
		padding: 32px;

		> .title {
			font-weight: bold;
			font-size: 1.2em;
			margin-bottom: 16px;
		}

		> .info {
			margin-top: 16px;
			font-size: 90%;
			opacity: 0.7;
		}

		> .actions {
			display: flex;
			align-items: center;
			margin-top: 16px;
			padding: 16px 0 0 0;
			border-top: solid 0.5px var(--MI_THEME-divider);

			> .like {
				> .button {
					--MI_THEME-accent: rgb(241 97 132);
					--MI_THEME-X8: rgb(241 92 128);
					--MI_THEME-buttonBg: rgb(216 71 106 / 5%);
					--MI_THEME-buttonHoverBg: rgb(216 71 106 / 10%);
					color: #ff002f;

					::v-deep(.count) {
						margin-left: 0.5em;
					}
				}
			}

			> .other {
				margin-left: auto;

				> button {
					padding: 8px;
					margin: 0 8px;

					&:hover {
						color: var(--MI_THEME-fgHighlighted);
					}
				}
			}
		}

		> .user {
			margin-top: 16px;
			padding: 16px 0 0 0;
			border-top: solid 0.5px var(--MI_THEME-divider);
			display: flex;
			align-items: center;
			flex-wrap: wrap;

			> .avatar {
				width: 52px;
				height: 52px;
			}

			> .name {
				margin: 0 0 0 12px;
				font-size: 90%;
			}

			> .koudoku {
				margin-left: auto;
			}
		}
	}
}

.sdrarzaf {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
	grid-gap: 12px;
	margin: var(--MI-margin);

	> .post {

	}
}
</style>
