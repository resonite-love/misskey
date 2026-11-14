<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<section class="_panel" :class="$style.root" data-channel-overview>
	<div :class="$style.follow"><slot name="follow"/></div><div :class="$style.favorite"><slot name="favorite"/></div>
	<div :class="$style.banner" :style="{ backgroundImage: channel.bannerUrl ? 'url(' + channel.bannerUrl + ')' : undefined }">
		<div :class="$style.statistics"><div><i class="ti ti-users ti-fw"></i><I18n :src="i18n.ts._channel.usersCount" tag="span"><template #n><b>{{ channel.usersCount }}</b></template></I18n></div><div><i class="ti ti-pencil ti-fw"></i><I18n :src="i18n.ts._channel.notesCount" tag="span"><template #n><b>{{ channel.notesCount }}</b></template></I18n></div><div v-if="owned" :class="$style.owner"><i class="ti ti-user-star ti-fw"></i> {{ i18n.ts.youAreAdmin }}</div></div>
		<span v-if="channel.isSensitive" :class="$style.sensitive">{{ i18n.ts.sensitive }}</span><div :class="$style.fade"></div>
	</div>
	<div v-if="channel.description || origin" :class="$style.description"><span v-if="origin" :class="$style.origin">{{ origin }}</span><Mfm v-if="channel.description" :text="channel.description" :isNote="false"/></div>
</section>
</template>
<script setup lang="ts">
import type { entities } from 'misskey-js';
import { i18n } from '@/i18n.js';
defineProps<{ channel: Pick<entities.Channel, 'name' | 'bannerUrl' | 'description' | 'usersCount' | 'notesCount' | 'isSensitive'>; origin?: string; owned?: boolean }>();
</script>
<style lang="scss" module>
.root { position: relative; overflow: clip; }
.follow { position: absolute; z-index: 1; top: 16px; left: 16px; }
.favorite { position: absolute; z-index: 1; top: 16px; right: 16px; }
.banner { position: relative; height: 200px; background: var(--MI_THEME-bg) center / cover; }
.fade { position: absolute; bottom: 0; left: 0; width: 100%; height: 64px; background: linear-gradient(0deg, var(--MI_THEME-panel), color(from var(--MI_THEME-panel) srgb r g b / 0)); }
.statistics { position: absolute; z-index: 1; bottom: 16px; right: 16px; padding: 8px 12px; font-size: 80%; background: var(--MI_THEME-tooltipBg); color: var(--MI_THEME-tooltipFg); border-radius: 6px; }
.statistics i { margin-right: .3em; }
.owner { color: var(--MI_THEME-warn); }
.description { padding: 16px; overflow-wrap: anywhere; }
.origin { display: block; margin-bottom: 8px; color: var(--MI_THEME-fgTransparentWeak); font-size: .85em; }
.sensitive { position: absolute; z-index: 1; bottom: 16px; left: 16px; background: var(--MI_THEME-tooltipBg); color: var(--MI_THEME-warn); border-radius: 6px; font-weight: bold; padding: 4px 7px; }
</style>
