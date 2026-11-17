/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiNote } from '@/models/Note.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { canShareGridspaceNote } from '../note-protocol.js';
import { resolveGridspaceConfig, type GridspacePeerConfig } from '../peer-protocol.js';
import { requestGridspacePeer } from '../peer-client.js';

export type TimelinePeerHint = { noteId: string; shared: boolean };

/** Forward only a committed note ID; each receiving stream authorizes its own viewer. */
@Injectable()
export class TimelinePeerService {
	private readonly peer: GridspacePeerConfig | null;
	private readonly pending = new Map<string, TimelinePeerHint>();
	private active = 0;
	private invalidating = false;
	private invalidateAgain = false;
	constructor(@Inject(DI.config) config: Config, private readonly events: GlobalEventService) {
		this.peer = resolveGridspaceConfig(config.gridspace, config.url, process.env);
	}

	public notify(note: Pick<MiNote, 'id' | 'userHost' | 'channelId' | 'visibility'>): void {
		if (!this.peer) return;
		// A remote actor may create a note in this server's channel, whose canonical
		// note remains here. Imported peer notes must never echo back to their origin.
		if (note.userHost != null && !(note.channelId && note.userHost === new URL(this.peer.peerOrigin).host)) return;
		if (this.pending.size >= 1000) return; // The existing change cursor recovers lost hints.
		this.pending.set(note.id, { noteId: note.id, shared: note.userHost == null && canShareGridspaceNote(note) });
		this.drain();
	}

	private drain(): void {
		while (this.peer && this.active < 4 && this.pending.size) {
			const [id, hint] = this.pending.entries().next().value!;
			this.pending.delete(id);
			this.active++;
			void requestGridspacePeer(this.peer, '/gridspace/v1/timeline/notify', hint, 4096, Date.now() + 5000)
				.catch(() => { /* Existing durable note delivery and change cursors recover disconnects. */ })
				.finally(() => { this.active--; this.drain(); });
		}
	}

	public receive(noteId: string): { ok: true } {
		this.events.publishInternalEvent('gridspaceTimelineNote', { noteId, source: 'peer' });
		return { ok: true };
	}

	/** Content-free policy/edit hint. Never echo a received hint to the peer. */
	public notifyChanges(): void {
		if (!this.peer) return;
		this.invalidateAgain = true;
		if (this.invalidating) return;
		this.invalidating = true;
		void (async () => {
			try {
				while (this.invalidateAgain) {
					this.invalidateAgain = false;
					await requestGridspacePeer(this.peer!, '/gridspace/v1/timeline/invalidate', {}, 4096, Date.now() + 5000)
						.catch(() => { /* Bounded authorization leases and cursor recovery remain active. */ });
				}
			} finally { this.invalidating = false; }
		})();
	}

	public receiveChanges(): { ok: true } {
		this.events.publishInternalEvent('gridspaceTimelineChanged', { sequence: '0' });
		return { ok: true };
	}
}
