<template>
<div v-if="playerEnabled" :class="$style.player" :style="`padding: ${(player.height || 0) / (player.width || 1) * 100}% 0 0`">
	<button :class="$style.disablePlayer" :title="i18n.ts.disablePlayer" @click="playerEnabled = false"><i class="ti ti-x"></i></button>
	<iframe v-if="player.url.startsWith('http://') || player.url.startsWith('https://')" :class="$style.playerIframe" :src="player.url + (player.url.match(/\?/) ? '&autoplay=1&auto_play=1' : '?autoplay=1&auto_play=1')" :width="player.width || '100%'" :heigth="player.height || 250" frameborder="0" allow="autoplay; encrypted-media" allowfullscreen/>
	<span v-else>invalid url</span>
</div>
<div v-else-if="tweetId && tweetExpanded" ref="twitter" :class="$style.twitter">
	<iframe ref="tweet" scrolling="no" frameborder="no" :style="{ position: 'relative', width: '100%', height: `${tweetHeight}px` }" :src="`https://platform.twitter.com/embed/index.html?embedId=${embedId}&amp;hideCard=false&amp;hideThread=false&amp;lang=en&amp;theme=${$store.state.darkMode ? 'dark' : 'light'}&amp;id=${tweetId}`"></iframe>
</div>
	<div v-else-if="neosSessionId" :class="$style.twitter">
		<div :class="[$style.link, { [$style.compact]: compact }]" rel="nofollow noopener" >
			<article :class="$style.body">
				<header :class="$style.header">
					<h1 :class="$style.title">{{neosSessionData.name}}</h1>
					<h1 :class="$style.text">{{neosSessionData.hostUserId}}</h1>
				</header>
				<div :class="$style.action">
					<MkButton @click="copySessionUrl">{{neosButtonCopyText}}</MkButton>
					<MkButton @click="openNeosLink">セッション参加</MkButton>
				</div>
			</article>
		</div>
	</div>

	<div v-else-if="neosWorldRecordId" :class="$style.twitter">
		<div :class="[$style.link, { [$style.compact]: compact }]" rel="nofollow noopener" >
			<div v-if="neosWorldData.thumbnail" :class="$style.thumbnail" :style="`background-image: url('${neosWorldData.thumbnail}')`">
			</div>
			<article :class="$style.body">
				<header :class="$style.header">
					<h1 :class="$style.title">{{neosWorldData.name}}</h1>
					<h1 :class="$style.text">{{neosWorldData.ownerName}}</h1>
				</header>
				<div :class="$style.action">
					<MkButton @click="copyWorldLink">{{neosWorldButtonCopyText}}</MkButton>
					<MkButton @click="openWorldLink">ワールドを開く</MkButton>
				</div>
			</article>
		</div>
	</div>
<div v-else :class="$style.urlPreview">
	<component :is="self ? 'MkA' : 'a'" :class="[$style.link, { [$style.compact]: compact }]" :[attr]="self ? url.substr(local.length) : url" rel="nofollow noopener" :target="target" :title="url">
		<div v-if="thumbnail" :class="$style.thumbnail" :style="`background-image: url('${thumbnail}')`">
		</div>
		<article :class="$style.body">
			<header :class="$style.header">
				<h1 v-if="unknownUrl" :class="$style.title">{{ url }}</h1>
				<h1 v-else-if="fetching" :class="$style.title"><MkEllipsis/></h1>
				<h1 v-else :class="$style.title" :title="title">{{ title }}</h1>
			</header>
			<p v-if="unknownUrl" :class="$style.text">{{ i18n.ts.cannotLoad }}</p>
			<p v-else-if="fetching" :class="$style.text"><MkEllipsis/></p>
			<p v-else-if="description" :class="$style.text" :title="description">{{ description.length > 85 ? description.slice(0, 85) + '…' : description }}</p>
			<footer :class="$style.footer">
				<img v-if="icon" :class="$style.siteIcon" :src="icon"/>
				<p v-if="unknownUrl" :class="$style.siteName">?</p>
				<p v-else-if="fetching" :class="$style.siteName"><MkEllipsis/></p>
				<p v-else :class="$style.siteName" :title="sitename">{{ sitename }}</p>
			</footer>
		</article>
	</component>
	<div v-if="tweetId" :class="$style.action">
		<MkButton :small="true" inline @click="tweetExpanded = true">
			<i class="ti ti-brand-twitter"></i> {{ i18n.ts.expandTweet }}
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
</div>
</template>

<script lang="ts" setup>
import { defineAsyncComponent, onMounted, onUnmounted } from 'vue';
import { url as local } from '@/config';
import { i18n } from '@/i18n';
import * as os from '@/os';
import { deviceKind } from '@/scripts/device-kind';
import MkButton from '@/components/MkButton.vue';
import { versatileLang } from '@/scripts/intl-const';
import MkMediaImage from "@/components/MkMediaImage.vue";
import copyToClipboard from "@/scripts/copy-to-clipboard";

const props = withDefaults(defineProps<{
	url: string;
	detail?: boolean;
	compact?: boolean;
}>(), {
	detail: false,
	compact: false,
});

type neosSessionData = {
	name: string | null,
	hostUserId: string | null,
	thumbnail: string | null
}
type neosWorldData = {
	name: string | null,
	ownerName: string | null,
	thumbnail: string | null
}
const defaultNeosSessionData = () => {
	return {
		name: null,
		hostUserId: null,
		thumbnail: null
	}
}
const defaultNeosWorldData = () => {
	return {
		name: null,
		ownerName: null,
		thumbnail: null
	}
}

const MOBILE_THRESHOLD = 500;
const isMobile = $ref(deviceKind === 'smartphone' || window.innerWidth <= MOBILE_THRESHOLD);

const self = props.url.startsWith(local);
const attr = self ? 'to' : 'href';
const target = self ? null : '_blank';
let fetching = $ref(true);
let title = $ref<string | null>(null);
let description = $ref<string | null>(null);
let thumbnail = $ref<string | null>(null);
let icon = $ref<string | null>(null);
let sitename = $ref<string | null>(null);
let player = $ref({
	url: null,
	width: null,
	height: null,
});
let playerEnabled = $ref(false);
let tweetId = $ref<string | null>(null);
let neosSessionId = $ref<string | null>(null);
let neosButtonCopyText = $ref<string>("参加コードをコピー");
let neosWorldButtonCopyText = $ref<string>("ワールドURLをコピー");
let neosSessionData = $ref<neosSessionData>(defaultNeosSessionData())
let neosWorldData = $ref<neosWorldData>(defaultNeosWorldData())
let neosWorldRecordId = $ref<string | null>(null);
let tweetExpanded = $ref(props.detail);
const embedId = `embed${Math.random().toString().replace(/\D/, '')}`;
let tweetHeight = $ref(150);
let unknownUrl = $ref(false);



const requestUrl = new URL(props.url);
if (!['http:', 'https:'].includes(requestUrl.protocol)) throw new Error('invalid url');

if (requestUrl.hostname === 'twitter.com' || requestUrl.hostname === 'mobile.twitter.com') {
	const m = requestUrl.pathname.match(/^\/.+\/status(?:es)?\/(\d+)/);
	if (m) tweetId = m[1];
}

// neos customize
const openNeosLink = () => {
	window.open("http://cloudx.azurewebsites.net/open/session/" + neosSessionId, '_blank');
}

const openWorldLink = () => {
	window.open("http://cloudx.azurewebsites.net/open/world/" + neosWorldRecordId, '_blank');
}

const copySessionUrl = () => {
	const result = copyToClipboard("https://util.kokoa.dev/v1/neos/join.json?url=neos-session:///" + neosSessionId)
	if(result) {
		neosButtonCopyText = "OK! Neosに貼り付けてね"
		setTimeout(() => {
			neosButtonCopyText = "参加コードをコピー"
		}, 2000)
	}
}

const copyWorldLink = () => {
	const result = copyToClipboard("neosrec:///" + neosWorldRecordId);
	if(result) {
		neosWorldButtonCopyText = "OK! Neosに貼り付けてね"
		setTimeout(() => {
			neosWorldButtonCopyText = "ワールドURLをコピー"
		}, 2000)
	}
}

// detect neos session url
if (requestUrl.hostname === 'cloudx.azurewebsites.net') {
	const m = requestUrl.pathname.match(/^\/.+\/session\/(.+)/);
	const w = requestUrl.pathname.match(/^\/.+\/world\/(.+)/);
	if (m) neosSessionId = m[1];
	if (w) neosWorldRecordId = w[1]

	if(m) {
		const data = await fetch("https://neos-proxy.kokoa.live/api/sessions/" + m[1], {})
		const json = await data.json()
		if(data.status == 200) {
			neosSessionData = {
				name: json.name,
				hostUserId: json.hostUserId,
				thumbnail: json.thumbnail
			}
		} else {
			neosSessionData.name = "(たぶん)プライベートセッション"
		}
	}

	if(w) {
		const record = w[1].split("/")
		let d: any = null
		if(w[1].startsWith("G")) {
			d = await fetch(`https://neos-proxy.kokoa.live/api/groups/${record[0]}/records/${record[1]}`)
		} else {
			d = await fetch(`https://neos-proxy.kokoa.live/api/users/${record[0]}/records/${record[1]}`)
		}
		const json = await d.json()
		if(d.status == 200) {
			neosWorldData = {
				name: json.name,
				ownerName: json.ownerName,
				thumbnail: json.thumbnailUri.split(".")[0].replace("neosdb:///","https://assets.neos.com/assets/")
			}
		}
	}
}

if (requestUrl.hostname === 'music.youtube.com' && requestUrl.pathname.match('^/(?:watch|channel)')) {
	requestUrl.hostname = 'www.youtube.com';
}

requestUrl.hash = '';

window.fetch(`/url?url=${encodeURIComponent(requestUrl.href)}&lang=${versatileLang}`).then(res => {
	res.json().then(info => {
		if (info.url == null) {
			unknownUrl = true;
			return;
		}
		title = info.title;
		description = info.description;
		thumbnail = info.thumbnail;
		icon = info.icon;
		sitename = info.sitename;
		fetching = false;
		player = info.player;
	});
});

function adjustTweetHeight(message: any) {
	if (message.origin !== 'https://platform.twitter.com') return;
	const embed = message.data?.['twttr.embed'];
	if (embed?.method !== 'twttr.private.resize') return;
	if (embed?.id !== embedId) return;
	const height = embed?.params[0]?.height;
	if (height) tweetHeight = height;
}

const openPlayer = (): void => {
	os.popup(defineAsyncComponent(() => import('@/components/MkYoutubePlayer.vue')), {
		url: requestUrl.href,
	});
};

(window as any).addEventListener('message', adjustTweetHeight);

onUnmounted(() => {
	(window as any).removeEventListener('message', adjustTweetHeight);
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
	color: var(--fg);
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

.twitter {

}

.urlPreview {
}

.link {
	position: relative;
	display: block;
	font-size: 14px;
	box-shadow: 0 0 0 1px var(--divider);
	border-radius: 8px;
	overflow: clip;

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
	color: var(--urlPreviewInfo);
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
</style>
