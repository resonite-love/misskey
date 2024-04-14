<template>
	<MkContainer>
		<template #header>🐘銀</template>
		<div v-if="isUserRegistered">
			<div class="container">
				<div id="zandaka">
					残高:
				</div>
				<div id="balance">
					<span>{{ bankData?.balance ?? "---" }}</span>
				</div>
				<div>
					<img src="https://misskey.resonite.love/twemoji/1f418.svg"/>
				</div>
			</div>
			<MkSpacer/>
			<div style="margin-left: 20px">えらいボタン</div>
			<div class="button-box">
				<MkButton @click="doFuro">お風呂🛀に入った</MkButton>
			</div>
			<div style="text-align: center">
				<p>最後の🛀 {{!furoData?.furos?.length ? "まだ" : new Date(furoData?.furos[furoData?.furos?.length - 1].time).toLocaleString()}}</p>
				<p>いまお風呂に入ると {{furoData?.currentReward}}🐘もらえます</p>
				<p>お風呂に入るとホームに投稿されます</p>
			</div>
		</div>
		<div v-else>
			<div class="container2">
				<div>
					<p>🐘Resonite.Loveが登録されていないか、Misskeyと連携されていません</p>
					<a class="_link" href="https://auth.resonite.love/" target="_blank">こちら</a>から登録/連携してください
				</div>
			</div>
		</div>
	</MkContainer>
</template>

<script lang="ts" setup>
import {nextTick, onMounted, ref, watch} from 'vue';
import {useWidgetPropsManager, WidgetComponentEmits, WidgetComponentExpose, WidgetComponentProps} from './widget';
import {GetFormResultType} from '@/scripts/form';
import MkContainer from '@/components/MkContainer.vue';
import MkButton from '@/components/MkButton.vue';

import {$i, getAccounts} from '@/account.js';
import {misskeyApi} from "@/scripts/misskey-api.js";
import * as misskey from "misskey-js";

const name = 'zou';

console.log($i);

const isUserRegistered = ref(false);
const userData = ref(null);
const bankData = ref(null);
const furoData = ref(null);

onMounted(async () => {
	console.log('mounted');
	console.log("id", $i.id);
	const authUser = await fetch("https://auth.resonite.love/api/user/search?misskeyId=" + $i.id);
	const authResult = await authUser.json();
	if(authResult.success) {
		isUserRegistered.value = true;
		console.log(authResult.data);
		userData.value = authResult.data;
		const bankUser = await fetch("https://zoubank.resonite.love/api/user/" + authResult.data.resoniteUserId);
		const bankResult = await bankUser.json();
		if(bankUser.status === 200) {
			console.log(bankResult);
			bankData.value = bankResult;

			const furoUser = await fetch("https://qol.kokoa.dev/user/furo/" + authResult.data.resoniteUserId);
			const furoResult = await furoUser.json();
			if(furoUser.status === 200) {
				console.log(furoResult);
				furoData.value = furoResult;
			}
		}
	}
});

function doFuro() {
	fetch("https://qol.kokoa.dev/user/furo/" + userData.value.resoniteUserId, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
	}).then(async res => {

		const furoResult = await res.json();

		console.log("i", $i);


		if(furoResult.message === "First time furo") {
			const postData = {
				text: `${$i.name ?? $i.username}は初めてお風呂に入りました！！🎉🎉🎉🎉`,
				visibility: "home"
			};
			await misskeyApi('notes/create', postData)
		} else {

			const postData = {
				text: `${$i.name ?? $i.username}は${secondsToHms(furoResult.span)}ぶりにお風呂に入りました🛀
今回のお風呂で${furoResult.reward}🐘を獲得しました！`,
				visibility: "home"
			};
			//
			await misskeyApi('notes/create', postData)
		}

		if (res.status === 200) {
			console.log(furoResult);
			const authUser = await fetch("https://auth.resonite.love/api/user/search?misskeyId=" + $i.id);
			const authResult = await authUser.json();
			if(authResult.success) {
				console.log(authResult.data);
				userData.value = authResult.data;
				const bankUser = await fetch("https://zoubank.resonite.love/api/user/" + authResult.data.resoniteUserId);
				const bankResult = await bankUser.json();
				if(bankUser.status === 200) {
					console.log(bankResult);
					bankData.value = bankResult;

					const furoUser = await fetch("https://qol.kokoa.dev/user/furo/" + authResult.data.resoniteUserId);
					const furoResult = await furoUser.json();
					if(furoUser.status === 200) {
						console.log(furoResult);
						furoData.value = furoResult;
					}
				}
			}
		}
	});
}

// 秒を時分秒に変換(日本語
const secondsToHms = (d: number) => {
	d = Number(d) / 1000;
	const h = Math.floor(d / 3600);
	const m = Math.floor(d % 3600 / 60);
	const s = Math.floor(d % 3600 % 60);
	const hDisplay = h > 0 ? h + (h === 1 ? "時間" : "時間") : "";
	const mDisplay = m > 0 ? m + (m === 1 ? "分" : "分") : "";
	const sDisplay = s > 0 ? s + (s === 1 ? "秒" : "秒") : "";
	return hDisplay + mDisplay + sDisplay;
};

// const saveSettings = () => {
// 	defaultStore.set('widgetZou', {
// 	});
// };
// watch(() => toggleValue.value, () => {
// 	saveSettings();
// });
// watch(() => defaultStore.reactiveState.morse, newSettings => {
// 	toggleValue.value = newSettings.toggle.value;
// 	rangeValue.value = newSettings.freq.value;
// 	volume.value = newSettings.volume.value;
// });

const widgetPropsDef = {
	sound: {
		type: 'boolean' as const,
		default: true,
	},
};

type WidgetProps = GetFormResultType<typeof widgetPropsDef>;

const props = defineProps<WidgetComponentProps<WidgetProps>>();
const emit = defineEmits<WidgetComponentEmits<WidgetProps>>();

const {widgetProps, configure} = useWidgetPropsManager(name,
	widgetPropsDef,
	props,
	emit,
);

defineExpose<WidgetComponentExpose>({
	name,
	configure,
	id: props.widget ? props.widget.id : null,
});
</script>

<style scoped>
.container {
	width: 90%;
	margin: 0 auto;
	display: flex;
	flex-direction: row;
}

.container2 {
	width: 90%;
	margin: 0 auto;
	display: flex;
	flex-direction: row;
}

.container2 > div {
	padding-bottom: 1em;
}

.container > div {
	height: 80px;
}

.container > #zandaka {
	height: 80px;
	display: flex;
	align-items: end;
	justify-content: space-evenly;
	font-weight: bold;
}

.container > div > img {
	height: 80px;
}

.container > #balance {
	height: 80px;
	display: flex;
	align-items: center;
	justify-content: end;
	padding-right: 10px;
	flex-grow: 1;
}

.container > div > span {
	margin-top: auto;
	font-size: 50px;
	font-weight: bold;
}

.container > div > div > div {
	margin-top: auto;
	margin-bottom: 10px;
}

.button-box {
	display: flex;
	flex-wrap: wrap;
	flex-direction: row;
	justify-content: space-evenly;
	gap: 10px;
	margin: 10px;
}

</style>
