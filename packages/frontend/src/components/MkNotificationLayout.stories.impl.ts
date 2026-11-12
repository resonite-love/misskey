/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import MkNotificationLayout from './MkNotificationLayout.vue';
export const Default = {
	render: args => ({ components: { MkNotificationLayout }, setup: () => ({ args }), template: '<MkNotificationLayout v-bind="args"><template #head>●</template><template #header>Notification</template>Notification body</MkNotificationLayout>' }),
	args: { time: '2026-11-13T00:00:00Z', contentVisibilityAuto: false },
} satisfies StoryObj<typeof MkNotificationLayout>;
