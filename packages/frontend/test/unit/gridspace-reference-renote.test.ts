/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { fireEvent, render, cleanup } from '@testing-library/vue';
import { afterEach } from 'vitest';
import type { entities } from 'misskey-js';
import Renote from '@/components/MkGridspaceReferenceRenote.vue';
vi.mock('@/i18n.js', () => ({ i18n: { ts: { more: 'More', renotedBy: 'Renoted by {user}', _visibility: { specified: 'Direct', disableFederation: 'No federation' } } } }));
vi.mock('@/components/MkGridspaceNoteLinkPreview.vue', () => ({ default: { props: { url: String, fullNote: Boolean }, template: '<div :data-reference="url" :data-full="fullNote"/>' } }));
vi.mock('@/components/MkNoteChannel.vue', () => ({ default: { template: '<div/>' } }));
afterEach(cleanup);

test('a reference renote renders its source as a full note and forwards the menu anchor event', async () => {
	const menu = vi.fn();
	const reference = 'https://g.example/gridspace/private?noteId=n&channelId=c';
	const view = render(Renote, { props: { note: { user: { id: 'u', username: 'u' } as entities.UserLite, createdAt: new Date(0).toISOString(), gridspaceQuote: reference, visibility: 'specified', localOnly: true }, onMenu: menu },
		global: { stubs: { MkAvatar: true, MkTime: true, MkUserName: true, I18n: { template: '<span><slot name="user"/></span>' } } } });
	expect(view.container.querySelector('[data-full="true"]')?.getAttribute('data-reference')).toBe(reference);
	expect(view.getByTitle('Direct')).toBeTruthy();
	expect(view.getByTitle('No federation')).toBeTruthy();
	await fireEvent.click(view.getByRole('button', { name: 'More' }));
	expect(menu).toHaveBeenCalledOnce();
	expect(menu.mock.calls[0][0]).toBeInstanceOf(MouseEvent);
});
