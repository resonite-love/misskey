<template>
  <div :class="$style.wrap" @click="handleBlurClick" :tabindex="0" v-if="!showMedium">
    <img :src="srcBlur" :alt="alt" :class="$style.img" draggable="false" />
    <div :class="$style.overlay">
      <span :class="$style.text">センシティブな画像</span>
    </div>
  </div>
  <img
    v-else
    :src="srcMedium"
    :alt="alt"
    :class="$style.img"
    draggable="false"
    @click="onPreviewClick && onPreviewClick()"
    style="cursor: pointer;"
  />
</template>

<script lang="ts" setup>
import { ref } from 'vue';

const props = defineProps<{
  srcBlur: string;
  srcMedium: string;
  alt?: string;
  onPreviewClick?: () => void;
}>();

const showMedium = ref(false);

function handleBlurClick() {
  showMedium.value = true;
}
</script>

<style lang="scss" module>
.wrap {
  position: relative;
  display: inline-block;
  cursor: pointer;
  width: 220px;
  height: 140px;
  border-radius: 7px;
  overflow: hidden;
  background: #222;
  user-select: none;
}
.img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 7px;
  display: block;
  background: #222;
}
.wrap > .img {
  pointer-events: none;
}
.overlay {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(30,30,30,0.55);
  color: #fff;
  font-size: 1.1em;
  font-weight: bold;
  pointer-events: none;
  z-index: 2;
}
.text {
  background: rgba(0,0,0,0.5);
  padding: 8px 18px;
  border-radius: 8px;
  font-size: 1em;
  letter-spacing: 0.05em;
}
</style>
