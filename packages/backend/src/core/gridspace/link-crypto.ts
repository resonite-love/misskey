/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { GridspacePeerConfig } from './peer-protocol.js';

export const GRIDSPACE_CLIENT_PATH = '/gridspace/v1/oauth-client';
export const GRIDSPACE_PRIVATE_CLIENT_PATH = '/gridspace/v1/private-oauth-client';
export const GRIDSPACE_PRIVATE_SCOPE = 'read:gridspace-private';
export const GRIDSPACE_PRIVATE_RECIPROCAL_SCOPE = 'read:gridspace-private-reciprocal';
export const GRIDSPACE_NOTIFICATION_SCOPE = 'read:gridspace-notifications';
export const GRIDSPACE_NOTIFICATION_WRITE_SCOPE = 'write:gridspace-notifications';
export const GRIDSPACE_ACTION_SCOPE = 'write:gridspace-actions';
export const GRIDSPACE_REPLY_SCOPE = 'write:gridspace-reply';
export const GRIDSPACE_CALLBACK_PATH = '/settings/gridspace';
export const GRIDSPACE_LINK_SCOPES = ['read:account', 'read:following', 'read:blocks', 'read:mutes'];
export const gridspaceHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const gridspaceChallenge = (value: string): string => createHash('sha256').update(value).digest('base64url');

// Keys remain outside the DB. Context separation prevents using the signing key as an AES key.
function key(config: GridspacePeerConfig): Buffer {
	return Buffer.from(hkdfSync('sha256', config.secret, config.origin, 'gridspace-token-storage-v1', 32));
}

export function sealGridspaceSecret(config: GridspacePeerConfig, value: string, context: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(config), iv);
	cipher.setAAD(Buffer.from(context));
	const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function openGridspaceSecret(config: GridspacePeerConfig, value: string, context: string): string {
	const bytes = Buffer.from(value, 'base64url');
	if (bytes.length < 29) throw new Error('Invalid encrypted GridSpace credential.');
	const decipher = createDecipheriv('aes-256-gcm', key(config), bytes.subarray(0, 12));
	decipher.setAAD(Buffer.from(context));
	decipher.setAuthTag(bytes.subarray(12, 28));
	return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
