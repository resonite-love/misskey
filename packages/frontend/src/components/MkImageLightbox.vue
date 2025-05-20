<template>
<div class="catalist__modal__overlay" tabindex="0" @click.self="onOverlayClick">
	<div class="catalist__modal__modal">
		<button class="catalist__modal__close" aria-label="閉じる" @click="close">×</button>
		<img
			:src="src"
			:alt="alt"
			class="catalist__modal__img"
			:style="imgStyle"
			@wheel="onWheel"
			@mousedown="onMouseDown"
			@touchstart="onTouchStart"
			@touchmove="onTouchMove"
			@touchend="onTouchEnd"
			draggable="false"
		/>
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
	data() {
		return {
			scale: 1,
			translateX: 0,
			translateY: 0,
			dragging: false,
			lastX: 0,
			lastY: 0,
			touching: false,
			lastTouchDist: 0,
			lastTouchMid: { x: 0, y: 0 },
			suppressClose: false,
			suppressCloseTimeout: null as null | number,
		};
	},
	computed: {
		imgStyle() {
			return {
				transform: `scale(${this.scale}) translate(${this.translateX}px, ${this.translateY}px)`,
				cursor: this.scale > 1 ? (this.dragging ? 'grabbing' : 'grab') : 'auto',
				transition: this.dragging || this.touching ? 'none' : 'transform 0.2s',
			};
		},
	},
	mounted() {
		window.addEventListener('keydown', this.onKey);
		window.addEventListener('mousemove', this.onMouseMove);
		window.addEventListener('mouseup', this.onMouseUp);
	},
	beforeUnmount() {
		window.removeEventListener('keydown', this.onKey);
		window.removeEventListener('mousemove', this.onMouseMove);
		window.removeEventListener('mouseup', this.onMouseUp);
	},
	methods: {
		close() {
			this.$emit('close');
		},
		onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') this.close();
		},
		onOverlayClick() {
			if (this.suppressClose) return;
			this.close();
		},
		onWheel(e: WheelEvent) {
			e.preventDefault();
			const delta = e.deltaY < 0 ? 0.1 : -0.1;
			let nextScale = this.scale + delta;
			if (nextScale < 1) nextScale = 1;
			if (nextScale > 6) nextScale = 6;
			this.scale = nextScale;
		},
		onMouseDown(e: MouseEvent) {
			if (this.scale === 1) return;
			this.dragging = true;
			this.lastX = e.clientX;
			this.lastY = e.clientY;
			this.suppressClose = true;
		},
		onMouseMove(e: MouseEvent) {
			if (!this.dragging) return;
			const dx = e.clientX - this.lastX;
			const dy = e.clientY - this.lastY;
			this.translateX += dx;
			this.translateY += dy;
			this.lastX = e.clientX;
			this.lastY = e.clientY;
		},
		onMouseUp() {
			this.dragging = false;
			if (this.suppressClose) {
				if (this.suppressCloseTimeout) {
					clearTimeout(this.suppressCloseTimeout);
				}
				this.suppressCloseTimeout = window.setTimeout(() => {
					this.suppressClose = false;
					this.suppressCloseTimeout = null;
				}, 120);
			}
		},
		onTouchStart(e: TouchEvent) {
			if (e.touches.length === 1) {
				this.touching = true;
				this.lastX = e.touches[0].clientX;
				this.lastY = e.touches[0].clientY;
				this.suppressClose = false;
			} else if (e.touches.length === 2) {
				this.touching = true;
				const dx = e.touches[0].clientX - e.touches[1].clientX;
				const dy = e.touches[0].clientY - e.touches[1].clientY;
				this.lastTouchDist = Math.sqrt(dx * dx + dy * dy);
				this.lastTouchMid = {
					x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
					y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
				};
				this.suppressClose = true;
			}
		},
		onTouchMove(e: TouchEvent) {
			if (e.touches.length === 1 && this.touching) {
				const dx = e.touches[0].clientX - this.lastX;
				const dy = e.touches[0].clientY - this.lastY;
				this.translateX += dx;
				this.translateY += dy;
				this.lastX = e.touches[0].clientX;
				this.lastY = e.touches[0].clientY;
			} else if (e.touches.length === 2) {
				const dx = e.touches[0].clientX - e.touches[1].clientX;
				const dy = e.touches[0].clientY - e.touches[1].clientY;
				const dist = Math.sqrt(dx * dx + dy * dy);
				let scaleDelta = dist / this.lastTouchDist;
				let nextScale = this.scale * scaleDelta;
				if (nextScale < 1) nextScale = 1;
				if (nextScale > 6) nextScale = 6;
				this.scale = nextScale;
				this.lastTouchDist = dist;
			}
		},
		onTouchEnd(e: TouchEvent) {
			this.touching = false;
			this.lastTouchDist = 0;
			if (this.suppressClose) {
				if (this.suppressCloseTimeout) {
					clearTimeout(this.suppressCloseTimeout);
				}
				this.suppressCloseTimeout = window.setTimeout(() => {
					this.suppressClose = false;
					this.suppressCloseTimeout = null;
				}, 120);
			}
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

@media (max-width: 600px) {
  .catalist__modal__modal {
    padding: 4px;
    min-width: 0;
    max-width: 98vw;
    max-height: 90vh;
  }
}
</style>
