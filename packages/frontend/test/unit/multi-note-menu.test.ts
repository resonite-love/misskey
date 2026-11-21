/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlacementMenu } from '@/utility/multi-note-menu.js';
import type { MenuButton, MenuParent } from '@/types/menu.js';
import type { NotePlacement } from '@/utility/multi-note.js';

const { confirm, api } = vi.hoisted(() => ({ confirm: vi.fn(), api: vi.fn() }));
vi.mock('@/os.js', () => ({ confirm, apiWithDialog: api }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { _multiNote: { placements: 'Placements', retryPlacement: 'Retry' } }, tsx: { _multiNote: {
	removePlacement: ({ name }: { name: string }) => 'Remove ' + name, confirmRemove: ({ name }: { name: string }) => name,
} } } }));

const uri = 'https://note.example/notes/original';
const channel = { origin: 'https://channel.example', channelId: '1', name: 'Talk', state: 'active' } as const;

function actions(placements: NotePlacement[], refresh?: () => void) {
	const [parent] = getPlacementMenu(placements, uri, refresh) as MenuParent[];
	return (parent?.children ?? []) as MenuButton[];
}

describe('placement menu', () => {
	beforeEach(() => vi.clearAllMocks());
	it('offers removal only when the server permits it on this channel', () => {
		expect(actions([channel])).toHaveLength(0);
		expect(actions([{ ...channel, canRemove: true }])).toHaveLength(1);
		expect(actions([{ ...channel, canRemove: true, state: 'removed' }])).toHaveLength(0);
	});
	it('removes the confirmed placement and refreshes its state without deleting the note', async () => {
		const refresh = vi.fn();
		const [remove] = actions([{ ...channel, canRemove: true }], refresh);
		confirm.mockResolvedValueOnce({ canceled: true }).mockResolvedValueOnce({ canceled: false });
		await remove.action(new PointerEvent('click'));
		expect(api).not.toHaveBeenCalled();
		await remove.action(new PointerEvent('click'));
		expect(api).toHaveBeenCalledExactlyOnceWith('gridspace/multi-note/remove', { canonicalUri: uri, channelOrigin: channel.origin, channelId: '1' });
		expect(refresh).toHaveBeenCalledOnce();
	});
	it('retries only deliveries marked retryable by the origin', async () => {
		const failed = { ...channel, state: 'failed' as const };
		expect(actions([failed])).toHaveLength(0);
		const [retry] = actions([{ ...failed, canRetry: true }]);
		await retry.action(new PointerEvent('click'));
		expect(api).toHaveBeenCalledExactlyOnceWith('gridspace/multi-note/retry', { canonicalUri: uri });
	});
});
