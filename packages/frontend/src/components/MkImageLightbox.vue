<template>
  <div :class="$style.overlay" @click.self="close" tabindex="0" @click="close">
    <div :class="$style.modal">
      <button :class="$style.close" @click="close" aria-label="閉じる">×</button>
      <img :src="src" :alt="alt" :class="$style.img" />
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, onMounted, onBeforeUnmount } from 'vue';

export default defineComponent({
  name: 'MkImageLightbox',
  props: {
    src: { type: String, required: true },
    alt: { type: String, required: false }
  },
  emits: ['close'],
  methods: {
    close() {
      this.$emit('close');
    },
    onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') this.close();
    }
  },
  mounted() {
    window.addEventListener('keydown', this.onKey);
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onKey);
  }
});
</script>

<style lang="scss" module>
.overlay {
  position: fixed;
  z-index: 9999;
  inset: 0;
  background: rgba(0,0,0,0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadein 0.15s;
}
@keyframes fadein {
  from { opacity: 0; }
  to { opacity: 1; }
}
.modal {
  position: relative;
  background: #222;
  border-radius: 14px;
  box-shadow: 0 0 40px #000b, 0 2px 16px #0006;
  padding: 32px 32px 24px 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 320px;
  max-width: 96vw;
  max-height: 96vh;
}
.img {
  max-width: 80vw;
  max-height: 70vh;
  border-radius: 10px;
  box-shadow: 0 0 32px #000a;
  background: #222;
  object-fit: contain;
  margin-bottom: 18px;
}
.caption {
  color: #fff;
  font-size: 1.05em;
  margin-top: 0;
  text-align: center;
  word-break: break-all;
  max-width: 80vw;
  opacity: 0.85;
}
.close {
  position: absolute;
  top: 12px;
  right: 18px;
  font-size: 2.2em;
  color: #fff;
  background: none;
  border: none;
  cursor: pointer;
  z-index: 10000;
  padding: 0 0.2em;
  line-height: 1;
  opacity: 0.7;
  transition: opacity 0.2s;
}
.close:hover {
  opacity: 1;
}
</style>
