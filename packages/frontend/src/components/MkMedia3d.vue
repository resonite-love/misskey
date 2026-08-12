<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
	<div :class="$style.root">
		<button v-if="hide" type="button" class="_button" :class="$style.sensitive" @click="reveal">
			<span :class="$style.icon"><i class="ti ti-alert-triangle"></i></span>
			<span :class="$style.fileInfo">
				<b>{{ i18n.ts.sensitive }}</b>
				<span>{{ formatLabel }} · {{ bytes(media.size, 1) }} · {{ i18n.ts.clickToShow }}</span>
			</span>
		</button>
		<button
			v-else-if="!expanded"
			type="button"
			class="_button"
			:class="$style.previewButton"
			@click="openPreview"
		>
			<span :class="$style.icon"><i class="ti ti-cube"></i></span>
			<span :class="$style.fileInfo">
				<b>{{ media.name }}</b>
				<span>{{ formatLabel }} · {{ bytes(media.size, 1) }} · {{ i18n.ts.preview }}</span>
			</span>
			<i class="ti ti-chevron-right"></i>
		</button>
		<div v-else :class="$style.viewer">
			<canvas
				ref="canvas"
				:class="$style.canvas"
				:aria-label="`${i18n.ts.preview}: ${media.name}`"
			></canvas>
			<div :class="$style.toolbar">
				<span :class="$style.viewerFileName">{{ media.name }}</span>
				<a
					:class="$style.control"
					:href="media.url"
					:download="media.name"
					:title="i18n.ts.download"
					:aria-label="i18n.ts.download"
				>
					<i class="ti ti-download"></i>
				</a>
				<button
					type="button"
					class="_button"
					:class="$style.control"
					:title="i18n.ts.close"
					:aria-label="i18n.ts.close"
					@click="closePreview"
				>
					<i class="ti ti-x"></i>
				</button>
			</div>
			<div v-if="status === 'loading'" :class="$style.status">
				<MkLoading />
				<span>{{ i18n.ts.loading }}</span>
			</div>
			<div v-else-if="status === 'error'" :class="$style.status">
				<i class="ti ti-alert-circle"></i>
				<span>{{ i18n.ts.cannotLoad }}</span>
				<MkButton small @click="loadViewer">{{ i18n.ts.retry }}</MkButton>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { nextTick, onBeforeUnmount, ref, useTemplateRef } from "vue";
import type * as Misskey from "misskey-js";
import MkButton from "@/components/MkButton.vue";
import bytes from "@/filters/bytes.js";
import { i18n } from "@/i18n.js";
import { getThreeDFileFormat } from "@/utility/three-d-file.js";
import {
	shouldHideFileByDefault,
	canRevealFile,
} from "@/utility/sensitive-file.js";
import type { ThreeDViewer } from "@/utility/three-d-viewer.js";

const props = defineProps<{
	media: Misskey.entities.DriveFile;
}>();

const canvas = useTemplateRef("canvas");
const formatLabel = getThreeDFileFormat(props.media)?.toUpperCase() ?? props.media.type;
const hide = ref(shouldHideFileByDefault(props.media));
const expanded = ref(false);
const status = ref<"idle" | "loading" | "ready" | "error">("idle");
let viewer: ThreeDViewer | null = null;
let abortController: AbortController | null = null;

async function reveal() {
	if (!(await canRevealFile(props.media))) return;
	hide.value = false;
}

async function openPreview() {
	expanded.value = true;
	await nextTick();
	await loadViewer();
}

async function loadViewer() {
	const targetCanvas = canvas.value;
	const format = getThreeDFileFormat(props.media);
	if (targetCanvas == null || format == null) return;

	disposeViewer();
	status.value = "loading";
	abortController = new AbortController();
	const currentController = abortController;

	try {
		const { createThreeDViewer } = await import("@/utility/three-d-viewer.js");
		if (currentController.signal.aborted) return;
		const loadedViewer = await createThreeDViewer({
			canvas: targetCanvas,
			file: props.media,
			format,
			signal: currentController.signal,
		});
		if (currentController.signal.aborted) {
			loadedViewer.dispose();
			return;
		}
		viewer = loadedViewer;
		status.value = "ready";
	} catch (error) {
		if (currentController.signal.aborted) return;
		console.error("Failed to load 3D preview", error);
		status.value = "error";
	}
}

function closePreview() {
	disposeViewer();
	expanded.value = false;
	status.value = "idle";
}

function disposeViewer() {
	abortController?.abort();
	abortController = null;
	viewer?.dispose();
	viewer = null;
}

onBeforeUnmount(disposeViewer);
</script>

<style lang="scss" module>
.root {
	container-type: inline-size;
	width: 100%;
	margin-top: 4px;
	overflow: clip;
	border: solid 1px var(--MI_THEME-divider);
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-panel);
}

.previewButton,
.sensitive {
	display: flex;
	align-items: center;
	gap: 12px;
	width: 100%;
	padding: 12px;
	border: 0;
	color: inherit;
	font: inherit;
	text-align: left;
	cursor: pointer;
}

.previewButton {
	background: var(--MI_THEME-panel);

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}
}

.sensitive {
	background: var(--MI_THEME-bg);
}

.icon {
	display: grid;
	place-items: center;
	width: 36px;
	height: 36px;
	flex: 0 0 auto;
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-accentedBg);
	color: var(--MI_THEME-accent);
	font-size: 20px;
}

.fileInfo {
	display: flex;
	min-width: 0;
	flex: 1;
	flex-direction: column;
	gap: 2px;
	font-size: 12px;

	> b {
		overflow: hidden;
		font-size: 13px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	> span {
		opacity: 0.7;
	}
}

.viewer {
	position: relative;
	height: clamp(240px, 56cqw, 480px);
	background: var(--MI_THEME-bg);
}

.canvas {
	display: block;
	width: 100%;
	height: 100%;
	touch-action: none;
}

.toolbar {
	position: absolute;
	z-index: 1;
	top: 0;
	right: 0;
	left: 0;
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 8px;
	background: linear-gradient(
		to bottom,
		color-mix(in srgb, var(--MI_THEME-bg) 80%, transparent),
		transparent
	);
	pointer-events: none;
}

.viewerFileName {
	min-width: 0;
	flex: 1;
	overflow: hidden;
	font-size: 12px;
	font-weight: bold;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.control {
	display: grid;
	place-items: center;
	width: 32px;
	height: 32px;
	padding: 0;
	border: solid 1px var(--MI_THEME-divider);
	border-radius: 999px;
	background: var(--MI_THEME-panel);
	color: var(--MI_THEME-fg);
	font: inherit;
	cursor: pointer;
	pointer-events: auto;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}
}

.status {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-direction: column;
	gap: 12px;
	background: color-mix(in srgb, var(--MI_THEME-bg) 86%, transparent);
	font-size: 13px;
}
</style>
