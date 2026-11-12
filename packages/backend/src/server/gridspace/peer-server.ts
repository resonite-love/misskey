/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { GRIDSPACE_NONCE_TTL_MS, GRIDSPACE_PROTOCOL_VERSION, verifyGridspaceRequest } from '@/core/gridspace/peer-protocol.js';
import type { GridspacePeerConfig } from '@/core/gridspace/peer-protocol.js';
import type { FastifyInstance } from 'fastify';

export type ClaimGridspaceNonce = (key: string, ttlMs: number) => Promise<boolean>;

/** Mounted under /gridspace/v1; independent from user-authorized /api endpoints. */
export function registerGridspacePeer(fastify: FastifyInstance, config: GridspacePeerConfig | null, claimNonce: ClaimGridspaceNonce): void {
	if (config === null) return;
	// Preserve wire bytes for the signature without changing other server plugins' parsers.
	const parseJson = fastify.getDefaultJsonParser('error', 'error');
	fastify.removeAllContentTypeParsers();
	fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
		parseJson(request, body.toString('utf8'), done);
	});
	fastify.addHook('onRequest', async (_request, reply) => {
		reply.header('Cache-Control', 'no-store');
	});
	fastify.post<{ Body: { protocolVersion: number } }>('/handshake', {
		bodyLimit: 4096,
		config: { rawBody: true },
		schema: {
			body: {
				type: 'object',
				properties: { protocolVersion: { type: 'integer' } },
				required: ['protocolVersion'],
				additionalProperties: false,
			},
		},
	}, async (request, reply) => {
		if (!Buffer.isBuffer(request.rawBody)) return reply.code(403).send({ error: 'PEER_AUTHENTICATION_FAILED' });
		const nonce = verifyGridspaceRequest(config, request.method, request.url, request.rawBody, request.headers);
		if (nonce === null) return reply.code(403).send({ error: 'PEER_AUTHENTICATION_FAILED' });
		try {
			const claimed = await claimNonce(`gridspace:nonce:${config.communityId}:${config.keyId}:${nonce}`, GRIDSPACE_NONCE_TTL_MS);
			if (!claimed) return reply.code(409).send({ error: 'PEER_REQUEST_REPLAYED' });
		} catch {
			return reply.code(503).send({ error: 'PEER_AUTHENTICATION_UNAVAILABLE' });
		}
		if (request.body.protocolVersion !== GRIDSPACE_PROTOCOL_VERSION) {
			return reply.code(409).send({ error: 'PEER_PROTOCOL_INCOMPATIBLE', protocolVersion: GRIDSPACE_PROTOCOL_VERSION });
		}
		return {
			protocolVersion: GRIDSPACE_PROTOCOL_VERSION,
			communityId: config.communityId,
			origin: config.origin,
			peerOrigin: config.peerOrigin,
			// Only advertise features once their authorization and persistence are implemented.
			features: [] as string[],
		};
	});
}
