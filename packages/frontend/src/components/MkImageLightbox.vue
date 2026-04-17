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

<script lang="ts" setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';

defineProps<{
	src: string;
	alt?: string;
}>();

const emit = defineEmits<{
	(ev: 'close'): void;
}>();

const scale = ref(1);
const translateX = ref(0);
const translateY = ref(0);
const dragging = ref(false);
const lastX = ref(0);
const lastY = ref(0);
const touching = ref(false);
const lastTouchDist = ref(0);
const lastTouchMid = ref({ x: 0, y: 0 });
const suppressClose = ref(false);
let suppressCloseTimeout: number | null = null;

const imgStyle = computed(() => ({
	transform: `scale(${scale.value}) translate(${translateX.value}px, ${translateY.value}px)`,
	cursor: scale.value > 1 ? (dragging.value ? 'grabbing' : 'grab') : 'auto',
	transition: dragging.value || touching.value ? 'none' : 'transform 0.2s',
}));

function close() {
	emit('close');
}

function onKey(e: KeyboardEvent) {
	if (e.key === 'Escape') close();
}

function onOverlayClick() {
	if (suppressClose.value) return;
	close();
}

function onWheel(e: WheelEvent) {
	e.preventDefault();
	const delta = e.deltaY < 0 ? 0.1 : -0.1;
	let nextScale = scale.value + delta;
	if (nextScale < 1) nextScale = 1;
	if (nextScale > 6) nextScale = 6;
	scale.value = nextScale;
}

function onMouseDown(e: MouseEvent) {
	if (scale.value === 1) return;
	dragging.value = true;
	lastX.value = e.clientX;
	lastY.value = e.clientY;
	suppressClose.value = true;
}

function onMouseMove(e: MouseEvent) {
	if (!dragging.value) return;
	const dx = e.clientX - lastX.value;
	const dy = e.clientY - lastY.value;
	translateX.value += dx;
	translateY.value += dy;
	lastX.value = e.clientX;
	lastY.value = e.clientY;
}

function onMouseUp() {
	dragging.value = false;
	if (suppressClose.value) {
		if (suppressCloseTimeout) {
			clearTimeout(suppressCloseTimeout);
		}
		suppressCloseTimeout = window.setTimeout(() => {
			suppressClose.value = false;
			suppressCloseTimeout = null;
		}, 120);
	}
}

function onTouchStart(e: TouchEvent) {
	if (e.touches.length === 1) {
		touching.value = true;
		lastX.value = e.touches[0].clientX;
		lastY.value = e.touches[0].clientY;
		suppressClose.value = false;
	} else if (e.touches.length === 2) {
		touching.value = true;
		const dx = e.touches[0].clientX - e.touches[1].clientX;
		const dy = e.touches[0].clientY - e.touches[1].clientY;
		lastTouchDist.value = Math.sqrt(dx * dx + dy * dy);
		lastTouchMid.value = {
			x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
			y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
		};
		suppressClose.value = true;
	}
}

function onTouchMove(e: TouchEvent) {
	if (e.touches.length === 1 && touching.value) {
		const dx = e.touches[0].clientX - lastX.value;
		const dy = e.touches[0].clientY - lastY.value;
		translateX.value += dx;
		translateY.value += dy;
		lastX.value = e.touches[0].clientX;
		lastY.value = e.touches[0].clientY;
	} else if (e.touches.length === 2) {
		const dx = e.touches[0].clientX - e.touches[1].clientX;
		const dy = e.touches[0].clientY - e.touches[1].clientY;
		const dist = Math.sqrt(dx * dx + dy * dy);
		const scaleDelta = dist / lastTouchDist.value;
		let nextScale = scale.value * scaleDelta;
		if (nextScale < 1) nextScale = 1;
		if (nextScale > 6) nextScale = 6;
		scale.value = nextScale;
		lastTouchDist.value = dist;
	}
}

function onTouchEnd() {
	touching.value = false;
	lastTouchDist.value = 0;
	if (suppressClose.value) {
		if (suppressCloseTimeout) {
			clearTimeout(suppressCloseTimeout);
		}
		suppressCloseTimeout = window.setTimeout(() => {
			suppressClose.value = false;
			suppressCloseTimeout = null;
		}, 120);
	}
}

onMounted(() => {
	window.addEventListener('keydown', onKey);
	window.addEventListener('mousemove', onMouseMove);
	window.addEventListener('mouseup', onMouseUp);
});

onBeforeUnmount(() => {
	window.removeEventListener('keydown', onKey);
	window.removeEventListener('mousemove', onMouseMove);
	window.removeEventListener('mouseup', onMouseUp);
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
