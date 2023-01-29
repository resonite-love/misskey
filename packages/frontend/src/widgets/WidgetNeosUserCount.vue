<template>
	<MkContainer :show-header="widgetProps.showHeader">
		<template #header>{{ i18n.ts._widgets.neosUserCount }}</template>
		<div :class="$style.root">
			<div v-if="loaded" :class="$style.flex">
				<div style="width: 100px">
					<svg :class="$style.hsalcinq" viewBox="0 0 1 1" preserveAspectRatio="none">
						<circle
							:r="r"
							cx="50%" cy="50%"
							fill="none"
							stroke-width="0.1"
							stroke="rgba(0, 0, 0, 0.05)"
						/>
						<circle
							:r="r"
							cx="50%" cy="50%"
							:stroke-dasharray="`${vrAngle}`"
							fill="none"
							stroke-width="0.1"
							stroke="#D76FF9"
						/>
						<circle
							:r="r"
							cx="50%" cy="50%"
							:stroke-dasharray="`0, ${vrAngle}, ${desktopAngle}, ${headlessAngle}`"
							fill="none"
							stroke-width="0.1"
							stroke="#6FED51"
						/>
						<circle
							:r="r"
							cx="50%" cy="50%"
							:stroke-dasharray="`0, ${vrAngle + desktopAngle}, ${headlessAngle}, 0`"
							fill="none"
							stroke-width="0.1"
							:stroke="`hsl(${180 - (2 * 180)}, 80%, 70%)`"
						/>
						<text x="50%" y="50%" dy="0.05" text-anchor="middle">{{allCount}}</text>
					</svg>
				</div>
				<div>
					<p><i class="ti ti-cardboards" style="color: #D76FF9"></i>&nbsp;{{userCountData.neos_vrUserCount}}</p>
					<p><i class="ti ti-device-desktop" style="color: #6FED51"></i>&nbsp;{{userCountData.neos_screenUserCount}}</p>
					<p><i class="ti ti-server" style="color: hsl(-180, 80%, 70%)"></i>&nbsp;{{userCountData.neos_headlessUserCount}}</p>
				</div>
			</div>
		</div>
	</MkContainer>
</template>

<script lang="ts" setup>
import { onUnmounted, ref, watch } from 'vue';
import { useWidgetPropsManager, Widget, WidgetComponentEmits, WidgetComponentExpose, WidgetComponentProps } from './widget';
import { GetFormResultType } from '@/scripts/form';
import MkContainer from '@/components/MkContainer.vue';
import { i18n } from '@/i18n';

const name = 'neosUserCount';

const widgetPropsDef = {
	showHeader: {
		type: 'boolean' as const,
		default: true,
	},
};

type WidgetProps = GetFormResultType<typeof widgetPropsDef>;

const props = defineProps<{ widget?: Widget<WidgetProps>; }>();
const emit = defineEmits<{ (ev: 'updateProps', props: WidgetProps); }>();

const { widgetProps, configure } = useWidgetPropsManager(name,
	widgetPropsDef,
	props,
	emit,
);

type NeosUserCount = {
	neos_headlessUserCount: number
	neos_mobileUserCount: number
	neos_registeredUserCount: number
	neos_screenUserCount: number
	neos_vrUserCount: number
}

const userCountData = ref<NeosUserCount>({neos_vrUserCount: 0, neos_headlessUserCount: 0, neos_screenUserCount: 0, neos_registeredUserCount:0, neos_mobileUserCount:0});
const loaded = ref<boolean>(false);

const api = "https://statistics.kokoa.dev/v1/neos/usercount";

const r = 0.45;

const allCount = $computed(() => ( userCountData.value.neos_vrUserCount + userCountData.value.neos_headlessUserCount + userCountData.value.neos_screenUserCount ) );
const vrAngle = $computed(() => ( userCountData.value.neos_vrUserCount / allCount ) * (Math.PI * (r * 2)));
const desktopAngle = $computed(() => ( userCountData.value.neos_screenUserCount / allCount ) * (Math.PI * (r * 2)));
const headlessAngle = $computed(() => ( userCountData.value.neos_headlessUserCount / allCount ) * (Math.PI * (r * 2)));
const getUserCount = async () => {
	const result = await (await fetch(api)).json();
	userCountData.value = result;
	loaded.value = true;
};

getUserCount();

setInterval(() => getUserCount(), 60 * 1000);

defineExpose<WidgetComponentExpose>({
	name,
	configure,
	id: props.widget ? props.widget.id : null,
});
</script>

<style lang="scss" module>
.root {
}

.flex {
	display: flex;
	justify-content: space-evenly;
	align-items: center;
}

.allUser {
	font-size: 2em;
}

.label {
	font-size: 65%;
	opacity: 0.7;
}

.save {
	display: block;
	position: absolute;
	bottom: 8px;
	right: 8px;
	margin: 0;
	padding: 0 10px;
	height: 28px;
	outline: none;
	border-radius: 4px;

	&:disabled {
		opacity: 0.7;
		cursor: default;
	}
}

.hsalcinq {
	display: block;
	height: 100%;

	> circle {
		transform-origin: center;
		transform: rotate(-90deg);
		transition: stroke-dashoffset 0.5s ease;
	}

	> text {
		font-size: 0.15px;
		fill: currentColor;
	}
}
</style>
