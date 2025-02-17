<template>
	<div>
		<div v-if="props.neosSessionId" :class="$style.twitter">
			<div :class="[$style.link, { [$style.compact]: compact }]" rel="nofollow noopener">
				<div v-if="neosSessionData.thumbnail" :class="$style.thumbnail"
						 :style="`background-image: url('${neosSessionData.thumbnail}')`">
				</div>
				<article :class="$style.body">
					<header :class="$style.header">
						<h1 :class="$style.title">{{ neosSessionData.name }}</h1>
						<h1 :class="$style.text">{{ neosSessionData.hostUserId }}</h1>
					</header>
					<div :class="$style.action">
						<MkButton @click="copySessionUrl">{{ neosButtonCopyText }}</MkButton>
						<MkButton @click="openNeosLink">セッション参加</MkButton>
					</div>
				</article>
			</div>
		</div>
		<div v-else-if="neosWorldRecordId" :class="$style.twitter">
			<div :class="[$style.link, { [$style.compact]: compact }]" rel="nofollow noopener">
				<div v-if="neosWorldData.thumbnail" :class="$style.thumbnail"
						 :style="`background-image: url('${neosWorldData.thumbnail}')`">
				</div>
				<article :class="$style.body">
					<header :class="$style.header">
						<h1 :class="$style.title">{{ neosWorldData.name }}</h1>
						<h1 :class="$style.text">{{ neosWorldData.ownerName }}</h1>
					</header>
					<div :class="$style.action">
						<MkButton @click="copyWorldLink">{{ neosWorldButtonCopyText }}</MkButton>
						<MkButton @click="openWorldLink">ワールドを開く</MkButton>
					</div>
				</article>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import copyToClipboard from "@/scripts/copy-to-clipboard";
import MkButton from '@/components/MkButton.vue';

const props = withDefaults(defineProps<{
	neosSessionId: string;
	neosWorldRecordId?: string;
	compact?: boolean;
}>(), {
	compact: false
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

let neosButtonCopyText = $ref<string>("参加コードをコピー");
let neosWorldButtonCopyText = $ref<string>("ワールドURLをコピー");

let neosSessionData = $ref<neosSessionData>(defaultNeosSessionData())
let neosWorldData = $ref<neosWorldData>(defaultNeosWorldData())

// neos customize
const openNeosLink = () => {
	window.open("http://cloudx.azurewebsites.net/open/session/" + props.neosSessionId, '_blank');
}

const openWorldLink = () => {
	window.open("http://cloudx.azurewebsites.net/open/world/" + props.neosWorldRecordId, '_blank');
}

const copySessionUrl = () => {
	const result = copyToClipboard("https://util.kokoa.dev/v1/neos/join.json?url=neos-session:///" + props.neosSessionId)
	if (result) {
		neosButtonCopyText = "OK! Neosに貼り付けてね"
		setTimeout(() => {
			neosButtonCopyText = "参加コードをコピー"
		}, 2000)
	}
}

const copyWorldLink = () => {
	const result = copyToClipboard("neosrec:///" + props.neosWorldRecordId);
	if (result) {
		neosWorldButtonCopyText = "OK! Neosに貼り付けてね"
		setTimeout(() => {
			neosWorldButtonCopyText = "ワールドURLをコピー"
		}, 2000)
	}
}


if (props.neosSessionId) {
	const data = await fetch("https://neos-proxy.kokoa.live/api/sessions/" + props.neosSessionId, {})
	const json = await data.json()
	if (data.status == 200) {
		neosSessionData = {
			name: json.name,
			hostUserId: json.hostUserId,
			thumbnail: json.thumbnail
		}
	} else {
		neosSessionData.name = "(たぶん)プライベートセッション"
	}
}

if (props.neosWorldRecordId) {
	const record = props.neosWorldRecordId.split("/")
	let d: any = null
	if (props.neosWorldRecordId.startsWith("G")) {
		d = await fetch(`https://neos-proxy.kokoa.live/api/groups/${record[0]}/records/${record[1]}`)
	} else {
		d = await fetch(`https://neos-proxy.kokoa.live/api/users/${record[0]}/records/${record[1]}`)
	}
	const json = await d.json()
	if (d.status == 200) {
		neosWorldData = {
			name: json.name,
			ownerName: json.ownerName,
			thumbnail: json.thumbnailUri.split(".")[0].replace("neosdb:///", "https://assets.neos.com/assets/")
		}
	}
}

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
