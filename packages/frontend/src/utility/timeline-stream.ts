/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useStream } from '@/stream.js';
import type { TimelineStreamEvent } from '@/utility/timeline-client.js';

const ACK_TIMEOUT_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 10000;

/** The server authorizes note events; invalidations recover changes outside the head. */
export function subscribeTimeline(params: { session: string; revision: string; updatesCursor: string }, invalidate: () => void, reconnect: () => void = invalidate, note?: (event: TimelineStreamEvent) => void): () => void {
	const stream = useStream();
	// The channel is deployed together with the timeline capability. This narrow
	// structural type also keeps older generated client bundles compatible.
	const subscribe = stream.useChannel as unknown as (name: string, params: Record<string, string>) => { on(event: string, listener: ((event: TimelineStreamEvent) => void) | (() => void)): void; send(event: string, body: unknown): void; dispose(): void };
	let connection: ReturnType<typeof subscribe> | undefined;
	let activeLeaseId = '';
	let stopped = false;
	let failures = 0;
	let timer: number | undefined;
	const clearTimer = () => { window.clearTimeout(timer); timer = undefined; };
	const waitForAck = (leaseId: string) => {
		clearTimer();
		timer = window.setTimeout(() => {
			if (stopped || leaseId !== activeLeaseId) return;
			// An open socket does not prove that this channel was accepted.
			// Recover the HTTP cursor too, since a session may have expired.
			failures++;
			reconnect();
			if (!stopped) timer = window.setTimeout(connect, Math.min(15000, 2000 * 2 ** Math.min(failures - 1, 3)));
		}, ACK_TIMEOUT_MS);
	};
	const acknowledged = (leaseId: string) => {
		if (stopped || leaseId !== activeLeaseId) return;
		failures = 0;
		clearTimer();
		timer = window.setTimeout(() => {
			if (stopped || leaseId !== activeLeaseId) return;
			connection?.send('ping', {});
			waitForAck(leaseId);
		}, HEARTBEAT_INTERVAL_MS);
	};
	const connect = () => {
		if (stopped) return;
		clearTimer();
		connection?.dispose();
		const leaseId = crypto.randomUUID();
		activeLeaseId = leaseId;
		const leaseStartedAt = performance.now();
		connection = subscribe('gridspaceTimeline', { ...params, leaseId });
		connection.on('ready', event => { if (event.leaseId === leaseId) acknowledged(leaseId); });
		connection.on('invalidate', () => { if (leaseId === activeLeaseId) { acknowledged(leaseId); invalidate(); } });
		if (note) connection.on('note', event => {
			if (leaseId === activeLeaseId && event.leaseId === leaseId) { acknowledged(leaseId); note({ ...event, leaseStartedAt }); }
		});
		waitForAck(leaseId);
	};
	connect();
	const connected = () => { connect(); reconnect(); };
	stream.on('_connected_', connected);
	stream.on('_disconnected_', clearTimer);
	return () => { stopped = true; activeLeaseId = ''; clearTimer(); stream.off('_connected_', connected); stream.off('_disconnected_', clearTimer); connection?.dispose(); };
}
