<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkModal ref="modal" preferType="dialog" @click="close" @esc="close" @closed="emit('closed')">
	<MkGridspacePostForm ref="form" v-bind="props" class="_popup" :class="$style.form" autofocus @close="modal?.close()" @sent="sent"/>
</MkModal>
</template>

<script setup lang="ts">
import { useTemplateRef } from 'vue';
import type { entities } from 'misskey-js';
import MkModal from '@/components/MkModal.vue';
import MkGridspacePostForm from '@/components/MkGridspacePostForm.vue';

const props = defineProps<{ channelId?: string; channel?: { name: string; color: string }; reply?: entities.GridspacePrivateNotesResponse['notes'][number]; renote?: entities.GridspacePrivateNotesResponse['notes'][number] }>();
const emit = defineEmits<{ (event: 'closed'): void; (event: 'sent'): void }>();
const modal = useTemplateRef('modal');
const form = useTemplateRef('form');

async function close() { if (await form.value?.canClose()) modal.value?.close(); }

function sent() { emit('sent'); modal.value?.close({ useSendAnimation: true }); }
</script>

<style lang="scss" module>
.form { width: 100%; max-width: 520px; margin: 0 auto auto; }
</style>
