<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<article :class="[$style.article, { [$style.compactTop]: compactTop, [$style.hoverOnly]: footerOnHover, [$style.dense]: dense }]" data-note-article>
	<MkNoteChannel v-if="channel" :channel="channel" display="bar"/>
	<MkAvatar :class="[$style.avatar, { [$style.sticky]: stickyAvatar }]" :user="user" :link="avatarLink" :preview="avatarPreview"/>
	<div :class="$style.main">
		<slot name="header"/>
		<div style="container-type: inline-size;"><slot/></div>
		<MkNoteChannel v-if="channel && showChannelLink" :channel="channel" :to="channelTo"/>
		<slot name="reactions"/>
		<footer v-if="$slots.footer" :class="$style.footer"><slot name="footer" :buttonClass="$style.button"/></footer>
	</div>
</article>
</template>

<script setup lang="ts">
import type { entities } from 'misskey-js';
import MkAvatar from '@/components/global/MkAvatar.vue';
import MkNoteChannel from '@/components/MkNoteChannel.vue';

withDefaults(defineProps<{
	user: entities.UserLite;
	channel?: { id: string; name: string; color: string } | null;
	channelTo?: string;
	showChannelLink?: boolean;
	avatarLink?: boolean;
	avatarPreview?: boolean;
	stickyAvatar?: boolean;
	compactTop?: boolean;
	dense?: boolean;
	footerOnHover?: boolean;
}>(), { channel: null, channelTo: undefined, showChannelLink: true, avatarLink: true, avatarPreview: true, stickyAvatar: false, compactTop: false, dense: false, footerOnHover: false });
</script>

<style lang="scss" module>
.article { position: relative; display: flex; padding: 28px 32px; }
.avatar {
	flex-shrink: 0; display: block !important; margin: 0 14px 0 0; width: 58px; height: 58px;
	&.sticky { position: sticky !important; top: calc(22px + var(--MI-stickyTop, 0px)); }
}
.main { flex: 1; min-width: 0; }
.footer { position: relative; z-index: 1; margin-bottom: -14px; }
.button {
	margin: 0; padding: 8px; color: color-mix(in srgb, var(--MI_THEME-panel), var(--MI_THEME-fg) 70%);
	&:not(:last-child) { margin-right: 28px; }
	&:hover { color: var(--MI_THEME-fgHighlighted); }
}
.article:hover .button { color: var(--MI_THEME-fg); }
.hoverOnly {
	.footer { visibility: hidden; position: absolute; top: 12px; right: 12px; padding: 0 4px; margin-bottom: 0 !important; background: var(--MI_THEME-popup); border-radius: 8px; box-shadow: 0 4px 32px var(--MI_THEME-shadow); }
	.button { font-size: 90%; &:not(:last-child) { margin-right: 0; } }
	&:hover .footer, &:focus-within .footer { visibility: visible; }
}
@container (max-width: 580px) {
	.article { padding: 24px 26px; }
	.avatar { width: 50px; height: 50px; }
}
@container (max-width: 500px) {
	.article { padding: 20px 22px; }
	.footer { margin-bottom: -8px; }
}
@container (max-width: 480px) { .article { padding: 14px 16px; } }
@container (max-width: 450px) {
	.avatar { margin-right: 10px; width: 46px; height: 46px; &.sticky { top: calc(14px + var(--MI-stickyTop, 0px)); } }
}
@container (max-width: 400px) { .article:not(.hoverOnly) .button:not(:last-child) { margin-right: 18px; } }
@container (max-width: 350px) { .article:not(.hoverOnly) .button:not(:last-child) { margin-right: 12px; } }
@container (max-width: 300px) {
	.avatar { width: 44px; height: 44px; }
	.article:not(.hoverOnly) .button:not(:last-child) { margin-right: 8px; }
}
.article.compactTop { padding-top: 8px; }
.article.dense { padding: 16px; }
</style>
