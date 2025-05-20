<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<template v-if="player.url && playerEnabled">
	<div
		:class="$style.player"
		:style="player.width ? `padding: ${(player.height || 0) / player.width * 100}% 0 0` : `padding: ${(player.height || 0)}px 0 0`"
	>
		<iframe
			v-if="player.url.startsWith('http://') || player.url.startsWith('https://')"
			sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts allow-storage-access-by-user-activation allow-same-origin"
			scrolling="no"
			:allow="player.allow == null ? 'autoplay;encrypted-media;fullscreen' : player.allow.filter(x => ['autoplay', 'clipboard-write', 'fullscreen', 'encrypted-media', 'picture-in-picture', 'web-share'].includes(x)).join(';')"
			:class="$style.playerIframe"
			:src="transformPlayerUrl(player.url)"
			:style="{ border: 0 }"
		></iframe>
		<span v-else>invalid url</span>
	</div>
	<div :class="$style.action">
		<MkButton :small="true" inline @click="playerEnabled = false">
			<i class="ti ti-x"></i> {{ i18n.ts.disablePlayer }}
		</MkButton>
	</div>
</template>
<template v-else-if="tweetId && tweetExpanded">
	<div ref="twitter">
		<iframe
			ref="tweet"
			allow="fullscreen;web-share"
			sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts allow-same-origin"
			scrolling="no"
			:style="{ position: 'relative', width: '100%', height: `${tweetHeight}px`, border: 0 }"
			:src="`https://platform.twitter.com/embed/index.html?embedId=${embedId}&amp;hideCard=false&amp;hideThread=false&amp;lang=en&amp;theme=${store.s.darkMode ? 'dark' : 'light'}&amp;id=${tweetId}`"
		></iframe>
	</div>
	<div :class="$style.action">
		<MkButton :small="true" inline @click="tweetExpanded = false">
			<i class="ti ti-x"></i> {{ i18n.ts.close }}
		</MkButton>
	</div>
</template>
<template v-else-if="catalystStatusId">
	<div :class="$style.catalystEmbed">
		<template v-if="!catalystData">
			<div :class="$style.catalystText">Loading...</div>
		</template>
		<template v-else>
			<div :class="$style.catalystHeader">
				<img
					:class="$style.catalystAvatar"
					:src="catalystData.user?.profile?.iconUrl + `/tiny` || 'https://catalyst.natsuneko.com/static/avatar.png'"
					alt="User Avatar"
				/>
				<div :class="$style.catalystUserMeta">
					<span :class="$style.catalystUsername">{{
						catalystData.user?.displayName || catalystData.user?.screenName
					}}</span>
					<span :class="$style.catalystUserId">@{{ catalystData.user?.screenName }}</span>
					<span v-if="catalystData.createdAt" :class="$style.catalystDot">・</span>
					<span
						v-if="catalystData.createdAt"
						:class="$style.catalystTime"
					>{{ new Date(catalystData.createdAt).toLocaleString() }}</span>
				</div>
			</div>
			<div v-if="catalystData.medias && catalystData.medias.length" :class="$style.catalystImageWrap">
				<template v-for="(img, i) in catalystData.medias" :key="img.id">
					<MkCatalystSensitiveImage
						v-if="img.metadata?.isSensitive"
						:srcBlur="img.url + '/blur'"
						:srcMedium="img.url + '/medium'"
						:alt="img.alt || `Embed Image ${i+1}`"
						:class="[$style.catalystImage, catalystData.medias.length === 1 ? $style.catalystImageLarge : '']"
						:onPreviewClick="() => openLightbox(img.url + '/original', img.alt || `Embed Image ${i+1}`, img.id)"
					/>
					<img
						v-else
						:class="[$style.catalystImage, catalystData.medias.length === 1 ? $style.catalystImageLarge : '']"
						:src="img.url + '/medium'"
						:alt="img.alt || `Embed Image ${i+1}`"
						style="cursor:pointer"
						@click="openLightbox(img.url + '/original', img.alt || `Embed Image ${i+1}`, img.id)"
					/>
				</template>
			</div>
			<div :class="$style.catalystText">{{ catalystData.body }}</div>
			<!-- Reactions部分はAPIレスポンスに含まれていないので省略 or 拡張時に追加 -->
		</template>
		<div :class="$style.catalystBrand">Catalyst</div>
	</div>
</template>
<div v-else>
	<component
		:is="self ? 'MkA' : 'a'" :class="[$style.link, { [$style.compact]: compact }]" :[attr]="maybeRelativeUrl"
		rel="nofollow noopener" :target="target" :title="url"
	>
		<div
			v-if="thumbnail && !sensitive" :class="$style.thumbnail"
			:style="prefer.s.dataSaver.urlPreview ? '' : { backgroundImage: `url('${thumbnail}')` }"
		>
		</div>
		<article :class="$style.body">
			<header :class="$style.header">
				<h1 v-if="unknownUrl" :class="$style.title">{{ url }}</h1>
				<h1 v-else-if="fetching" :class="$style.title">
					<MkEllipsis/>
				</h1>
				<h1 v-else :class="$style.title" :title="title ?? undefined">{{ title }}</h1>
			</header>
			<p v-if="unknownUrl" :class="$style.text">{{ i18n.ts.failedToPreviewUrl }}</p>
			<p v-else-if="fetching" :class="$style.text">
				<MkEllipsis/>
			</p>
			<p v-else-if="description" :class="$style.text" :title="description">
				{{ description.length > 85 ? description.slice(0, 85) + '…' : description }}
			</p>
			<footer :class="$style.footer">
				<img v-if="icon" :class="$style.siteIcon" :src="icon"/>
				<p v-if="unknownUrl" :class="$style.siteName">{{ requestUrl.host }}</p>
				<p v-else-if="fetching" :class="$style.siteName">
					<MkEllipsis/>
				</p>
				<p v-else :class="$style.siteName" :title="sitename ?? requestUrl.host">{{ sitename ?? requestUrl.host }}</p>
			</footer>
		</article>
	</component>
	<template v-if="showActions">
		<div v-if="tweetId" :class="$style.action">
			<MkButton :small="true" inline @click="tweetExpanded = true">
				<i class="ti ti-brand-x"></i> {{ i18n.ts.expandTweet }}
			</MkButton>
		</div>
		<div v-if="!playerEnabled && player.url" :class="$style.action">
			<MkButton :small="true" inline @click="playerEnabled = true">
				<i class="ti ti-player-play"></i> {{ i18n.ts.enablePlayer }}
			</MkButton>
			<MkButton v-if="!isMobile" :small="true" inline @click="openPlayer()">
				<i class="ti ti-picture-in-picture"></i> {{ i18n.ts.openInWindow }}
			</MkButton>
		</div>
	</template>
</div>
</template>

<script lang="ts" setup>
import { defineAsyncComponent, onDeactivated, onUnmounted, ref } from 'vue';
import { url as local } from '@@/js/config.js';
import { versatileLang } from '@@/js/intl-const.js';
import { maybeMakeRelative } from '@@/js/url.js';
import MkCatalystSensitiveImage from './MkCatalystSensitiveImage.vue';
import MkImgPreviewDialog from './MkImgPreviewDialog.vue';
import { openImageLightbox } from './MkImageLightboxController';
import type { summaly } from '@misskey-dev/summaly';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { deviceKind } from '@/utility/device-kind.js';
import MkButton from '@/components/MkButton.vue';
import { transformPlayerUrl } from '@/utility/player-url-transform.js';
import { store } from '@/store.js';
import { prefer } from '@/preferences.js';

type SummalyResult = Awaited<ReturnType<typeof summaly>>;

const props = withDefaults(defineProps<{
	url: string;
	detail?: boolean;
	compact?: boolean;
	showActions?: boolean;
}>(), {
	detail: false,
	compact: false,
	showActions: true,
});

const MOBILE_THRESHOLD = 500;
const isMobile = ref(deviceKind === 'smartphone' || window.innerWidth <= MOBILE_THRESHOLD);

const maybeRelativeUrl = maybeMakeRelative(props.url, local);
const self = maybeRelativeUrl !== props.url;
const attr = self ? 'to' : 'href';
const target = self ? null : '_blank';
const fetching = ref(true);
const title = ref<string | null>(null);
const description = ref<string | null>(null);
const thumbnail = ref<string | null>(null);
const icon = ref<string | null>(null);
const sitename = ref<string | null>(null);
const sensitive = ref<boolean>(false);
const player = ref({
	url: null,
	width: null,
	height: null,
} as SummalyResult['player']);
const playerEnabled = ref(false);
const tweetId = ref<string | null>(null);
const tweetExpanded = ref(props.detail);
const embedId = `embed${Math.random().toString().replace(/\D/, '')}`;
const tweetHeight = ref(150);
const unknownUrl = ref(false);

const catalystStatusId = ref<string | null>(null);
const catalystData = ref<any | null>(null);

onDeactivated(() => {
	playerEnabled.value = false;
});

function openLightbox(src: string, alt?: string, id?: string) {
	openImageLightbox({ src, alt: alt || id || '' });
}

const requestUrl = new URL(props.url);
if (!['http:', 'https:'].includes(requestUrl.protocol)) throw new Error('invalid url');

if (requestUrl.hostname === 'twitter.com' || requestUrl.hostname === 'mobile.twitter.com' || requestUrl.hostname === 'x.com' || requestUrl.hostname === 'mobile.x.com') {
	const m = requestUrl.pathname.match(/^\/.+\/status(?:es)?\/(\d+)/);
	if (m) tweetId.value = m[1];
}

if (requestUrl.hostname === 'music.youtube.com' && requestUrl.pathname.match('^/(?:watch|channel)')) {
	requestUrl.hostname = 'www.youtube.com';
}

if (requestUrl.hostname === 'catalyst.natsuneko.com') {
	const m = requestUrl.pathname.match(/^\/status\/([^/]+)/);
	if (m) {
		catalystStatusId.value = m[1];
		// Catalyst APIから埋め込みデータ取得
		window.fetch(`https://api.natsuneko.com/catalyst/v1/status/${m[1]}`)
			.then(res => res.ok ? res.json() : null)
			.then(data => {
				if (data && data.status) {
					catalystData.value = data.status;
				}
			});
	}
}

requestUrl.hash = '';

window.fetch(`/url?url=${encodeURIComponent(requestUrl.href)}&lang=${versatileLang}`)
	.then(res => {
		if (!res.ok) {
			if (_DEV_) {
				console.warn(`[HTTP${res.status}] Failed to fetch url preview`);
			}
			return null;
		}

		return res.json();
	})
	.then((info: SummalyResult | null) => {
		if (!info || info.url == null) {
			fetching.value = false;
			unknownUrl.value = true;
			return;
		}

		fetching.value = false;
		unknownUrl.value = false;

		title.value = info.title;
		description.value = info.description;
		thumbnail.value = info.thumbnail;
		icon.value = info.icon;
		sitename.value = info.sitename;
		player.value = info.player;
		sensitive.value = info.sensitive ?? false;
	});

function adjustTweetHeight(message: MessageEvent) {
	if (message.origin !== 'https://platform.twitter.com') return;
	const embed = message.data?.['twttr.embed'];
	if (embed?.method !== 'twttr.private.resize') return;
	if (embed?.id !== embedId) return;
	const height = embed?.params[0]?.height;
	if (height) tweetHeight.value = height;
}

function openPlayer(): void {
	const { dispose } = os.popup(defineAsyncComponent(() => import('@/components/MkYouTubePlayer.vue')), {
		url: requestUrl.href,
	}, {
		closed: () => {
			dispose();
		},
	});
}

window.addEventListener('message', adjustTweetHeight);

onUnmounted(() => {
	window.removeEventListener('message', adjustTweetHeight);
});
</script>

<style lang="scss" module>
.player {
	position: relative;
	width: 100%;
}

.disablePlayer {
	position: absolute;
	top: -1.5em;
	right: 0;
	font-size: 1em;
	width: 1.5em;
	height: 1.5em;
	padding: 0;
	margin: 0;
	color: var(--MI_THEME-fg);
	background: rgba(128, 128, 128, 0.2);
	opacity: 0.7;

	&:hover {
		opacity: 0.9;
	}
}

.playerIframe {
	height: 100%;
	left: 0;
	position: absolute;
	top: 0;
	width: 100%;
}

.link {
	position: relative;
	display: block;
	font-size: 14px;
	box-shadow: 0 0 0 1px var(--MI_THEME-divider);
	border-radius: 8px;
	overflow: clip;
	text-align: left;

	&:hover {
		text-decoration: none;
		border-color: rgba(0, 0, 0, 0.2);

		> .body > .header > .title {
			text-decoration: underline;
		}
	}

	&.compact {
		> .body {
			> .header .title, .text, .footer {
				overflow: hidden;
				white-space: nowrap;
				text-overflow: ellipsis;
			}
		}
	}
}

.thumbnail {
	position: absolute;
	width: 100px;
	height: 100%;
	background-position: center;
	background-size: cover;
	background-color: var(--MI_THEME-bg);
	display: flex;
	justify-content: center;
	align-items: center;

	& + .body {
		left: 100px;
		width: calc(100% - 100px);
	}
}

.body {
	position: relative;
	box-sizing: border-box;
	padding: 16px;
}

.header {
	margin-bottom: 8px;
}

.title {
	margin: 0;
	font-size: 1em;
}

.text {
	margin: 0;
	font-size: 0.8em;
}

.footer {
	margin-top: 8px;
	height: 16px;
}

.siteIcon {
	display: inline-block;
	width: 16px;
	height: 16px;
	margin-right: 4px;
	vertical-align: top;
}

.siteName {
	display: inline-block;
	margin: 0;
	font-size: 0.8em;
	line-height: 16px;
	vertical-align: top;
}

.action {
	display: flex;
	gap: 6px;
	flex-wrap: wrap;
	margin-top: 6px;
}

@container (max-width: 400px) {
	.link {
		font-size: 12px;
	}

	.thumbnail {
		height: 80px;
	}

	.body {
		padding: 12px;
	}

	.catalystUserMeta {
		gap: 2px;
		font-size: 0.92em;
	}

	.catalystTime {
		display: block;
		width: 100%;
		margin-left: 0;
		margin-top: 2px;
	}
}

@container (max-width: 350px) {
	.link {
		font-size: 10px;

		&.compact {
			> .thumbnail {
				position: absolute;
				width: 56px;
				height: 100%;
			}

			> .body {
				left: 56px;
				width: calc(100% - 56px);
				padding: 4px;

				> .header {
					margin-bottom: 2px;
				}

				> .footer {
					margin-top: 2px;
				}
			}
		}
	}

	.thumbnail {
		height: 70px;
	}

	.body {
		padding: 8px;
	}

	.header {
		margin-bottom: 4px;
	}

	.footer {
		margin-top: 4px;
	}

	.siteIcon {
		width: 12px;
		height: 12px;
	}
}

.catalystEmbed {
	background: #181a20;
	color: #fff;
	border-radius: 10px;
	padding: 12px 12px 6px 12px;
	margin: 8px 0;
	display: flex;
	flex-direction: column;
	gap: 0;
	box-shadow: 0 0 0 1px #222;
	position: relative;
}

.catalystHeader {
	display: flex;
	align-items: center;
	margin-bottom: 6px;
}

.catalystAvatar {
	width: 36px;
	height: 36px;
	border-radius: 50%;
	background: #222;
	margin-right: 8px;
}

.catalystUserMeta {
	display: flex;
	align-items: center;
	gap: 4px;
	font-size: 0.98em;
}

.catalystUsername {
	font-weight: bold;
	color: #fff;
	font-size: 1em;
}

.catalystUserId {
	color: #b0b0b0;
	font-size: 0.95em;
}

.catalystDot {
	color: #b0b0b0;
	font-size: 1em;
}

.catalystTime {
	color: #b0b0b0;
	font-size: 0.95em;
}

.catalystImageWrap {
	width: 100%;
	margin: 8px;
	overflow-x: auto;
	white-space: nowrap;
	display: flex;
	gap: 0;
}

.catalystImage {
	display: inline-block;
	width: 220px;
	height: 140px;
	max-width: 90vw;
	object-fit: cover;
	border-radius: 7px;
	background: #222;
	margin-right: 8px;
}

.catalystImageLarge {
	width: 320px;
	height: 200px;
}

.catalystImage:last-child {
	margin-right: 0;
}

.catalystText {
	font-size: 1em;
	margin: 0 0 18px 0;
	padding-left: 2px;
	min-height: 0.5em;
}

.catalystReactions {
	background: #111;
	border-radius: 0 0 7px 7px;
	padding: 7px 8px 5px 8px;
	margin: 0 -12px -6px -12px;
}

.catalystReactionsLabel {
	font-size: 0.9em;
	color: #fff;
	margin-bottom: 4px;
}

.catalystReactionsList {
	display: flex;
	gap: 7px;
}

.catalystReaction {
	display: flex;
	align-items: center;
	background: #222;
	border-radius: 5px;
	padding: 2px 7px 2px 6px;
	gap: 4px;
	font-size: 1em;
	color: #fff;
}

.catalystReaction .emoji {
	font-size: 1.1em;
}

.catalystReaction .count {
	font-size: 0.98em;
	margin-left: 1px;
}

.catalystReactionAdd {
	background: none;
	border: none;
	color: #fff;
	cursor: pointer;
	font-size: 1em;
	padding: 1px 3px;
	border-radius: 3px;
	transition: background 0.2s;
	margin-left: 1px;
}

.catalystReactionAdd:hover {
	background: #333;
}

.catalystBrand {
	position: absolute;
	right: 12px;
	bottom: 6px;
	font-size: 0.85em;
	color: #fff;
	background: rgba(0, 0, 0, 0.25);
	padding: 2px 10px 2px 10px;
	border-radius: 6px;
	letter-spacing: 0.05em;
	font-weight: bold;
	user-select: none;
	pointer-events: none;
}
</style>
