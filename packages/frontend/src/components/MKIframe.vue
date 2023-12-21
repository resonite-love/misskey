<!--
SPDX-FileCopyrightText: syuilo and other misskey contributors
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkWindow :initialWidth="640" :initialHeight="402" :canResize="true" :closeButton="true">
	<template #header>
		<span>{{ 'kokolive' }}</span>
	</template>

	<div class="poamfof">
    <iframe src="https://kokolive.kokoa.dev/live/kokoa" width="100%" height="100%"></iframe>
	</div>
</MkWindow>
</template>

<script lang="ts" setup>
import MkWindow from '@/components/MkWindow.vue';
import { versatileLang } from '@/scripts/intl-const.js';
import { defaultStore } from '@/store.js';

const props = defineProps<{
	url: string;
}>();

// const requestUrl = new URL(props.url);
// if (!['http:', 'https:'].includes(requestUrl.protocol)) throw new Error('invalid url');

// let fetching = $ref(true);
// let title = $ref<string | null>(null);
// let player = $ref({
// 	url: null,
// 	width: null,
// 	height: null,
// });

// const ytFetch = (): void => {
// 	fetching = true;
// 	window.fetch(`/url?url=${encodeURIComponent(requestUrl.href)}&lang=${versatileLang}`).then(res => {
// 		res.json().then(info => {
// 			if (info.url == null) return;
// 			title = info.title;
// 			fetching = false;
// 			player = info.player;
// 		});
// 	});
// };
//
// ytFetch();

</script>

<style lang="scss">
.poamfof {
	position: relative;
	overflow: hidden;
	height: 100%;

	.player {
		position: absolute;
		inset: 0;

		iframe {
			width: 100%;
			height: 100%;
		}
	}
}
</style>
