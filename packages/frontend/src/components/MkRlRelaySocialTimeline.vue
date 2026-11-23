<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkLoading v-if="deciding"/>
<MkStreamingNotesTimeline v-else-if="integrated" ref="timeline" src="rl-relay-social" :confirmedTimeline="true" v-bind="props"/>
<MkLegacyRlRelaySocialTimeline v-else ref="timeline" v-bind="props"/>
</template>

<script lang="ts" setup>
import { onMounted, ref, useTemplateRef } from 'vue';
import type { SoundStore } from '@/preferences/def.js';
import MkStreamingNotesTimeline from '@/components/MkStreamingNotesTimeline.vue';
import MkLegacyRlRelaySocialTimeline from '@/components/MkLegacyRlRelaySocialTimeline.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { supportsTimelineKind } from '@/utility/timeline-capabilities.js';

const props = withDefaults(defineProps<{
	sound?: boolean;
	customSound?: SoundStore | null;
	withRenotes?: boolean;
	withReplies?: boolean;
	withSensitive?: boolean;
	onlyFiles?: boolean;
	withLocalOnly?: boolean;
}>(), {
	sound: false,
	customSound: null,
	withRenotes: true,
	withReplies: false,
	withSensitive: true,
	onlyFiles: false,
	withLocalOnly: true,
});

const timeline = useTemplateRef('timeline');
const deciding = ref(true);
const integrated = ref(false);

onMounted(async () => {
	try {
		integrated.value = supportsTimelineKind(await misskeyApi('gridspace/link', { action: 'status' }), 'relay-social');
	} catch {
		// Servers without the unified relay retain their existing reader.
	} finally {
		deciding.value = false;
	}
});

defineExpose({ reloadTimeline: () => timeline.value?.reloadTimeline() });
</script>
