<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :actions="headerActions">
	<div class="_spacer" style="--MI_SPACER-w: 800px;">
		<MkInfo v-if="peerError" warn>{{ i18n.ts._gridspace.collectionsPartial }}</MkInfo>
		<MkButton v-if="peerError" @click="loadClip">{{ i18n.ts.retry }}</MkButton>
		<div v-if="clip" class="_gaps">
			<div class="_panel">
				<div class="_gaps_s" :class="$style.description">
					<div v-if="clip.description">
						<Mfm :text="clip.description" :isNote="false"/>
					</div>
					<div v-else>({{ i18n.ts.noDescription }})</div>
					<div v-if="$i">
						<MkButton v-if="favorited" v-tooltip="i18n.ts.unfavorite" asLike rounded primary :disabled="favoriteBusy" :aria-label="i18n.ts.unfavorite" @click="unfavorite()"><i class="ti ti-heart"></i><span v-if="clip.favoritedCount > 0" style="margin-left: 6px;">{{ clip.favoritedCount }}</span></MkButton>
						<MkButton v-else v-tooltip="i18n.ts.favorite" asLike rounded :disabled="favoriteBusy" :aria-label="i18n.ts.favorite" @click="favorite()"><i class="ti ti-heart"></i><span v-if="clip.favoritedCount > 0" style="margin-left: 6px;">{{ clip.favoritedCount }}</span></MkButton>
					</div>
				</div>
				<div :class="$style.user">
					<MkAvatar :user="clip.user" :class="$style.avatar" indicator link :preview="!isPeer"/> <MkUserName :user="clip.user" :nowrap="false"/>
					<a v-if="isPeer" :href="sourceUrl" target="_blank" rel="noopener noreferrer" :class="$style.source" :title="peerHost">（{{ i18n.ts._gridspace.resoniteLoveName }}）<i class="ti ti-external-link"></i></a>
				</div>
			</div>

			<MkGridspaceNoteList v-if="isPeer" :source="{ kind: 'clip', clipId }" withControl :noGap="false"/>
			<MkNotesTimeline v-else :paginator="paginator" :detail="true"/>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, watch, provide, ref, markRaw, onBeforeUnmount, onActivated, onDeactivated } from 'vue';
import * as Misskey from 'misskey-js';
import { url } from '@@/js/config.js';
import type { MenuItem } from '@/types/menu.js';
import type { PageHeaderItem } from '@/types/page-header.js';
import MkGridspaceNoteList from '@/components/MkGridspaceNoteList.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkNotesTimeline from '@/components/MkNotesTimeline.vue';
import { $i } from '@/i.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { definePage } from '@/page.js';
import MkButton from '@/components/MkButton.vue';
import { clipsCache } from '@/cache.js';
import { isSupportShare } from '@/utility/navigator.js';
import { copyToClipboard } from '@/utility/copy-to-clipboard.js';
import { genEmbedCode } from '@/utility/get-embed-code.js';
import { assertServerContext, serverContext } from '@/server-context.js';
import { Paginator } from '@/utility/paginator.js';

// contextは非ログイン状態の情報しかないためログイン時は利用できない
const CTX_CLIP = !$i && assertServerContext(serverContext, 'clip') ? serverContext.clip : null;

const props = defineProps<{
	clipId: string,
	peer?: string,
}>();

const clip = ref<Misskey.entities.Clip | null>(CTX_CLIP);
const favorited = ref(false);
const favoriteBusy = ref(false);
const managedClipId = ref<string | null>(null);
const isPeer = computed(() => props.peer === 'linked');
const peerOrigin = ref('');
const peerHost = computed(() => peerOrigin.value ? new URL(peerOrigin.value).host : '');
const sourceUrl = computed(() => `${isPeer.value ? peerOrigin.value : url}/clips/${props.clipId}`);
const peerError = ref(false);
let generation = 0;
let active = true;
let checking = false;
const paginator = markRaw(new Paginator('clips/notes', {
	limit: 10,
	canSearch: true,
	computedParams: computed(() => ({
		clipId: props.clipId,
	})),
}));

const isOwned = computed<boolean | null>(() => isPeer.value ? managedClipId.value != null : $i && clip.value && ($i.id === clip.value.userId));

async function loadClip() {
	if (favoriteBusy.value || checking || !active || (isPeer.value && window.document.hidden)) return;
	const current = ++generation;
	checking = true;
	try {
		if (isPeer.value) {
			const page = await misskeyApi('gridspace/collections', { kind: 'clips', clipId: props.clipId });
			if (current !== generation) return;
			if (!page.clipsList.length || !page.origin) throw new Error('Unavailable clip');
			clip.value = page.clipsList[0]; favorited.value = clip.value.isFavorited ?? false; peerOrigin.value = page.origin; peerError.value = false;
			const editable = await misskeyApi('gridspace/managed-resource', { kind: 'clip', action: 'show', id: props.clipId }).catch(() => null);
			if (current === generation) managedClipId.value = typeof editable?.item?.id === 'string' ? editable.item.id : null;
		} else {
			const loaded = CTX_CLIP?.id === props.clipId ? CTX_CLIP : await misskeyApi('clips/show', { clipId: props.clipId });
			if (current !== generation) return;
			clip.value = loaded;
			favorited.value = clip.value!.isFavorited ?? false;
		}
	} catch { if (current === generation) { clip.value = null; peerError.value = true; } } finally { if (current === generation) checking = false; }
}

watch(() => [props.clipId, props.peer], () => { generation++; checking = false; clip.value = null; managedClipId.value = null; void loadClip(); }, { immediate: true });
provide('currentClip', computed(() => isPeer.value ? null : clip.value));

function suspendPeer() { if (isPeer.value) { generation++; checking = false; clip.value = null; } }

function visibility() { if (window.document.hidden) suspendPeer(); else if (isPeer.value) void loadClip(); }

window.document.addEventListener('visibilitychange', visibility);
const timer = window.setInterval(() => { if (isPeer.value) void loadClip(); }, 15000);
onDeactivated(() => { active = false; suspendPeer(); });
onActivated(() => { if (!active) { active = true; if (isPeer.value) void loadClip(); } });
onBeforeUnmount(() => { active = false; generation++; window.clearInterval(timer); window.document.removeEventListener('visibilitychange', visibility); });

async function setFavorite(value: boolean) {
	if (favoriteBusy.value || !clip.value) return;
	const clipId = props.clipId;
	const peer = isPeer.value;
	generation++; checking = false; favoriteBusy.value = true;
	try {
		await os.apiWithDialog(value ? 'clips/favorite' : 'clips/unfavorite', { clipId: peer ? `gridspace:clip:${clipId}` : clipId });
		if (props.clipId !== clipId || isPeer.value !== peer) return;
		favorited.value = value;
	} finally {
		favoriteBusy.value = false;
		void loadClip();
	}
}

function favorite() { return setFavorite(true); }

async function unfavorite() {
	const clipId = props.clipId;
	const peer = isPeer.value;
	const confirm = await os.confirm({ type: 'warning', text: i18n.ts.unfavoriteConfirm });
	if (!confirm.canceled && props.clipId === clipId && isPeer.value === peer) await setFavorite(false);
}

const headerActions = computed<PageHeaderItem[] | null>(() => clip.value && isOwned.value ? [{
	icon: 'ti ti-pencil',
	text: i18n.ts.edit,
	handler: async (): Promise<void> => {
		if (clip.value == null) return;

		const { canceled, result } = await os.form(clip.value.name, {
			name: {
				type: 'string',
				label: i18n.ts.name,
				default: clip.value.name,
			},
			description: {
				type: 'string',
				required: false,
				multiline: true,
				treatAsMfm: true,
				label: i18n.ts.description,
				default: clip.value.description,
			},
			isPublic: {
				type: 'boolean',
				label: i18n.ts.public,
				default: clip.value.isPublic,
			},
		});

		if (canceled) return;

		await os.apiWithDialog('clips/update', {
			clipId: managedClipId.value ?? clip.value.id,
			...result,
		});
		await loadClip();

		clipsCache.delete();
	},
}, ...(clip.value.isPublic ? [{
	icon: 'ti ti-share',
	text: i18n.ts.share,
	handler: (ev): void => {
		const menuItems: MenuItem[] = [];

		menuItems.push({
			icon: 'ti ti-link',
			text: i18n.ts.copyUrl,
			action: () => {
				copyToClipboard(sourceUrl.value);
			},
		}, {
			icon: 'ti ti-code',
			text: i18n.ts.embed,
			action: () => {
				if (isPeer.value) copyToClipboard(`<iframe src="${peerOrigin.value}/embed/clips/${props.clipId}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" style="border:none;width:100%;height:700px"></iframe>\n<script defer src="${peerOrigin.value}/embed.js"><\/script>`);
				else genEmbedCode('clips', clip.value!.id);
			},
		});

		if (isSupportShare()) {
			menuItems.push({
				icon: 'ti ti-share',
				text: i18n.ts.share,
				action: async () => {
					navigator.share({
						title: clip.value!.name,
						text: clip.value!.description ?? '',
						url: sourceUrl.value,
					});
				},
			});
		}

		os.popupMenu(menuItems, ev.currentTarget ?? ev.target);
	},
}] satisfies PageHeaderItem[] : []), {
	icon: 'ti ti-trash',
	text: i18n.ts.delete,
	danger: true,
	handler: async (): Promise<void> => {
		if (clip.value == null) return;

		const { canceled } = await os.confirm({
			type: 'warning',
			text: i18n.tsx.deleteAreYouSure({ x: clip.value.name }),
		});
		if (canceled) return;

		await os.apiWithDialog('clips/delete', {
			clipId: managedClipId.value ?? clip.value.id,
		});
		clip.value = null;

		clipsCache.delete();
	},
}] satisfies PageHeaderItem[] : null);

definePage(() => ({
	title: clip.value ? clip.value.name : i18n.ts.clip,
	icon: 'ti ti-paperclip',
}));
</script>

<style lang="scss" module>
.description {
	padding: 16px;
}

.user {
	--height: 32px;
	padding: 16px;
	border-top: solid 0.5px var(--MI_THEME-divider);
	line-height: var(--height);
}

.avatar {
	width: var(--height);
	height: var(--height);
}
.source { margin-left: 8px; color: var(--MI_THEME-fgTransparentWeak); font-size: .85em; }
</style>
