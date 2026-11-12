<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<section v-if="status?.enabled && status.state === 'unlinked'" :class="$style.guide" class="_gaps_s" data-gridspace-signup-guide>
	<strong>{{ i18n.tsx._gridspace.signupTitle({ host: peerHost }) }}</strong>
	<p>{{ i18n.ts._gridspace.signupDescription }}</p>
	<MkButton primary rounded @click="emit('link')">{{ i18n.ts._gridspace.signupStart }}</MkButton>
	<small>{{ i18n.ts._gridspace.signupLater }}</small>
</section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef } from 'vue';
import type { entities } from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';

const emit = defineEmits<{ (event: 'link'): void }>();
const status = shallowRef<entities.GridspaceLinkResponse | null>(null);
const peerHost = computed(() => status.value?.peerOrigin ? new URL(status.value.peerOrigin).host : '');
const controller = new AbortController();
onMounted(async () => {
	try {
		const result = await misskeyApi('gridspace/link', {}, undefined, controller.signal);
		if (!controller.signal.aborted) status.value = result;
	} catch { /* Registration remains usable while the peer integration is unavailable. */ }
});
onBeforeUnmount(() => controller.abort());
</script>

<style lang="scss" module>
.guide { text-align: start; padding: 16px; border: 1px solid var(--MI_THEME-divider); border-radius: 12px; background: var(--MI_THEME-panel); p { margin: 0; } }
</style>
