/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { sharedDriveRequestSchema, type SharedDriveRequest } from '@/core/gridspace/shared-drive-protocol.js';
import { managedPeerSchema, type ManagedPeerInput } from '@/core/gridspace/managed-resource-protocol.js';
import { channelActionSchema, channelOptionsSchema, type ChannelPeerRequest, type ChannelUpdatePeerRequest } from '@/core/gridspace/channel-protocol.js';
import { contentOptionsSchema, type ContentOptions } from '@/core/gridspace/content-protocol.js';
import { driveOptionsSchema, type DrivePeerRequest } from '@/core/gridspace/drive-protocol.js';
import { GRIDSPACE_NOTE_BATCH_LIMIT } from '@/core/gridspace/note-protocol.js';
import { GRIDSPACE_NONCE_TTL_MS, GRIDSPACE_PROTOCOL_VERSION, verifyGridspaceRequest } from '@/core/gridspace/peer-protocol.js';
import type { GridspacePeerConfig } from '@/core/gridspace/peer-protocol.js';
import { GRIDSPACE_CALLBACK_PATH, GRIDSPACE_CLIENT_PATH, GRIDSPACE_PRIVATE_CLIENT_PATH } from '@/core/gridspace/link-crypto.js';
import { notificationOptionsSchema, type NotificationPeerRequest } from '@/core/gridspace/notification-protocol.js';
import { privateOptionsSchema, type PrivatePeerRequest } from '@/core/gridspace/private-protocol.js';
import { noteMenuProperties, type NoteMenuPeerRequest } from '@/core/gridspace/note-menu-protocol.js';
import { actionOptionsSchema, uploadWireSchema, type ActionPeerRequest, type UploadPeerRequest } from '@/core/gridspace/action-protocol.js';
import { replyOptionsSchema, type ReplyPeerRequest } from '@/core/gridspace/reply-protocol.js';
import type { GridspacePeerLinkRequest } from '@/core/gridspace/GridspaceLinkService.js';
import type { HistoryPeerRequest } from '@/core/gridspace/history-protocol.js';
import type { SearchPeerRequest } from '@/core/gridspace/search-protocol.js';
import type { ReactionPeerRequest, ReactionUpdate } from '@/core/gridspace/reaction-protocol.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type ClaimGridspaceNonce = (key: string, ttlMs: number) => Promise<boolean>;

/** Mounted under /gridspace/v1; independent from user-authorized /api endpoints. */
export function registerGridspacePeer(fastify: FastifyInstance, config: GridspacePeerConfig | null, claimNonce: ClaimGridspaceNonce, action?: (name: string, body: GridspacePeerLinkRequest) => Promise<object>, notes?: (name: string, noteId: string) => Promise<object>, history?: (input: HistoryPeerRequest) => Promise<object>, search?: (input: SearchPeerRequest) => Promise<object>, privateAction?: (name: string, input: PrivatePeerRequest) => Promise<object>, replyAction?: (input: ReplyPeerRequest) => Promise<object>, notifications?: (action: string, input: NotificationPeerRequest) => Promise<object>, interact?: (input: ActionPeerRequest) => Promise<object>, upload?: (input: UploadPeerRequest) => Promise<object>, reactions?: (input: ReactionPeerRequest) => Promise<object>, reactionUpdates?: (input: ReactionUpdate) => Promise<object>, readNotes?: (noteIds: string[]) => Promise<object>, channels?: (input: ChannelPeerRequest) => Promise<object>, channelDelete?: (input: GridspacePeerLinkRequest & { noteId: string; channelId: string }) => Promise<object>, drive?: (input: DrivePeerRequest) => Promise<object>, content?: (input: ContentOptions) => Promise<object>, sharedDrive?: (input: SharedDriveRequest) => Promise<object>, managed?: (input: ManagedPeerInput) => Promise<object>, channelUpdate?: (input: ChannelUpdatePeerRequest) => Promise<object>, noteMenu?: (input: NoteMenuPeerRequest) => Promise<object>): void {
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
			features: [...(action ? ['account-link-follow-copy'] : []), ...(notes ? ['community-notes'] : []), ...(readNotes ? ['community-note-batch'] : []), ...(history ? ['member-history'] : []), ...(search ? ['community-search'] : []), ...(privateAction ? ['private-note-read'] : []), ...(notifications ? ['linked-notifications'] : []), ...(reactions ? ['community-reactions'] : []), ...(reactionUpdates ? ['community-reaction-updates'] : [])],
		};
	});
	if (sharedDrive) {
		fastify.post<{ Body: SharedDriveRequest }>('/shared-drive', {
			bodyLimit: 512 * 1024, config: { rawBody: true }, preHandler: authenticate, schema: { body: sharedDriveRequestSchema },
		}, async (request, reply) => {
			try { return await sharedDrive(request.body); } catch { return reply.code(409).send({ error: 'SHARED_DRIVE_UNAVAILABLE' }); }
		});
	}
	if (managed) {
		fastify.post<{ Body: ManagedPeerInput }>('/managed-resource', {
			bodyLimit: 1024 * 1024, config: { rawBody: true }, preHandler: authenticate, schema: { body: managedPeerSchema },
		}, async (request, reply) => {
			try { return await managed(request.body); } catch { return reply.code(403).send({ error: 'RESOURCE_UNAVAILABLE' }); }
		});
	}
	if (content) {
		fastify.post<{ Body: ContentOptions }>('/content', {
			bodyLimit: 4096, config: { rawBody: true }, preHandler: authenticate,
			schema: { body: { type: 'object', additionalProperties: false, properties: contentOptionsSchema, required: ['kind'] } },
		}, async (request) => content(request.body));
	}
	if (drive) {
		fastify.post<{ Body: DrivePeerRequest }>('/drive', {
			bodyLimit: 4096, config: { rawBody: true }, preHandler: authenticate,
			schema: { body: { type: 'object', additionalProperties: false, properties: {
				...driveOptionsSchema,
				accessToken: { type: 'string', minLength: 1, maxLength: 512 }, linkId: { type: 'string', format: 'uuid' },
				generation: { type: 'integer', minimum: 1, maximum: 2147483647 }, localUserId: { type: 'string', minLength: 1, maxLength: 32 },
			}, required: ['accessToken', 'linkId', 'generation', 'localUserId'] } },
		}, async (request, reply) => {
			try { return await drive(request.body); } catch (error) {
				const code = error instanceof Error && 'code' in error ? error.code : null;
				return reply.code(code === 'AUTHORIZATION_REVOKED' ? 403 : 409).send({ error: ['AUTHORIZATION_REVOKED', 'LINK_REVOKED', 'FILE_REJECTED'].includes(String(code)) ? code : 'PEER_UNAVAILABLE' });
			}
		});
	}
	if (channels) {
		fastify.post<{ Body: ChannelPeerRequest }>('/private/channels', {
			bodyLimit: 16384, config: { rawBody: true }, preHandler: authenticate,
			schema: { body: { type: 'object', additionalProperties: false, allOf: [{ anyOf: [{ required: ['accessToken', 'linkId', 'generation', 'localUserId'] }, { required: ['channelActorId'] }] }], properties: {
				...channelOptionsSchema,
				channelActorId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, accessToken: { type: 'string', minLength: 1, maxLength: 512 }, linkId: { type: 'string', format: 'uuid' }, pairId: { type: 'string', format: 'uuid' },
				generation: { type: 'integer', minimum: 1, maximum: 2147483647 }, localUserId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
			} } },
		}, async (request, reply) => {
			try { return await channels(request.body); } catch { return reply.code(403).send({ error: 'AUTHORIZATION_REVOKED' }); }
		});
	}
	if (channelUpdate) {
		fastify.post<{ Body: ChannelUpdatePeerRequest }>('/private/channel-update', {
			bodyLimit: 4096, config: { rawBody: true }, preHandler: authenticate,
			schema: { body: { type: 'object', additionalProperties: false, required: ['channelId', 'action'], oneOf: [
				{ required: ['accessToken', 'linkId', 'generation', 'localUserId'], not: { required: ['channelActorId'] } },
				{ required: ['channelActorId'], not: { required: ['accessToken'] } },
			], properties: {
				channelId: channelOptionsSchema.channelId, action: channelActionSchema, channelActorId: channelOptionsSchema.channelId,
				accessToken: { type: 'string', minLength: 1, maxLength: 512 }, linkId: { type: 'string', format: 'uuid' }, pairId: { type: 'string', format: 'uuid' },
				generation: { type: 'integer', minimum: 1, maximum: 2147483647 }, localUserId: channelOptionsSchema.channelId,
			} } },
		}, async (request, reply) => {
			try { return await channelUpdate(request.body); } catch (error) {
				const code = error instanceof Error && 'code' in error ? error.code : null;
				const denied = code === 'AUTHORIZATION_REVOKED' || code === 'LINK_REVOKED';
				return reply.code(code === 'CHANNEL_UNAVAILABLE' ? 404 : denied ? 403 : 503).send({ error: code === 'CHANNEL_UNAVAILABLE' ? 'CHANNEL_UNAVAILABLE' : denied ? 'AUTHORIZATION_REVOKED' : 'PEER_UNAVAILABLE' });
			}
		});
	}
	if (channelDelete) {
		fastify.post<{ Body: GridspacePeerLinkRequest & { noteId: string; channelId: string } }>('/private/channel-delete', {
			bodyLimit: 4096, config: { rawBody: true }, preHandler: authenticate,
			schema: { body: { type: 'object', additionalProperties: false, required: ['noteId', 'channelId'], properties: {
				noteId: channelOptionsSchema.channelId, channelId: channelOptionsSchema.channelId, channelActorId: channelOptionsSchema.channelId,
				accessToken: { type: 'string', maxLength: 512 }, linkId: { type: 'string', format: 'uuid' }, pairId: { type: 'string', format: 'uuid' },
				generation: { type: 'integer', minimum: 1 }, localUserId: channelOptionsSchema.channelId,
			} } },
		}, async (request, reply) => {
			try { return await channelDelete(request.body); } catch { return reply.code(403).send({ error: 'AUTHORIZATION_REVOKED' }); }
		});
	}
	if (reactionUpdates) {
		fastify.post<{ Body: ReactionUpdate }>('/reactions/updated', {
			bodyLimit: 65536, config: { rawBody: true }, preHandler: authenticate,
			schema: { body: { type: 'object', additionalProperties: false, required: ['uris'], properties: {
				uris: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', maxLength: 512 } },
			} } },
		}, async (request, reply) => {
			try { return await reactionUpdates(request.body); } catch { return reply.code(503).send({ error: 'PEER_REACTION_UPDATE_UNAVAILABLE' }); }
		});
	}
	if (reactions) {
		const position = { type: 'object', additionalProperties: false, required: ['time', 'id', 'origin'], properties: {
			time: { type: 'integer', minimum: 0, maximum: 4102444800000 }, id: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, origin: { type: 'string', enum: [config.origin, config.peerOrigin] },
		} };
		fastify.post<{ Body: ReactionPeerRequest }>('/reactions', {
			bodyLimit: 32768, config: { rawBody: true }, preHandler: authenticate,
			schema: { body: { type: 'object', additionalProperties: false, required: ['mode', 'uris'], properties: {
				mode: { type: 'string', enum: ['show', 'list'] }, uris: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', maxLength: 512 } },
				withPreviews: { type: 'boolean' },
				viewerId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, type: { type: 'string', nullable: true, maxLength: 260 },
				limit: { type: 'integer', minimum: 1, maximum: 100 }, before: position, after: position,
			} } },
		}, async (request, reply) => {
			if (request.body.mode === 'list' && request.body.uris.length !== 1) return reply.code(400).send({ error: 'INVALID_REACTIONS' });
			try { return await reactions(request.body); } catch { return reply.code(503).send({ error: 'PEER_REACTIONS_UNAVAILABLE' }); }
		});
	}
	if (search) {
		const id = { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' };
		const date = { type: 'integer', minimum: 1, maximum: 4102444800000 };
		fastify.post<{ Body: SearchPeerRequest }>('/search', {
			bodyLimit: 4096, config: { rawBody: true }, preHandler: authenticate,
			schema: { body: { type: 'object', additionalProperties: false, required: ['kind', 'query', 'limit'], properties: {
				kind: { type: 'string', enum: ['notes', 'users'] }, query: { type: 'string', minLength: 1, maxLength: 200 },
				viewerId: id, targetId: id, before: id, head: id,
				ids: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: id },
				limit: { type: 'integer', minimum: 0, maximum: 20 }, rangeStartAt: date, rangeEndAt: date,
				link: { type: 'object', additionalProperties: false, required: ['id', 'generation', 'counterpartId'], properties: {
					id: { type: 'string', format: 'uuid' }, generation: { type: 'integer', minimum: 1, maximum: 2147483647 }, counterpartId: id,
				} },
			} } },
		}, async (request, reply) => {
			if (request.body.link && !request.body.targetId) return reply.code(400).send({ error: 'INVALID_SEARCH' });
			try { return await search(request.body); } catch { return reply.code(503).send({ error: 'PEER_SEARCH_UNAVAILABLE' }); }
		});
	}
	if (history) {
		const id = { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' };
		fastify.post<{ Body: HistoryPeerRequest }>('/history', {
			bodyLimit: 4096, config: { rawBody: true }, preHandler: authenticate,
			schema: { body: { type: 'object', additionalProperties: false,
				required: ['userId', 'counterpartId', 'linkId', 'generation', 'limit', 'withReplies', 'withRenotes', 'withFiles'],
				properties: {
					userId: id, counterpartId: id, viewerId: id, before: id, head: id,
					linkId: { type: 'string', format: 'uuid' }, generation: { type: 'integer', minimum: 1, maximum: 2147483647 },
					limit: { type: 'integer', minimum: 0, maximum: 20 },
					withReplies: { type: 'boolean' }, withRenotes: { type: 'boolean' }, withFiles: { type: 'boolean' },
				},
			} },
		}, async (request, reply) => {
			try { return await history(request.body); } catch { return reply.code(503).send({ error: 'PEER_HISTORY_UNAVAILABLE' }); }
		});
	}
	if (readNotes) {
		fastify.post<{ Body: { noteIds: string[] } }>('/notes/read-many', {
			bodyLimit: 4096, config: { rawBody: true }, preHandler: authenticate,
			schema: { body: { type: 'object', additionalProperties: false, required: ['noteIds'], properties: {
				noteIds: { type: 'array', minItems: 1, maxItems: GRIDSPACE_NOTE_BATCH_LIMIT, uniqueItems: true, items: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' } },
			} } },
		}, async (request, reply) => {
			try { return await readNotes(request.body.noteIds); } catch { return reply.code(503).send({ error: 'PEER_NOTE_UNAVAILABLE' }); }
		});
	}

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
	if (notifications) {
		for (const name of ['query', 'read', 'read-all', 'accept-follow', 'reject-follow']) {
			fastify.post<{ Body: NotificationPeerRequest }>(`/notifications/${name}`, {
				bodyLimit: 16384, config: { rawBody: true }, preHandler: authenticate,
				schema: { body: { type: 'object', additionalProperties: false,
					required: ['accessToken', 'linkId', 'generation', 'localUserId', ...(name === 'read' ? ['ids'] : [])], properties: {
						...notificationOptionsSchema,
						followRequestId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
						channelActorId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, accessToken: { type: 'string', minLength: 1, maxLength: 512 }, linkId: { type: 'string', format: 'uuid' }, pairId: { type: 'string', format: 'uuid' },
						generation: { type: 'integer', minimum: 1, maximum: 2147483647 }, localUserId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
					} } },
			}, async (request, reply) => {
				try { return await notifications(name, request.body); } catch (error) {
					const code = error instanceof Error && 'code' in error ? error.code : null;
					return reply.code(403).send({ error: typeof code === 'string' && ['AUTHORIZATION_REVOKED', 'LINK_REVOKED', 'ACTION_REJECTED', 'INVALID_REQUEST'].includes(code) ? code : 'PEER_UNAVAILABLE' });
				}
			});
		}
	}
	if (noteMenu) {
  fastify.post<{ Body: NoteMenuPeerRequest }>('/private/note-menu', {
   bodyLimit: 16384, config: { rawBody: true }, preHandler: authenticate,
   schema: { body: { type: 'object', additionalProperties: false, required: ['noteId', 'accessToken', 'linkId', 'generation', 'localUserId'], properties: {
    ...noteMenuProperties, accessToken: { type: 'string', minLength: 1, maxLength: 512 }, linkId: { type: 'string', format: 'uuid' }, pairId: { type: 'string', format: 'uuid' },
    generation: { type: 'integer', minimum: 1, maximum: 2147483647 }, localUserId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
   } } },
  }, async (request, reply) => {
   try { return await noteMenu(request.body); } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : null;
    return reply.code(403).send({ error: typeof code === 'string' && ['AUTHORIZATION_REVOKED', 'LINK_REVOKED', 'ACTION_REJECTED', 'RATE_LIMITED'].includes(code) ? code : 'PEER_UNAVAILABLE' });
   }
  });
 }
	if (interact) {
		fastify.post<{ Body: ActionPeerRequest }>('/private/action', {
			bodyLimit: 16384, config: { rawBody: true }, preHandler: authenticate,
			schema: { body: { type: 'object', additionalProperties: false, required: ['noteId'], allOf: [{ anyOf: [{ required: ['accessToken', 'linkId', 'generation', 'localUserId'] }, { required: ['channelActorId', 'channelId'] }] }], properties: {
				...actionOptionsSchema,
				channelActorId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, accessToken: { type: 'string', minLength: 1, maxLength: 512 }, linkId: { type: 'string', format: 'uuid' }, pairId: { type: 'string', format: 'uuid' },
				generation: { type: 'integer', minimum: 1, maximum: 2147483647 }, localUserId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
			} } },
		}, async (request, reply) => {
			try { return await interact(request.body); } catch (error) {
				const code = error instanceof Error && 'code' in error ? error.code : null;
				const known = ['AUTHORIZATION_REVOKED', 'LINK_REVOKED', 'ACTION_REJECTED', 'FILE_REJECTED', 'RATE_LIMITED'];
				return reply.code(403).send({ error: typeof code === 'string' && known.includes(code) ? code : 'PEER_UNAVAILABLE' });
			}
		});
	}
	if (upload) {
		fastify.post<{ Body: UploadPeerRequest }>('/private/upload', {
			bodyLimit: 24 * 1024 * 1024, config: { rawBody: true }, preHandler: authenticate,
			schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'data'], allOf: [{ anyOf: [{ required: ['accessToken', 'linkId', 'generation', 'localUserId'] }, { required: ['channelActorId', 'channelId'] }] }], anyOf: [{ required: ['noteId'] }, { required: ['channelId'] }], properties: {
				...uploadWireSchema,
				channelActorId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, accessToken: { type: 'string', minLength: 1, maxLength: 512 }, linkId: { type: 'string', format: 'uuid' }, pairId: { type: 'string', format: 'uuid' },
				generation: { type: 'integer', minimum: 1, maximum: 2147483647 }, localUserId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
			} } },
		}, async (request, reply) => {
			try { return await upload(request.body); } catch (error) {
				const code = error instanceof Error && 'code' in error ? error.code : null;
				const known = ['AUTHORIZATION_REVOKED', 'LINK_REVOKED', 'ACTION_REJECTED', 'FILE_REJECTED', 'RATE_LIMITED'];
				return reply.code(403).send({ error: typeof code === 'string' && known.includes(code) ? code : 'PEER_UNAVAILABLE' });
			}
		});
	}
	if (replyAction) {
		fastify.post<{ Body: ReplyPeerRequest }>('/private/reply', {
			bodyLimit: 32768, config: { rawBody: true }, preHandler: authenticate,
			schema: { body: { type: 'object', additionalProperties: false, allOf: [{ anyOf: [{ required: ['accessToken', 'linkId', 'generation', 'localUserId'] }, { required: ['channelActorId'] }] }], anyOf: [{ required: ['noteId'] }, { required: ['channelId'] }], properties: {
				...replyOptionsSchema,
				channelActorId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, accessToken: { type: 'string', minLength: 1, maxLength: 512 }, linkId: { type: 'string', format: 'uuid' }, pairId: { type: 'string', format: 'uuid' },
				generation: { type: 'integer', minimum: 1, maximum: 2147483647 }, localUserId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
			} } },
		}, async (request, reply) => {
			try { return await replyAction(request.body); } catch (error) {
				const code = error instanceof Error && 'code' in error ? error.code : null;
				const known = ['AUTHORIZATION_REVOKED', 'LINK_REVOKED', 'REPLY_UNAVAILABLE', 'REPLY_REJECTED', 'REPLY_CONFLICT', 'REPLY_DELETED', 'RATE_LIMITED'];
				return reply.code(403).send({ error: typeof code === 'string' && known.includes(code) ? code : 'PEER_UNAVAILABLE' });
			}
		});
	}
	if (privateAction) {
		fastify.get('/private-oauth-client', async () => ({
			client_id: config.origin + GRIDSPACE_PRIVATE_CLIENT_PATH, client_uri: config.origin + '/',
			client_name: 'GridSpace private note reader', redirect_uris: [config.origin + GRIDSPACE_CALLBACK_PATH],
		}));
		for (const name of ['authorize', 'check', 'revoke', 'notes', 'file', 'collections', 'mutual-probe', 'reciprocal', 'pair-check']) {
			const { userId: _userId, ...readOptions } = privateOptionsSchema;
			fastify.post<{ Body: PrivatePeerRequest }>(`/private/${name}`, {
				bodyLimit: 16384, config: { rawBody: true }, preHandler: authenticate,
				schema: { body: { type: 'object', additionalProperties: false, allOf: [{ anyOf: [{ required: ['accessToken', 'linkId', 'generation', 'localUserId'] }, { required: ['channelActorId'] }] }], properties: {
					...readOptions,
					collectionKind: { type: 'string', enum: ['status', 'clips', 'clip-favorites'] },
					channelActorId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, accessToken: { type: 'string', minLength: 1, maxLength: 512 }, linkId: { type: 'string', format: 'uuid' },
					pairId: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483647 },
					reverseToken: { type: 'string', minLength: 1, maxLength: 512 },
					generation: { type: 'integer', minimum: 1, maximum: 2147483647 }, localUserId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
					targetUris: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', maxLength: 512 } },
					before: readOptions.noteId, head: readOptions.noteId, fileId: readOptions.noteId,
					limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
				} } },
			}, async (request, reply) => {
				try { return await privateAction(name, request.body); } catch (error) {
					const code = error instanceof Error && 'code' in error ? error.code : null;
					const known = ['AUTHORIZATION_REVOKED', 'LINK_REVOKED'];
					return reply.code(403).send({ error: typeof code === 'string' && known.includes(code) ? code : 'PEER_UNAVAILABLE' });
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
	for (const name of ['identity', 'prepare', 'check', 'revoke', 'profile-ready', 'palette', 'profile', 'settings', 'lists', 'antennas', 'plays']) {
		fastify.post<{ Body: GridspacePeerLinkRequest }>(`/link/${name}`, {
			bodyLimit: 4096, config: { rawBody: true }, preHandler: authenticate,
			schema: {
				body: {
					type: 'object', additionalProperties: false,
					properties: {
						channelActorId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' }, accessToken: { type: 'string', minLength: 1, maxLength: 512 },
						linkId: { type: 'string', format: 'uuid' },
						generation: { type: 'integer', minimum: 1, maximum: 2147483647 },
						localUserId: { type: 'string', minLength: 1, maxLength: 32 },
						localUsername: { type: 'string', minLength: 1, maxLength: 128 },
						playId: { type: 'string', pattern: '^[a-zA-Z0-9]{1,32}$' },
					},
					required: name === 'identity' ? ['accessToken'] : (name === 'revoke' || name === 'profile-ready') ? ['linkId', 'generation', 'localUserId'] : (name === 'check' || name === 'palette' || name === 'profile' || name === 'settings' || name === 'lists' || name === 'antennas' || name === 'plays') ? ['accessToken', 'linkId', 'generation', 'localUserId'] : ['accessToken', 'linkId', 'generation', 'localUserId', 'localUsername'],
				},
			},
		}, async (request, reply) => {
			try { return await action(name, request.body); } catch (error) {
				const code = error instanceof Error && 'code' in error ? error.code : null;
				const known = ['LINK_CONFLICT', 'LINK_REVOKED', 'AUTHORIZATION_REVOKED', 'SNAPSHOT_TOO_LARGE', 'INVALID_CALLBACK', 'PLAY_UNAVAILABLE'];
				return reply.code(code === 'AUTHORIZATION_REVOKED' ? 403 : 409).send({ error: typeof code === 'string' && known.includes(code) ? code : 'PEER_UNAVAILABLE' });
			}
		});
	}
}
