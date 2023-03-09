<template>
<div>
	{{ text }}
</div>
</template>

<script lang="ts" setup>
import { nextTick, ref } from 'vue';
import * as misskey from 'misskey-js';
import { Channel, DriveFile, Note, User } from 'misskey-js/built/entities';
import { stream } from '@/stream';
import * as os from '@/os';
import { defaultStore } from '@/store';
import { getAccounts, incNotesCount, notesCount } from '@/account';

const marker = Math.random().toString();
const connection = stream.useChannel('main');

const text = ref<string>('direct-upload!!');

let queryString = window.location.search;
let urlParams = new URLSearchParams(queryString);

let imageUrl = decodeURIComponent(urlParams.get('imageUrl'));
let noteText = decodeURIComponent(urlParams.get('noteText'));
let localOnly = urlParams.get('localOnly') === 'true';
let visibility = urlParams.get('visibility') ?? 'public';

console.log(imageUrl, noteText, localOnly, visibility);

type v = 'public' | 'home' | 'followers'

connection.on('urlUploadFinished', async urlResponse => {
	console.log('urlUploadFinished');
	if (urlResponse.marker === marker) {
		console.log(urlResponse.file);
		connection.dispose();
		await post(urlResponse.file.id);
	}
});

setTimeout(async () => {
	console.log('timeout');
	if (imageUrl == 'null') {
		console.log('textonly post');
		await post();
		return;
	}

	os.api('drive/files/upload-from-url', {
		url: imageUrl,
		folderId: defaultStore.state.uploadFolder,
		marker,
	});
}, 1000);

const post = async (id = null) => {
	let postAccount = $ref<misskey.entities.UserDetailed | null>(null);
	let token = undefined;

	if (postAccount) {
		const storedAccounts = await getAccounts();
		token = storedAccounts.find(x => x.id === postAccount.id)?.token;
	}

	// let postData = {
	// 	text: noteText,
	// 	fileIds: id ? [id] : undefined,
	// 	replyId: undefined,
	// 	renoteId: undefined,
	// 	channelId: undefined,
	// 	poll: null,
	// 	cw: undefined,
	// 	localOnly: localOnly,
	// 	visibility: 'public',
	// 	visibleUserIds: undefined,
	// };

	let postData = {
		text: noteText ?? undefined,
		fileIds: id ? [id] : undefined,
	};

	os.api('notes/create', postData, token).then(() => {
		console.log('POST OK');
		nextTick(() => {
			console.log('Next Tick');
			text.value = '投稿完了！このタブを閉じても大丈夫です。';
			window.close();
		});
	}).catch(err => {
		text.value = 'エラー発生。管理者に問い合わせてください。';
		console.log('post error');
	});
};

</script>

<style lang="scss" scoped>
.mjndxjch {
	padding: 32px;
	text-align: center;

	> p {
		margin: 0 0 12px 0;
	}

	> .button {
		margin: 8px auto;
	}

	> img {
		vertical-align: bottom;
		height: 128px;
		margin-bottom: 24px;
		border-radius: 16px;
	}

	> .error {
		opacity: 0.7;
	}
}
</style>
