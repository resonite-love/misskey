/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { requestTimingContext } from '@/misc/request-performance.js';
import type { RequestTimingContext, SlowRequestRecord } from '@/misc/request-performance.js';
import type { FastifyInstance } from 'fastify';

export const SLOW_REQUEST_THRESHOLD_MS = 1000;

/** Observe matched API routes only; request parameters, identity, headers and bodies are never retained. */
export function registerSlowRequests(fastify: FastifyInstance, record: (entry: SlowRequestRecord) => void, thresholdMs = SLOW_REQUEST_THRESHOLD_MS): void {
	const states = new WeakMap<object, { id: string; started: number; context: RequestTimingContext; errorCode: string | null; errorReason: string | null }>();
	fastify.addHook('onRequest', (request, reply, done) => {
		const route = request.routeOptions.url;
		if (!route || !/^\/(?:api\/|gridspace\/v1\/)/.test(route) || route.includes('*')) return done();
		const state = { id: randomUUID(), started: performance.now(), context: { peers: new Map(), closed: false }, errorCode: null, errorReason: null };
		states.set(request, state);
		reply.header('X-Misskey-Request-Id', state.id);
		requestTimingContext.run(state.context, done);
	});
	// Body parsers may create their own async resources. Restore the request's context before execution.
	fastify.addHook('preHandler', (request, _reply, done) => {
		const state = states.get(request);
		if (state) requestTimingContext.run(state.context, done);
		else done();
	});
	fastify.addHook('onSend', (request, reply, payload, done) => {
		const state = states.get(request);
		if (state && reply.statusCode >= 400 && typeof payload === 'string' && payload.length < 8192) {
			try {
				const error = JSON.parse(payload)?.error;
				const code = typeof error === 'string' ? error : error?.code;
				const reason = error?.info?.reason;
				if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) state.errorCode = code;
				if (typeof reason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(reason)) state.errorReason = reason;
			} catch { /* Non-JSON errors do not need payload capture. */ }
		}
		done(null, payload);
	});
	fastify.addHook('onResponse', (request, reply, done) => {
		const state = states.get(request);
		if (state) {
			state.context.closed = true;
			states.delete(request);
			const durationMs = Math.round(performance.now() - state.started);
			if (durationMs >= thresholdMs) {
				try {
					record({ id: state.id, createdAt: new Date().toISOString(), route: request.routeOptions.url!, method: request.method,
						statusCode: reply.statusCode, durationMs, errorCode: state.errorCode, errorReason: state.errorReason,
						peers: [...state.context.peers.values()].map(peer => ({ ...peer, durationMs: Math.round(peer.durationMs) })) });
				} catch { /* Diagnostics must not affect the response lifecycle. */ }
			}
		}
		done();
	});
}
