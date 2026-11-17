/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useStream } from '@/stream.js';

/** Authenticated hints contain no note bodies. HTTP owns order and authorization. */
export function subscribeTimeline(params: { session: string; revision: string; updatesCursor: string }, invalidate: () => void, reconnect: () => void = invalidate): () => void {
	const stream = useStream();
	// The channel is deployed together with the timeline capability. This narrow
	// structural type also keeps older generated client bundles compatible.
	const subscribe = stream.useChannel as unknown as (name: string, params: Record<string, string>) => { on(event: string, listener: () => void): void; dispose(): void };
	const connection = subscribe('gridspaceTimeline', params);
	connection.on('invalidate', invalidate);
	stream.on('_connected_', reconnect);
	return () => { stream.off('_connected_', reconnect); connection.dispose(); };
}
