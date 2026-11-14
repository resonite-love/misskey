/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/vue';
import { h } from 'vue';
import type { RenderResult } from '@testing-library/vue';
import type { entities } from 'misskey-js';
import { prefer } from '@/preferences.js';
import MkAutoTranslatedNote from '@/components/MkAutoTranslatedNote.vue';

const mocks = vi.hoisted(() => ({ request: vi.fn(), capabilities: vi.fn() }));
vi.mock('@/utility/auto-translation.js', () => ({ requestAutoTranslation: mocks.request, getAutoTranslationCapabilities: mocks.capabilities }));
vi.mock('@/i.js', () => ({ $i: { id: 'alice' } }));
vi.mock('@/preferences.js', async () => {
	const { ref } = await import('vue');
	return { prefer: {
		s: { 'autoTranslation.enabled': true, 'autoTranslation.targetLang': 'ja' },
		r: { 'autoTranslation.enabled': ref(true), 'autoTranslation.targetLang': ref('ja') },
	} };
});
vi.mock('@/i18n.js', () => ({ i18n: { ts: { retry: 'Retry', _autoTranslation: {
	translated: 'Translated', showTranslation: 'Translation', showOriginal: 'Original', translating: 'Translating', failed: 'Failed',
} } } }));

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

describe('automatic translation display', () => {
	let wrapper: RenderResult | undefined;
	let intersection: IntersectionObserverCallback;
	const note = { id: 'note', text: 'Original text', cw: null, user: { id: 'author' }, emojis: {} } as entities.Note;
	const result = (text: string) => ({ status: 'translated', text, cw: null, sourceLang: 'en', targetLang: 'ja' });
	function create(active = true) {
		wrapper = render(MkAutoTranslatedNote, {
			props: { note, active },
			slots: { default: ({ text }: { text: string | null }) => h('p', { class: 'body' }, text ?? '') },
			global: { stubs: { Mfm: true } },
		});
		return wrapper;
	}
	async function visible() {
		intersection([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
		await flushPromises();
	}
	beforeEach(() => {
		vi.stubGlobal('IntersectionObserver', class {
			constructor(callback: IntersectionObserverCallback) { intersection = callback; }
			observe() {}
			disconnect() {}
		});
		prefer.s['autoTranslation.enabled'] = true;
		prefer.r['autoTranslation.enabled'].value = true;
		prefer.s['autoTranslation.targetLang'] = 'ja';
		prefer.r['autoTranslation.targetLang'].value = 'ja';
		mocks.capabilities.mockResolvedValue({ available: true, languages: ['ja', 'en'] });
		mocks.request.mockReset();
		mocks.request.mockResolvedValue(result('Translated text'));
	});
	afterEach(() => { wrapper?.unmount(); });
	test('waits for viewport visibility and preserves an original-text toggle', async () => {
		let finish!: (value: unknown) => void;
		mocks.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
		const view = create();
		await flushPromises();
		expect(mocks.request).not.toHaveBeenCalled();
		const originalMarkup = view.container.innerHTML;
		await visible();
		expect(mocks.request).toHaveBeenCalledTimes(1);
		expect(view.container.innerHTML).toBe(originalMarkup);
		finish(result('Translated text'));
		await flushPromises();
		expect(view.container.querySelector('.body')!.textContent).toBe('Translated text');
		await fireEvent.click(view.container.querySelector('button')!);
		expect(view.container.querySelector('.body')!.textContent).toBe('Original text');
	});
	test('does not translate a collapsed CW', async () => {
		const view = create(false);
		await visible();
		expect(mocks.request).not.toHaveBeenCalled();
		await view.rerender({ active: true });
		await flushPromises();
		expect(mocks.request).toHaveBeenCalledTimes(1);
	});
	test('ignores stale results after target changes and restores original when disabled', async () => {
		const resolves: ((value: unknown) => void)[] = [];
		mocks.request.mockImplementation(() => new Promise(resolve => resolves.push(resolve)));
		const view = create();
		await visible();
		prefer.s['autoTranslation.targetLang'] = 'en';
		prefer.r['autoTranslation.targetLang'].value = 'en';
		await flushPromises();
		resolves[0](result('Stale translation'));
		await flushPromises();
		expect(view.container.querySelector('.body')!.textContent).toBe('Original text');
		resolves[1](result('Current translation'));
		await flushPromises();
		expect(view.container.querySelector('.body')!.textContent).toBe('Current translation');
		prefer.s['autoTranslation.enabled'] = false;
		prefer.r['autoTranslation.enabled'].value = false;
		await flushPromises();
		expect(view.container.querySelector('.body')!.textContent).toBe('Original text');
	});
	test('same-language and error results leave the original visible', async () => {
		mocks.request.mockResolvedValue({ ...result(''), status: 'sameLanguage', text: null });
		const view = create();
		await visible();
		expect(view.container.querySelector('.body')!.textContent).toBe('Original text');
		mocks.request.mockRejectedValue(new Error('unavailable'));
		await view.rerender({ note: { ...note, id: 'other' } });
		await flushPromises();
		expect(view.container.querySelector('.body')!.textContent).toBe('Original text');
		expect(view.container.textContent).toContain('Failed');
	});
	test.each([
		['土日祝日', '土日祝日'],
		['高市早苗', '高市早苗'],
		['ラーメン', 'ラーメン'],
		['土日祝日', ' \n土日祝日\n '],
		['一行目\n二行目', '一行目\r\n二行目'],
		['が', 'か\u3099'],
	])('hides unchanged translation metadata for %s', async (text, translatedText) => {
		mocks.request.mockResolvedValue(result(translatedText));
		const view = create(); await view.rerender({ note: { ...note, text } });
		await visible();
		expect(view.container.querySelector('.body')!.textContent).toBe(text);
		expect(view.queryByText('Translated')).toBeNull();
		expect(view.queryByRole('button')).toBeNull();
	});
	test('keeps a translation when only the CW changes', async () => {
		mocks.request.mockResolvedValue({ ...result(note.text!), cw: '訳した注意書き' });
		const view = create(); await view.rerender({ note: { ...note, cw: 'Warning' } });
		await visible();
		expect(view.getByText('Translated')).toBeTruthy();
		expect(view.getByRole('button', { name: 'Original' })).toBeTruthy();
	});
	test('hides metadata when both the body and CW are unchanged', async () => {
		mocks.request.mockResolvedValue({ ...result(note.text!), cw: 'Warning' });
		const view = create(); await view.rerender({ note: { ...note, cw: 'Warning' } });
		await visible();
		expect(view.queryByText('Translated')).toBeNull();
		expect(view.queryByRole('button')).toBeNull();
	});
	test('does not hide meaningful spacing or punctuation changes', async () => {
		mocks.request.mockResolvedValue(result('Originaltext!'));
		const view = create(); await visible();
		expect(view.getByText('Translated')).toBeTruthy();
		expect(view.container.querySelector('.body')!.textContent).toBe('Originaltext!');
	});
	test('treats a missing result field as the displayed original rather than a change', async () => {
		mocks.request.mockResolvedValue({ ...result(''), text: null, cw: null });
		const view = create(); await view.rerender({ note: { ...note, cw: 'Warning' } });
		await visible();
		expect(view.container.querySelector('.body')!.textContent).toBe(note.text);
		expect(view.queryByText('Translated')).toBeNull();
	});
});
