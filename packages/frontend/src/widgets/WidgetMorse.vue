<template>
	<MkContainer>
		<template #header>Morse</template>
		<div>
		<MkSwitch v-model="toggleValue" label="i18n.ts.sound">
				<template #caption>sound</template>
			</MkSwitch>
		</div>
	</MkContainer>
</template>

<script lang="ts" setup>
import { useWidgetPropsManager, WidgetComponentEmits, WidgetComponentExpose, WidgetComponentProps } from './widget';
import { GetFormResultType } from '@/scripts/form';
import MkContainer from "@/components/MkContainer.vue";
import {i18n} from "@/i18n";
import MkSwitch from "@/components/MkSwitch.vue";
import {ref} from "vue";

const name = 'morse';

const toggleValue = ref(false);

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
