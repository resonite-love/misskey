<template>
<div class="catalist__modal__overlay" tabindex="0" @click.self="close" @click="close">
	<div class="catalist__modal__modal">
		<button class="catalist__modal__close" aria-label="閉じる" @click="close">×</button>
		<img :src="src" :alt="alt" class="catalist__modal__img"/>
	</div>
</div>
</template>

<script lang="ts">
import { defineComponent, onMounted, onBeforeUnmount } from 'vue';

export default defineComponent({
	name: 'MkImageLightbox',
	props: {
		src: { type: String, required: true },
		alt: { type: String, required: false },
	},
	emits: ['close'],
	mounted() {
		window.addEventListener('keydown', this.onKey);
	},
	beforeUnmount() {
		window.removeEventListener('keydown', this.onKey);
	},
	methods: {
		close() {
			this.$emit('close');
		},
		onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') this.close();
		},
	},
});
</script>

<style>
.catalist__modal__overlay {
  position: fixed;
  z-index: 9999;
  inset: 0;
  background: rgba(0,0,0,0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: catalist__modal__fadein 0.15s;
}
@keyframes catalist__modal__fadein {
  from { opacity: 0; }
  to { opacity: 1; }
}
.catalist__modal__modal {
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
.catalist__modal__img {
  max-width: 80vw;
  max-height: 70vh;
  border-radius: 10px;
  box-shadow: 0 0 32px #000a;
  background: #222;
  object-fit: contain;
  margin-bottom: 18px;
}
.catalist__modal__caption {
  color: #fff;
  font-size: 1.05em;
  margin-top: 0;
  text-align: center;
  word-break: break-all;
  max-width: 80vw;
  opacity: 0.85;
}
.catalist__modal__close {
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
.catalist__modal__close:hover {
  opacity: 1;
}
</style>
