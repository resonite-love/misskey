<template>
<MkContainer>
	<template #header>Morse</template>
	<div class="container">
		<MkSwitch v-model="toggleValue" label="i18n.ts.sound">
			<template #caption>sound</template>
		</MkSwitch>
		<MkRange v-model="rangeValue" :min="200" :max="2000">
			<template #label>frequency</template>
		</MkRange>
		<MkRange v-model="volume" :min="0" :max="100">
			<template #label>volume</template>
		</MkRange>
		<p>ws: {{ wsState }}</p>
		<p>state: {{ soundState }}</p>
		<button @pointerdown="onMouseDown" @pointerup="onMouseUp">BEEP</button>
	</div>
</MkContainer>
</template>

<script lang="ts" setup>
import { ref, watch } from 'vue';
import { useWidgetPropsManager, WidgetComponentEmits, WidgetComponentExpose, WidgetComponentProps } from './widget';
import { GetFormResultType } from '@/scripts/form';
import MkContainer from '@/components/MkContainer.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkRange from '@/components/MkRange.vue';
import { getAccounts } from '@/account';
import { defaultStore } from '@/store';

const name = 'morse';
const randomName = () => {
	const chars = 'abcdefghijklmnopqrstuvwxyz';
	let result = '';
	for (let i = 0; i < 3; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
};

const toggleValue = ref(defaultStore.state.morse?.toggle || false);
const rangeValue = ref(defaultStore.state.morse?.freq || 440);
const volume = ref(defaultStore.state.morse?.volume || 50);
const soundState = ref(false);
const wsState = ref(false);

let connection = new WebSocket('wss://wsecho.kokoa.dev/kokoa/radio/1');
const audioContext = new AudioContext();
let oscillator = audioContext.createOscillator();

connection.onopen = () => {
	wsState.value = true;
};

let processing = ref(false);

connection.onmessage = (evt) => {
	console.log(evt.data);
	const [id, freq, command] = evt.data.split(':');

	if (command === 'play') {
		if (toggleValue.value === false) return;
		if (processing.value || soundState.value) return;

		soundState.value = true;
		processing.value = true;
		oscillator = audioContext.createOscillator();
		oscillator.frequency.value = parseInt(freq);
		oscillator.type = 'sine';
		// volume
		const gainNode = audioContext.createGain();
		gainNode.gain.value = volume.value / 100;
		console.log(volume.value / 100);
		oscillator.connect(gainNode);
		gainNode.connect(audioContext.destination);

		// oscillator.connect(audioContext.destination);
		oscillator.start();
		processing.value = false;
		// oscillator.stop(audioContext.currentTime + 0.1);
	} else if (command === 'stop') {
		soundState.value = false;
		if (toggleValue.value === false) return;
		oscillator.stop(audioContext.currentTime);
		oscillator = null;
	}
};

connection.onclose = () => {
	wsState.value = false;
	// reconnect
	connection = new WebSocket('wss://wsecho.kokoa.dev/kokoa/radio/1');
};

const onMouseDown = () => {
	connection.send(`${randomName()}:${rangeValue.value}:play`);
};

const onMouseUp = () => {
	connection.send(`${randomName()}:${rangeValue.value}:stop`);
};

const saveSettings = () => {
	defaultStore.set('morse', {
		toggle: toggleValue.value,
		freq: rangeValue.value,
		volume: volume.value,
	});
};

watch(() => toggleValue.value, () => {
	saveSettings();
});

watch(() => rangeValue.value, () => {
	saveSettings();
});

watch(() => volume.value, () => {
	saveSettings();
});

watch(() => defaultStore.reactiveState.morse, newSettings => {
	toggleValue.value = newSettings.toggle.value;
	rangeValue.value = newSettings.freq.value;
	volume.value = newSettings.volume.value;
});

const widgetPropsDef = {
	sound: {
		type: 'boolean' as const,
		default: true,
	},
};

type WidgetProps = GetFormResultType<typeof widgetPropsDef>;

const props = defineProps<WidgetComponentProps<WidgetProps>>();
const emit = defineEmits<WidgetComponentEmits<WidgetProps>>();

const { widgetProps, configure } = useWidgetPropsManager(name,
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

}

</style>
