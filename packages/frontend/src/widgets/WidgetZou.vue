<template>
  <MkContainer>
    <template #header>🐘銀</template>
    <div class="container">
      <div>
        <div>
          <div>残高:</div>
          <span>{{ 12 }}</span>
        </div>
      </div>
      <div>
        <img src="https://misskey.resonite.love/twemoji/1f418.svg"/>
      </div>
    </div>
    <MkSpacer/>
    <div style="margin-left: 20px">えらいボタン</div>
    <div class="button-box">
      <MkButton>お風呂に入った</MkButton>
      <MkButton>ご飯を食べた</MkButton>
      <MkButton>ちゃんと寝た</MkButton>
      <MkButton>運動した</MkButton>
    </div>
  </MkContainer>
</template>

<script lang="ts" setup>
import {ref, watch} from 'vue';
import {useWidgetPropsManager, WidgetComponentEmits, WidgetComponentExpose, WidgetComponentProps} from './widget';
import {GetFormResultType} from '@/scripts/form';
import MkContainer from '@/components/MkContainer.vue';
import {defaultStore} from '@/store';
import number from "@/filters/number.js";
import MkButton from "@/components/MkButton.vue";

const name = 'zou';
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

.container > div {
  flex: 1;
  height: 80px;
}

.container > div > img {
  height: 80px;
}

.container > div > div {
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: space-evenly;
}

.container > div > div > span {
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
