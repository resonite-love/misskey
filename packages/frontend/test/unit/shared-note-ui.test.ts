/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import Actions from '@/components/MkPostFormActionBar.vue';
import Fields from '@/components/MkPostFormFields.vue';
import Cw from '@/components/MkNoteCw.vue';
import NoteText from '@/components/MkNoteText.vue';
import Detail from '@/components/MkNoteDetailedArticle.vue';
import Overview from '@/components/MkChannelOverview.vue';
import FollowActions from '@/components/MkFollowRequestActions.vue';

vi.mock('@/preferences.js', () => ({ prefer: { s: { animation: false } } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { close: 'Close', attachFile: 'Attach', upload: 'Upload', fromDrive: 'Drive', poll: 'Poll', useCw: 'CW', hashtags: 'Tags', mention: 'Mention', addMfmFunction: 'MFM', plugins: 'Plugins', preview: 'Preview', emoji: 'Emoji', accept: 'Accept', reject: 'Reject', sensitive: 'Sensitive', _channel: {} } } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { props: ['disabled'], template: '<button :disabled="disabled"><slot/></button>' } }));
vi.mock('@/components/MkCwButton.vue', () => ({ default: { props: ['modelValue'], emits: ['update:modelValue'], template: '<button @click="$emit(\'update:modelValue\', !modelValue)">Toggle CW</button>' } }));
afterEach(cleanup);

test('the shared toolbar passes the clicked element to picker/upload handlers', async () => {
 const clicked: Record<string, EventTarget | null> = {};
 const view = render(Actions, { props: { poll: false, useCw: false, drive: true, plugins: true, onMfm: event => { clicked.mfm = event.currentTarget; }, onEmoji: event => { clicked.emoji = event.currentTarget; }, onUpload: event => { clicked.upload = event.currentTarget; }, onDrive: event => { clicked.drive = event.currentTarget; }, onPlugins: event => { clicked.plugins = event.currentTarget; } } });
 for (const [kind, label] of Object.entries({ mfm: 'MFM', emoji: 'Emoji', upload: 'Attach (Upload)', drive: 'Attach (Drive)', plugins: 'Plugins' })) {
  const button = view.getByRole('button', { name: label });
  await fireEvent.click(button);
  expect(clicked[kind]).toBe(button);
 }
 await view.rerender({ canAttach: false });
 await fireEvent.click(view.getByRole('button', { name: 'Attach (Upload)' }));
 expect(view.emitted('upload')).toHaveLength(1);
});

test('shared input framing preserves parent-owned DOM refs, models, and keyboard events', async () => {
 const typed = vi.fn(); let focusText!: () => void;
 const Form = defineComponent({ components: { Fields }, setup() { const text = ref(''), cw = ref(''), el = ref<HTMLTextAreaElement>(); focusText = () => el.value?.focus(); return { text, cw, el, typed }; }, template: '<Fields :useCw="true" channelColor="var(--MI_THEME-accent)"><template #cw><input v-model="cw" aria-label="CW"/></template><textarea ref="el" v-model="text" aria-label="Text" @keydown="typed"/><template #counter>{{ text.length }}</template></Fields>' });
 const view = render(Form);
 const text = view.getByRole('textbox', { name: 'Text' });
 await fireEvent.update(text, 'shared text'); await fireEvent.keyDown(text, { key: 'Enter' });
 expect(view.getByText('11')).toBeTruthy(); expect(typed).toHaveBeenCalledOnce();
 focusText(); expect(document.activeElement).toBe(text);
 await fireEvent.update(view.getByRole('textbox', { name: 'CW' }), 'warning');
 expect((view.getByRole('textbox', { name: 'CW' }) as HTMLInputElement).value).toBe('warning');
});

test('shared CW toggles without replacing its parent-owned visibility model', async () => {
 const view = render(Cw, { props: { modelValue: false, cw: 'Warning', text: 'Body' }, global: { stubs: { Mfm: { props: ['text'], template: '<span>{{ text }}</span>' } } } });
 await fireEvent.click(view.getByRole('button', { name: 'Toggle CW' }));
 expect(view.emitted('update:modelValue')).toEqual([[true]]);
});

test('text renderer keeps source emoji URLs and disables peer emoji actions by default', () => {
 const view = render(NoteText, { props: { text: ':source:', emojiUrls: { source: 'https://source.example/emoji.webp' } }, global: { stubs: { Mfm: { props: ['text', 'emojiUrls', 'enableEmojiMenu', 'enableEmojiMenuReaction'], template: '<span :data-emoji="emojiUrls.source" :data-menu="enableEmojiMenu" :data-reaction="enableEmojiMenuReaction">{{ text }}</span>' } } } });
 const content = view.getByText(':source:');
 expect(content.getAttribute('data-emoji')).toBe('https://source.example/emoji.webp');
 expect(content.getAttribute('data-menu')).toBe('false'); expect(content.getAttribute('data-reaction')).toBe('false');
});

test('detail layout keeps content and actions without requiring a local note ID', async () => {
 const click = vi.fn();
 const view = render(Detail, { slots: { header: '<h2>Author</h2>', default: '<p>Private body</p>', footer: () => h('button', { onClick: click }, 'Reply') }, global: { mocks: { clicked: click } } });
 expect(view.getByRole('article').textContent).toContain('Private body');
 await fireEvent.click(view.getByRole('button', { name: 'Reply' })); expect(click).toHaveBeenCalledOnce();
});

test('channel overview preserves delegated follow and favorite controls', async () => {
 const view = render(Overview, { props: { channel: { name: 'Channel', description: 'Description', bannerUrl: null, usersCount: 4, notesCount: 12, isSensitive: true }, origin: 'Source' }, slots: { follow: '<button>Follow</button>', favorite: '<button>Favorite</button>' }, global: { stubs: { Mfm: { props: ['text'], template: '<span>{{ text }}</span>' }, I18n: { template: '<span><slot name="n"/></span>' } } } });
 expect(view.getByRole('button', { name: 'Follow' })).toBeTruthy(); expect(view.getByRole('button', { name: 'Favorite' })).toBeTruthy();
 expect(view.getByText('Source')).toBeTruthy(); expect(view.getByText('Sensitive')).toBeTruthy(); expect(view.getByText('Description')).toBeTruthy();
});

test('notification approval emits a decision and prevents duplicate clicks while busy', async () => {
 const view = render(FollowActions);
 await fireEvent.click(view.getByRole('button', { name: 'Accept' })); expect(view.emitted('decide')).toEqual([[true]]);
 await view.rerender({ busy: true }); await fireEvent.click(view.getByRole('button', { name: 'Reject' })); expect(view.emitted('decide')).toHaveLength(1);
});
