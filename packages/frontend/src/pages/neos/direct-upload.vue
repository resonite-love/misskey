<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div role="status">
	{{ status }}
</div>
</template>

<script lang="ts" setup>
import { nextTick, onUnmounted, ref } from 'vue';
import { noteVisibilities } from 'misskey-js';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import { useStream } from '@/stream.js';
import { misskeyApi } from '@/utility/misskey-api.js';

const params = new URLSearchParams(window.location.search);
const requestedVisibility = params.get('visibility') ?? 'public';
const visibility = noteVisibilities.find(value => value === requestedVisibility);
const status = ref(i18n.ts.processing);

if (visibility === undefined) {
	status.value = i18n.ts.invalidParamError;
} else {
	start(visibility);
}

function start(visibility: typeof noteVisibilities[number]) {
	const noteText = readLegacyParameter('noteText');
	const imageUrl = readLegacyParameter('imageUrl');
	const uploadUrl = imageUrl === 'null' ? null : imageUrl;
	const postData = {
		text: noteText || undefined,
		visibility,
		localOnly: params.get('localOnly') === 'true',
		noRelay: params.get('noRelay') === 'true',
		visibleUserIds: visibility === 'specified' ? params.get('visibleUserIds')?.split(',').filter(Boolean) : undefined,
	};

	const marker = Math.random().toString();
	let connection = uploadUrl ? useStream().useChannel('main') : null;

	function disposeUploadConnection() {
		connection?.dispose();
		connection = null;
	}

	connection?.on('urlUploadFinished', response => {
		if (response.marker !== marker) return;
		disposeUploadConnection();
		void post(response.file.id);
	});

	const timer = window.setTimeout(() => {
		if (!uploadUrl) {
			void post();
			return;
		}

		void misskeyApi('drive/files/upload-from-url', {
			url: uploadUrl,
			folderId: prefer.s.uploadFolder,
			marker,
		}).catch(() => {
			disposeUploadConnection();
			status.value = i18n.ts.error;
		});
	}, 1000);

	onUnmounted(() => {
		window.clearTimeout(timer);
		disposeUploadConnection();
	});

	async function post(fileId?: string) {
		try {
			await misskeyApi('notes/create', {
				...postData,
				fileIds: fileId ? [fileId] : undefined,
			});
			status.value = i18n.ts.done;
			await nextTick();
			window.close();
		} catch {
			status.value = i18n.ts.error;
		}
	}
}

function readLegacyParameter(name: string): string | null {
	const value = params.get(name);
	if (value === null) return null;
	// Older integrations encode the image URL and text before building the query string.
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
</script>
