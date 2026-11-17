/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useStream } from '@/stream.js';
import type { TimelineStreamEvent } from '@/utility/timeline-client.js';

/** The server authorizes note events; invalidations recover changes outside the head. */
export function subscribeTimeline(params: { session: string; revision: string; updatesCursor: string }, invalidate: () => void, reconnect: () => void = invalidate, note?: (event: TimelineStreamEvent) => void): () => void {
	const stream = useStream();
	// The channel is deployed together with the timeline capability. This narrow
	// structural type also keeps older generated client bundles compatible.
	const subscribe = stream.useChannel as unknown as (name: string, params: Record<string, string>) => { on(event: string, listener: ((event: TimelineStreamEvent) => void) | (() => void)): void; dispose(): void };
	let connection: ReturnType<typeof subscribe> | undefined;
	let activeLeaseId = '';
	const connect = () => {
		connection?.dispose();
		const leaseId = crypto.randomUUID();
		activeLeaseId = leaseId;
		const leaseStartedAt = performance.now();
		connection = subscribe('gridspaceTimeline', { ...params, leaseId });
		connection.on('invalidate', () => { if (leaseId === activeLeaseId) invalidate(); });
		if (note) connection.on('note', event => {
			if (leaseId === activeLeaseId && event.leaseId === leaseId) note({ ...event, leaseStartedAt });
		});
	};
	connect();
	const connected = () => { connect(); reconnect(); };
	stream.on('_connected_', connected);
	return () => { activeLeaseId = ''; stream.off('_connected_', connected); connection?.dispose(); };
}
