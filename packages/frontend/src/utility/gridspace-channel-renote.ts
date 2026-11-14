/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { misskeyApi } from '@/utility/misskey-api.js';
import { forgetReplyRequest, rememberReplyRequest } from '@/utility/gridspace-reply-request.js';

export class GridspaceChannelRenoteError extends Error {
	constructor(cause: unknown, public readonly uncertain: boolean) {
		super(cause instanceof Error ? cause.message : 'Channel renote failed', { cause });
	}
}

/** Retry the same operation after a timeout instead of creating another renote. */
export async function renoteGridspaceChannel(accountId: string, channelId: string, renoteId: string, signal?: AbortSignal) {
	const target = { channelId, renoteId };
	const prepared = await misskeyApi('gridspace/channel-post', { action: 'prepare', ...target }, undefined, signal).catch(error => { throw new GridspaceChannelRenoteError(error, false); });
	if (!prepared.canReply) throw new GridspaceChannelRenoteError(new Error('Channel is unavailable'), false);
	const key = `channel:${channelId}:renote:${renoteId}`;
	const requestId = rememberReplyRequest(accountId, key, crypto.randomUUID());
	try {
		const result = await misskeyApi('gridspace/channel-post', { action: 'send', ...target, requestId, expectedActorUri: prepared.account.uri }, undefined, signal);
		if (!result.createdNoteId) throw new Error('Renote is not acknowledged');
		forgetReplyRequest(accountId, key, requestId);
		return result;
	} catch (error) {
		const reason = (error as { info?: { reason?: string } }).info?.reason;
		if (reason === 'REPLY_REJECTED' || reason === 'REPLY_DELETED' || reason === 'RATE_LIMITED') forgetReplyRequest(accountId, key, requestId);
		throw new GridspaceChannelRenoteError(error, !['REPLY_REJECTED', 'REPLY_DELETED', 'RATE_LIMITED', 'REPLY_UNAVAILABLE', 'AUTHORIZATION_REVOKED', 'LINK_REVOKED'].includes(reason ?? ''));
	}
}
