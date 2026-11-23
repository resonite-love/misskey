/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export type PeerRequestTiming = { route: string; count: number; durationMs: number; failures: number };
export type RequestTimingContext = { peers: Map<string, PeerRequestTiming>; closed: boolean };

export const requestTimingContext = new AsyncLocalStorage<RequestTimingContext>();

/** Measure the complete peer response, including its body, without retaining payloads or credentials. */
export async function measurePeerRequest<T>(route: string, operation: () => Promise<T>): Promise<T> {
	const context = requestTimingContext.getStore();
	if (!context || context.closed) return operation();
	const started = performance.now();
	let failed = false;
	try {
		return await operation();
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		if (!context.closed) {
			// Labels are fixed route names; neither query strings nor arbitrary URLs are recorded.
			const label = /^\/gridspace\/v1\/[a-z0-9/-]{1,100}$/.test(route) ? route : 'other';
			const key = context.peers.has(label) || context.peers.size < 32 ? label : 'other';
			const entry = context.peers.get(key) ?? { route: key, count: 0, durationMs: 0, failures: 0 };
			entry.count++;
			entry.durationMs += performance.now() - started;
			entry.failures += Number(failed);
			context.peers.set(key, entry);
		}
	}
}

export type SlowRequestRecord = {
	id: string;
	createdAt: string;
	route: string;
	method: string;
	statusCode: number;
	durationMs: number;
	errorCode: string | null;
	errorReason: string | null;
	peers: PeerRequestTiming[];
};
