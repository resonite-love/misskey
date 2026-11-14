<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<button
	class="_button"
	:class="[$style.root, { [$style.wait]: wait, [$style.active]: isFollowing, [$style.full]: full }]"
	:disabled="wait || disabled"
	:aria-label="isFollowing ? i18n.ts.unfollow : i18n.ts.follow"
	:aria-pressed="isFollowing"
	@click="onClick"
>
	<template v-if="!wait">
		<template v-if="isFollowing">
			<span v-if="full" :class="$style.text">{{ i18n.ts.unfollow }}</span><i class="ti ti-minus"></i>
		</template>
		<template v-else>
			<span v-if="full" :class="$style.text">{{ i18n.ts.follow }}</span><i class="ti ti-plus"></i>
		</template>
	</template>
	<template v-else>
		<span v-if="full" :class="$style.text">{{ i18n.ts.processing }}</span><MkLoading :em="true"/>
	</template>
</button>
</template>

<script lang="ts" setup>
import { ref, watch } from 'vue';
import * as Misskey from 'misskey-js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';

const props = withDefaults(defineProps<{
	channel: Pick<Misskey.entities.Channel, 'id' | 'isFollowing'>;
	full?: boolean;
	disabled?: boolean;
	updateFollowing?: (following: boolean) => Promise<boolean>;
}>(), {
	full: false,
});

const isFollowing = ref(props.channel.isFollowing);
const wait = ref(false);
let sequence = 0;
watch(() => props.channel.isFollowing, value => { isFollowing.value = value; });
watch(() => props.channel.id, () => { sequence++; wait.value = false; isFollowing.value = props.channel.isFollowing; });

async function onClick() {
	if (wait.value || props.disabled) return;
	const current = ++sequence;
	const channelId = props.channel.id;
	const next = !isFollowing.value;
	wait.value = true;

	try {
		const confirmed = props.updateFollowing ? await props.updateFollowing(next) : await misskeyApi(next ? 'channels/follow' : 'channels/unfollow', { channelId }).then(() => next);
		if (current === sequence && props.channel.id === channelId) isFollowing.value = confirmed;
	} catch (err) {
		console.error(err);
	} finally {
		if (current === sequence) wait.value = false;
	}
}
</script>

<style lang="scss" module>
.root {
	position: relative;
	display: inline-block;
	font-weight: bold;
	color: var(--MI_THEME-accent);
	background: transparent;
	border: solid 1px var(--MI_THEME-accent);
	padding: 0;
	height: 31px;
	font-size: 16px;
	border-radius: 32px;
	background: #fff;

	&.full {
		padding: 0 8px 0 12px;
		font-size: 14px;
	}

	&:not(.full) {
		width: 31px;
	}

	&:focus-visible {
		outline-offset: 2px;
	}

	&:hover {
		//background: mix($primary, #fff, 20);
	}

	&:active {
		//background: mix($primary, #fff, 40);
	}

	&.active {
		color: var(--MI_THEME-fgOnAccent);
		background: var(--MI_THEME-accent);

		&:hover {
			background: hsl(from var(--MI_THEME-accent) h s calc(l + 10));
			border-color: hsl(from var(--MI_THEME-accent) h s calc(l + 10));
		}

		&:active {
			background: hsl(from var(--MI_THEME-accent) h s calc(l - 10));
			border-color: hsl(from var(--MI_THEME-accent) h s calc(l - 10));
		}
	}

	&.wait {
		cursor: wait !important;
		opacity: 0.7;
	}
}

.text {
	margin-right: 6px;
}
</style>
