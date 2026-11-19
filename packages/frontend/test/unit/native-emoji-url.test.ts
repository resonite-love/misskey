/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { preferState } from '../setup.unit.js';
import { getNativeEmojiImageUrl } from '@@/js/emoji-name.js';
import CustomEmoji from '@/components/global/MkCustomEmoji.vue';

const { originCheck } = vi.hoisted(() => ({ originCheck: vi.fn() }));
vi.mock('@/utility/gridspace-note-link.js', () => ({ isConfiguredGridspaceOrigin: originCheck }));
vi.mock('@/utility/media-proxy.js', () => ({ getProxiedImageUrl: (value: string) => `/proxy?url=${encodeURIComponent(value)}`, getStaticImageUrl: (value: string) => `${value}&static=1` }));
vi.mock('@/custom-emojis.js', () => ({ customEmojisMap: new Map() }));
vi.mock('@/os.js', () => ({}));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn(), misskeyApiGet: vi.fn() }));
vi.mock('@/components/MkCustomEmojiDetailedDialog.vue', () => ({ default: {} }));
vi.mock('@/i.js', () => ({ $i: null }));
vi.mock('@/utility/emoji-mute', async () => {
	const { ref } = await import('vue');
	return { makeEmojiMuteKey: vi.fn(), mute: vi.fn(), unmute: vi.fn(), checkMuted: () => ref(false) };
});
vi.mock('@/utility/emoji-palette.js', () => ({ addToEmojiPalette: vi.fn() }));

beforeEach(() => { originCheck.mockReset(); preferState.disableShowingAnimatedImages = false; });
afterEach(cleanup);

describe('native emoji image URLs', () => {
	test('uses the author server emoji route directly instead of proxying its proxy', () => {
		expect(getNativeEmojiImageUrl('https://g.example/emoji/bloborange.webp', 'g.example')).toBe('https://g.example/emoji/bloborange.webp');
	});
	test('requests a static image from the same route', () => {
		expect(getNativeEmojiImageUrl('https://g.example/emoji/bloborange.webp?fallback=1', 'g.example', true)).toBe('https://g.example/emoji/bloborange.webp?fallback=1&static=1');
	});
	test.each([
		['https://other.example/emoji/bloborange.webp', 'g.example'],
		['https://g.example/drive/bloborange.webp', 'g.example'],
		['https://secret@g.example/emoji/bloborange.webp', 'g.example'],
		['ftp://g.example/emoji/bloborange.webp', 'g.example'],
		['https://g.example/emoji/bloborange@other.example.webp', 'g.example'],
		['/emoji/bloborange.webp', 'g.example'],
		['https://g.example/emoji/bloborange.webp', null],
	])('keeps ordinary image handling for %s with host %s', (url, host) => {
		expect(getNativeEmojiImageUrl(url, host)).toBeNull();
	});
});

test('renders the configured peer emoji directly after checking its origin', async () => {
	originCheck.mockResolvedValue(true);
	const view = render(CustomEmoji, { props: { name: 'bloborange', host: 'g.example', url: 'https://g.example/emoji/bloborange.webp' } });
	await vi.waitFor(() => expect(view.getByAltText(':bloborange:').getAttribute('src')).toBe('https://g.example/emoji/bloborange.webp'));
	expect(originCheck).toHaveBeenCalledWith('https://g.example/emoji/bloborange.webp');
});

test.each([false, null])('keeps other servers and unavailable pair configuration behind the image proxy (%s)', async permitted => {
	originCheck.mockResolvedValue(permitted);
	const view = render(CustomEmoji, { props: { name: 'bloborange', host: 'other.example', url: 'https://other.example/emoji/bloborange.webp' } });
	await vi.waitFor(() => expect(view.getByAltText(':bloborange:').getAttribute('src')).toBe('/proxy?url=https%3A%2F%2Fother.example%2Femoji%2Fbloborange.webp'));
});

test('does not start an old proxy request while pair configuration is loading', async () => {
	let finish!: (value: boolean) => void;
	originCheck.mockReturnValue(new Promise<boolean>(resolve => { finish = resolve; }));
	const view = render(CustomEmoji, { props: { name: 'bloborange', host: 'g.example', url: 'https://g.example/emoji/bloborange.webp' } });
	expect(view.queryByAltText(':bloborange:')).toBeNull();
	finish(true);
	await vi.waitFor(() => expect(view.getByAltText(':bloborange:').getAttribute('src')).toBe('https://g.example/emoji/bloborange.webp'));
});

test('preserves static image preference for the configured peer', async () => {
	preferState.disableShowingAnimatedImages = true;
	originCheck.mockResolvedValue(true);
	const view = render(CustomEmoji, { props: { name: 'bloborange', host: 'g.example', url: 'https://g.example/emoji/bloborange.webp' } });
	await vi.waitFor(() => expect(view.getByAltText(':bloborange:').getAttribute('src')).toBe('https://g.example/emoji/bloborange.webp?static=1'));
});

test('does not apply a delayed origin check to a different image', async () => {
	let finish!: (value: boolean) => void;
	originCheck.mockReturnValue(new Promise<boolean>(resolve => { finish = resolve; }));
	const view = render(CustomEmoji, { props: { name: 'bloborange', host: 'g.example', url: 'https://g.example/emoji/bloborange.webp' } });
	await view.rerender({ url: 'https://cdn.example/orange.png' });
	finish(true);
	await vi.waitFor(() => expect(view.getByAltText(':bloborange:').getAttribute('src')).toBe('/proxy?url=https%3A%2F%2Fcdn.example%2Forange.png'));
});
