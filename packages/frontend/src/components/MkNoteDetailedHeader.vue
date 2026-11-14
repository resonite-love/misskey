<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<header :class="$style.header">
	<MkAvatar :class="$style.avatar" :user="user" indicator link :preview="preview"/>
	<div :class="$style.body">
		<div><MkA v-user-preview="preview ? user.id : account" :class="$style.name" :to="userPage(user)"><MkUserName :nowrap="false" :user="user"/></MkA><span v-if="user.isBot" :class="$style.bot">bot</span><span :class="$style.visibility"><i v-if="visibility === 'home'" class="ti ti-home" :title="i18n.ts._visibility.home"></i><i v-else-if="visibility === 'followers'" class="ti ti-lock" :title="i18n.ts._visibility.followers"></i><i v-else-if="visibility === 'specified'" class="ti ti-mail" :title="i18n.ts._visibility.specified"></i><i v-if="localOnly" class="ti ti-rocket-off" :title="i18n.ts._visibility.disableFederation"></i></span></div>
		<div :class="$style.account"><MkAcct :user="user"/><img v-for="(role, i) in user.badgeRoles" :key="i" v-tooltip="role.name" :class="$style.badge" :src="role.iconUrl!" alt=""/></div>
		<slot/>
	</div>
</header>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { userPage } from '@@/js/user.js';
import type { entities } from 'misskey-js';
import { i18n } from '@/i18n.js';
const props = withDefaults(defineProps<{ user: entities.UserLite; visibility: entities.Note['visibility']; localOnly?: boolean; preview?: boolean }>(), { preview: true });
const account = computed(() => '@' + props.user.username + (props.user.host ? '@' + props.user.host : ''));
</script>
<style lang="scss" module>
.header { display: flex; position: relative; margin-bottom: 16px; align-items: center; }
.avatar { display: block; flex-shrink: 0; width: 58px; height: 58px; }
.body { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; padding-left: 16px; font-size: .95em; }
.name { font-weight: bold; line-height: 1.3; }
.bot { display: inline-block; margin: 0 .5em; padding: 4px 6px; font-size: 80%; line-height: 1; border: solid .5px var(--MI_THEME-divider); border-radius: 4px; }
.visibility { float: right; display: inline-flex; gap: .5em; margin-left: .5em; }
.account { display: flex; gap: .5em; margin-bottom: 2px; line-height: 1.3; overflow-wrap: anywhere; }
.badge { height: 1.3em; vertical-align: -20%; }
@container (max-width: 450px) { .avatar { width: 50px; height: 50px; } }
</style>
