/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from "@storybook/vue3";
import { file } from "../../.storybook/fakes.js";
import MkMedia3d from "./MkMedia3d.vue";

export const Default = {
	render(args) {
		return {
			components: { MkMedia3d },
			setup() {
				return { args };
			},
			template: '<MkMedia3d v-bind="args" />',
		};
	},
	args: {
		media: {
			...file(),
			name: "test.fbx",
			type: "application/x-ft-fbx",
			url: "/test.fbx",
			thumbnailUrl: null,
			properties: {},
		},
	},
	parameters: {
		layout: "centered",
	},
	decorators: [
		() => ({
			template: '<div style="width:min(640px, 90vw)"><story/></div>',
		}),
	],
} satisfies StoryObj<typeof MkMedia3d>;

export const Sensitive = {
	...Default,
	args: {
		media: {
			...Default.args.media,
			isSensitive: true,
		},
	},
} satisfies StoryObj<typeof MkMedia3d>;
