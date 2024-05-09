<template>
	<MkContainer :show-header="widgetProps.showHeader">
		<template #header>{{ i18n.ts._widgets.neosEvent }}</template>
		<div :class="$style.root">
			<div v-for="(events, i) in eventData" :key="i" :class="$style.event">
				<div :class="$style.event_date">
					<div :class="[isDoyoubi(events[0].startTime) ? $style.text_blue : null, isNitiyoubi(events[0].startTime) ? $style.text_red : null]">
						{{i}}
						<span :class="$style.event_day">({{getDay(events[0].startTime)}})</span>
					</div>
				</div>
		    <div :class="$style.event_inner">
					<div v-for="(event, i) in events" :key="i" :class="$style.event_box">
						<div :class="$style.event_time">{{formatTime(event.startTime)}}</div>
						<div :class="$style.event_title" :title="`${removeHtmlTag(event.detail)}&#13;&#10;${removeHtmlTag(event.place)}`">{{event.title}}</div>
					</div>
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

const name = 'neosEvent';

const widgetPropsDef = {
	showHeader: {
		type: 'boolean' as const,
		default: true,
	},
};

// remove html tag from string
const removeHtmlTag = (str: string) => {
	return str.replace(/<("[^"]*"|'[^']*'|[^'">])*>/g, '')
}

const isDoyoubi = (date: number) => {
	const d = new Date(date)
	const day = d.getDay()
	return day === 6
}

const isNitiyoubi = (date: number) => {
	const d = new Date(date)
	const day = d.getDay()
	return day === 0
}

// dayを曜日にする関数
const getDay = (date: number) => {
	const d = new Date(date)
	const day = d.getDay()
	const dayNames = ['日', '月', '火', '水', '木', '金', '土']
	return dayNames[day]
}
const formatDate = (date: string | number) => {
	const d = new Date(date)
	return `${d.getMonth()+1}/${d.getDate()}`
}
const formatTime = (date: string | number) => {
	const d = new Date(date)
	const hours = ('0' + d.getHours()).slice(-2)
	const minutes = ('0' + d.getMinutes()).slice(-2)
	return hours + ':' + minutes;
}

type WidgetProps = GetFormResultType<typeof widgetPropsDef>;

const props = defineProps<{ widget?: Widget<WidgetProps>; }>();
const emit = defineEmits<{ (ev: 'updateProps', props: WidgetProps); }>();

const { widgetProps, configure } = useWidgetPropsManager(name,
	widgetPropsDef,
	props,
	emit,
);

type EventData = {
	title: string
	startTime: number
	endTime: number
	detail: string
	place: string
	color: string
	teiki_event_flg: boolean
}

type EventDataByDate = {
	[date: string]: EventData[]
}

const eventData = ref<EventDataByDate>({});

const loaded = ref<boolean>(false);
const api = "https://calendar.resonite.love/";

function groupEventsByDate(events) {
	const eventsByDate: EventDataByDate = {};

	events.forEach(event => {
		// startDateを抽出
		const date = new Date(event.startTime).getTime()
		const startDate = `${formatDate(date)}`;

		// startDateごとにイベントをグループ化
		if (!eventsByDate[startDate]) {
			eventsByDate[startDate] = [];
		}
		eventsByDate[startDate].push(event);
	});

	return eventsByDate;
}

const getNeosEvent = async () => {
	const result = await (await fetch(api)).json();

	eventData.value = groupEventsByDate(result)
	// eventData.value = result;
	loaded.value = true;
};
getNeosEvent()

setInterval(() => getNeosEvent(), 3 * 60 * 1000);

defineExpose<WidgetComponentExpose>({
	name,
	configure,
	id: props.widget ? props.widget.id : null,
});
</script>

<style lang="scss" module>
.root {
	max-height: 300px;
	overflow-y: scroll;
}

.event {
	display: flex;
	justify-content: space-evenly;
	align-items: center;
	border-bottom: solid 1px rgba(222, 231, 228, 0.14);
}

.event_date {
	padding-left: 5px;
	text-align: center;
	font-size: 120%;
}

.event_day {
	font-size: 60%;
}

.event_inner {
	flex: 1
}

.event_time {
	width: 50px;
	text-align: center;
}

.event_title {
	flex: 1;
}
.event{
	align-items: baseline;
	padding: 5px 0;
	border-top: solid 1px rgba(222,231,228,1);
}

.event:first-child{
	border-top: none;
}

.event_box{
	display: flex;
	align-items: baseline;
	padding: 5px 0 0 5px;
	border-bottom: dashed 1px rgba(222,231,228,3);
}

.event_box:first-child{
	margin: 0px;
}

.event_box:last-child{
	border: none;
}

.event_date span{
	display: block;
}

.event_title{
	padding: 5px 0 0 5px;
}

.event_time{
	font-size: small;
}

.text_blue {
	color: #00a8ff;
}

.text_red {
	color: #ff3f34;
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
</style>
