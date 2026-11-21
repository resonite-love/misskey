/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/vue';
import ChannelEditor from '@/pages/channel-editor.vue';

const { read, write, input } = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), input: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: read }));
vi.mock('@/os.js', () => ({ inputText: input, apiWithDialog: write }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/router.js', () => ({ useRouter: () => ({}) }));
vi.mock('@/utility/drive.js', () => ({ selectFile: vi.fn() }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { pin: 'Pin', unpin: 'Unpin', save: 'Save', _deck: { swapUp: 'Move up', swapDown: 'Move down' }, _channel: {} } } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkInput.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkTextarea.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkColorInput.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkSwitch.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkFolder.vue', () => ({ default: { template: '<section><slot/></section>' } }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

test.each([true, false])('pin buttons save the edited rank order (canonical URIs: %s)', async canonical => {
	const first = canonical ? 'https://peer.example/notes/first' : 'first';
	const second = canonical ? 'https://server.example/notes/second' : 'second';
	const added = canonical ? 'https://peer.example/notes/added' : 'added';
	read.mockResolvedValue({ id: 'channel', name: 'Channel', pinnedNoteIds: ['first', 'second'], ...(canonical ? { pinnedNoteUris: [first, second] } : {}) });
	write.mockImplementation(async (path: string) => path === 'notes/show' ? { id: 'added' } : {});
	input.mockResolvedValue({ canceled: false, result: added });
	const view = render(ChannelEditor, { props: { channelId: 'channel' }, global: { stubs: { PageWithHeader: { template: '<main><slot/></main>' } } } });
	await view.findByRole('group', { name: first });
	const button = (id: string, name: string) => within(view.getByRole('group', { name: id })).getByRole('button', { name }) as HTMLButtonElement;
	expect(button(first, 'Move up').disabled).toBe(true);
	expect(button(second, 'Move down').disabled).toBe(true);
	await fireEvent.click(view.getByRole('button', { name: 'Pin' }));
	await view.findByRole('group', { name: added });
	const up = button(second, 'Move up');
	up.focus();
	expect(document.activeElement).toBe(up);
	await fireEvent.click(up);
	await fireEvent.click(button(added, 'Move down'));
	await fireEvent.click(button(first, 'Unpin'));
	await fireEvent.click(view.getByRole('button', { name: 'Save' }));
	expect(write).toHaveBeenCalledWith('channels/update', expect.objectContaining(canonical ? { pinnedNoteUris: [second, added] } : { pinnedNoteIds: [second, added] }));
});
