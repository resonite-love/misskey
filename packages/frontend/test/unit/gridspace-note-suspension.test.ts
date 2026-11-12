/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it, vi } from 'vitest';
import { clearLeavingPrivateNote, suspendPrivateNotes } from '@/utility/gridspace-note-suspension.js';
import type { GridspacePrivateNote } from '@/utility/gridspace-note-suspension.js';

vi.mock('@/i.js', () => ({ $i: { hardMutedWords: [] } }));

describe('private row suspension', () => {
	it('discards body, file, actor and reaction data but preserves visibility across repeated hides', () => {
		const note = { id: 'id', uri: 'https://peer/notes/id', createdAt: '2026-11-13T00:00:00Z', text: 'secret', cw: 'secret CW', author: { name: 'secret actor' }, files: [{ isSensitive: true }], reactions: { secret: 1 } } as unknown as GridspacePrivateNote;
		const refs = suspendPrivateNotes([note], false);
		expect(refs).toEqual([{ id: note.id, uri: note.uri, createdAt: note.createdAt, suspended: true, visible: false }]);
		expect(suspendPrivateNotes(refs)).toEqual(refs);
	});
	it('clears a revoked body immediately without waiting for the transition animation frame', () => {
		const privateRow = document.createElement('div'); privateRow.setAttribute('data-gridspace-private-row', ''); privateRow.textContent = 'revoked';
		const native = document.createElement('div'); native.textContent = 'ordinary';
		clearLeavingPrivateNote(privateRow); clearLeavingPrivateNote(native);
		expect(privateRow.textContent).toBe(''); expect(native.textContent).toBe('ordinary');
	});
});
