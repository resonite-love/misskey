/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { GRIDSPACE_NONCE_TTL_MS, GRIDSPACE_PROTOCOL_VERSION, verifyGridspaceRequest } from '@/core/gridspace/peer-protocol.js';
import type { GridspacePeerConfig } from '@/core/gridspace/peer-protocol.js';
import { GRIDSPACE_CALLBACK_PATH, GRIDSPACE_CLIENT_PATH } from '@/core/gridspace/link-crypto.js';
import type { GridspacePeerLinkRequest } from '@/core/gridspace/GridspaceLinkService.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type ClaimGridspaceNonce = (key: string, ttlMs: number) => Promise<boolean>;

/** Mounted under /gridspace/v1; independent from user-authorized /api endpoints. */
export function registerGridspacePeer(fastify: FastifyInstance, config: GridspacePeerConfig | null, claimNonce: ClaimGridspaceNonce, action?: (name: string, body: GridspacePeerLinkRequest) => Promise<object>, notes?: (name: string, noteId: string) => Promise<object>): void {
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
	const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
		if (!Buffer.isBuffer(request.rawBody)) return reply.code(403).send({ error: 'PEER_AUTHENTICATION_FAILED' });
		const nonce = verifyGridspaceRequest(config, request.method, request.url, request.rawBody, request.headers);
		if (nonce === null) return reply.code(403).send({ error: 'PEER_AUTHENTICATION_FAILED' });
		try {
			const claimed = await claimNonce(`gridspace:nonce:${config.communityId}:${config.keyId}:${nonce}`, GRIDSPACE_NONCE_TTL_MS);
			if (!claimed) return reply.code(409).send({ error: 'PEER_REQUEST_REPLAYED' });
		} catch {
			return reply.code(503).send({ error: 'PEER_AUTHENTICATION_UNAVAILABLE' });
		}
	};
	fastify.post<{ Body: { protocolVersion: number } }>('/handshake', {
		bodyLimit: 4096,
		config: { rawBody: true },
		preHandler: authenticate,
		schema: {
			body: {
				type: 'object',
				properties: { protocolVersion: { type: 'integer' } },
				required: ['protocolVersion'],
				additionalProperties: false,
			},
		},
	}, async (request, reply) => {
		if (request.body.protocolVersion !== GRIDSPACE_PROTOCOL_VERSION) {
			return reply.code(409).send({ error: 'PEER_PROTOCOL_INCOMPATIBLE', protocolVersion: GRIDSPACE_PROTOCOL_VERSION });
		}
		return {
			protocolVersion: GRIDSPACE_PROTOCOL_VERSION,
			communityId: config.communityId,
			origin: config.origin,
			peerOrigin: config.peerOrigin,
			// Only advertise features once their authorization and persistence are implemented.
			features: [...(action ? ['account-link-follow-copy'] : []), ...(notes ? ['community-notes'] : [])],
		};
	});
	if (notes) {
		for (const name of ['read', 'sync']) {
			fastify.post<{ Body: { noteId: string } }>(`/notes/${name}`, {
				bodyLimit: 4096, config: { rawBody: true }, preHandler: authenticate,
				schema: { body: { type: 'object', additionalProperties: false, required: ['noteId'], properties: {
					noteId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
				} } },
			}, async (request, reply) => {
				try { return await notes(name, request.body.noteId); } catch {
					return reply.code(503).send({ error: 'PEER_NOTE_UNAVAILABLE' });
				}
			});
		}
	}
	if (!action) return;
	fastify.get('/oauth-client', async () => ({
		client_id: config.origin + GRIDSPACE_CLIENT_PATH,
		client_uri: config.origin + '/',
		client_name: 'GridSpace account link',
		redirect_uris: [config.origin + GRIDSPACE_CALLBACK_PATH],
	}));
	for (const name of ['identity', 'prepare', 'check', 'revoke']) {
		fastify.post<{ Body: GridspacePeerLinkRequest }>(`/link/${name}`, {
			bodyLimit: 4096, config: { rawBody: true }, preHandler: authenticate,
			schema: {
				body: {
					type: 'object', additionalProperties: false,
					properties: {
						accessToken: { type: 'string', minLength: 1, maxLength: 512 },
						linkId: { type: 'string', format: 'uuid' },
						generation: { type: 'integer', minimum: 1, maximum: 2147483647 },
						localUserId: { type: 'string', minLength: 1, maxLength: 32 },
						localUsername: { type: 'string', minLength: 1, maxLength: 128 },
					},
					required: name === 'identity' ? ['accessToken'] : name === 'revoke' ? ['linkId', 'generation', 'localUserId'] : name === 'check' ? ['accessToken', 'linkId', 'generation', 'localUserId'] : ['accessToken', 'linkId', 'generation', 'localUserId', 'localUsername'],
				},
			},
		}, async (request, reply) => {
			try { return await action(name, request.body); } catch (error) {
				const code = error instanceof Error && 'code' in error ? error.code : null;
				const known = ['LINK_CONFLICT', 'LINK_REVOKED', 'AUTHORIZATION_REVOKED', 'SNAPSHOT_TOO_LARGE', 'INVALID_CALLBACK'];
				return reply.code(code === 'AUTHORIZATION_REVOKED' ? 403 : 409).send({ error: typeof code === 'string' && known.includes(code) ? code : 'PEER_UNAVAILABLE' });
			}
		});
	}
}
