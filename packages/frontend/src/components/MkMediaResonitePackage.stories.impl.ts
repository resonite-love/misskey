/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { file } from '../../.storybook/fakes.js';
import MkMediaResonitePackage from './MkMediaResonitePackage.vue';

export const Default = {
	render(args) {
		return { components: { MkMediaResonitePackage }, setup: () => ({ args }), template: '<MkMediaResonitePackage v-bind="args"/>' };
	},
	args: {
		media: {
			...file(),
			name: 'MisskeyClient 1.1.resonitepackage',
			type: 'application/octet-stream',
			url: '/example.resonitepackage',
			size: 524288,
			thumbnailUrl: null,
			properties: { resonitePackage: {
				schemaVersion: 1, name: 'Misskey Client', description: 'Resoniteからタイムラインを見られるクライアントです。',
				recordCount: 1, assetCount: 12, assetBytes: 1048576, unpackedBytes: 1572864, variantCount: 0,
				slotCount: 48, componentCount: 216,
			} },
		},
	},
	parameters: { layout: 'centered' },
	decorators: [() => ({ template: '<div style="width:min(640px, 90vw)"><story/></div>' })],
} satisfies StoryObj<typeof MkMediaResonitePackage>;

export const MissingMetadata = {
	...Default,
	args: { media: { ...Default.args.media, properties: {} }, noteId: 'example-note' },
} satisfies StoryObj<typeof MkMediaResonitePackage>;

export const UnknownObjectCounts = {
	...Default,
	args: { media: { ...Default.args.media, properties: { resonitePackage: {
		...Default.args.media.properties.resonitePackage, slotCount: undefined, componentCount: undefined,
	} } } },
} satisfies StoryObj<typeof MkMediaResonitePackage>;

export const Sensitive = {
	...Default,
	args: { media: { ...Default.args.media, isSensitive: true } },
} satisfies StoryObj<typeof MkMediaResonitePackage>;
