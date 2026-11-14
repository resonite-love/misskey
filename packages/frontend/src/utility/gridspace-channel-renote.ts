/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { misskeyApi } from '@/utility/misskey-api.js';
import { forgetReplyRequest, rememberReplyRequest } from '@/utility/gridspace-reply-request.js';

export class GridspaceChannelRenoteError extends Error {
	constructor(cause: unknown, public readonly uncertain: boolean, public readonly permissionRequired = false) {
		super(cause instanceof Error ? cause.message : 'Channel renote failed', { cause });
	}
}

/** Retry the same operation after a timeout instead of creating another renote. */
export async function renoteGridspaceChannel(accountId: string, channelId: string, renoteId: string, signal?: AbortSignal) {
	return renoteOnPeer(accountId, renoteId, channelId, undefined, signal);
}

export async function selfRenoteGridspace(accountId: string, renoteId: string, expectedActorUri: string, signal?: AbortSignal) {
	return renoteOnPeer(accountId, renoteId, undefined, expectedActorUri, signal);
}

async function renoteOnPeer(accountId: string, renoteId: string, channelId?: string, expectedActorUri?: string, signal?: AbortSignal) {
	const target = channelId ? { channelId, renoteId } : { renoteId };
	const endpoint = channelId ? 'gridspace/channel-post' : 'gridspace/private-reply';
	const prepared = await misskeyApi(endpoint, { action: 'prepare', ...target, expectedActorUri }, undefined, signal).catch(error => { throw new GridspaceChannelRenoteError(error, false); });
	if (!prepared.canReply) throw new GridspaceChannelRenoteError(new Error('Posting is unavailable'), false, !channelId);
	if (expectedActorUri && prepared.account.uri !== expectedActorUri) throw new GridspaceChannelRenoteError(new Error('Unexpected author'), false);
	const key = channelId ? `channel:${channelId}:renote:${renoteId}` : `self-renote:${renoteId}`;
	const requestId = rememberReplyRequest(accountId, key, crypto.randomUUID());
	try {
		const result = await misskeyApi(endpoint, { action: 'send', ...target, requestId, expectedActorUri: prepared.account.uri }, undefined, signal);
		if (!result.createdNoteId) throw new Error('Renote is not acknowledged');
		forgetReplyRequest(accountId, key, requestId);
		return result;
	} catch (error) {
		const reason = (error as { info?: { reason?: string } }).info?.reason;
		if (reason === 'REPLY_REJECTED' || reason === 'REPLY_DELETED' || reason === 'RATE_LIMITED') forgetReplyRequest(accountId, key, requestId);
		throw new GridspaceChannelRenoteError(error, !['REPLY_REJECTED', 'REPLY_DELETED', 'RATE_LIMITED', 'REPLY_UNAVAILABLE', 'AUTHORIZATION_REVOKED', 'LINK_REVOKED'].includes(reason ?? ''));
	}
}
