/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const GRIDSPACE_PROTOCOL_VERSION = 1;
export const GRIDSPACE_HANDSHAKE_PATH = '/gridspace/v1/handshake';
export const GRIDSPACE_CLOCK_SKEW_MS = 60_000;
export const GRIDSPACE_NONCE_TTL_MS = GRIDSPACE_CLOCK_SKEW_MS * 2 + 1000;

export type GridspaceConfigSource = {
	enabled?: boolean;
	communityId: string;
	peerUrl: string;
	/** Optional HTTPS transport within the private network; identities remain peerUrl. */
	peerTransportUrl?: string;
	/** CA certificate file for the private transport (never disables TLS verification). */
	peerTlsCaFile?: string;
	/** One-way channel access. Source hosts channels; client accepts its local users. */
	channelRole?: 'source' | 'client';
	keyId: string;
	secretEnv: string;
};

export type GridspacePeerConfig = {
	origin: string;
	peerOrigin: string;
	transportOrigin?: string;
	transportCa?: string;
	communityId: string;
	keyId: string;
	secret: Buffer;
};

function httpsOrigin(value: string): string {
	const url = new URL(value);
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
		throw new Error('GridSpace URLs must be HTTPS origins without credentials, paths, queries or fragments.');
	}
	return url.origin;
}

export function resolveGridspaceConfig(source: GridspaceConfigSource | undefined, ownUrl: string, env: NodeJS.ProcessEnv): GridspacePeerConfig | null {
	if (source?.enabled == null || source.enabled === false) return null;
	if (source.enabled !== true) throw new Error('GridSpace enabled must be a boolean.');
	if (source.channelRole !== undefined && !['source', 'client'].includes(source.channelRole)) throw new Error('Invalid GridSpace channel role.');
	if (typeof source.communityId !== 'string' || typeof source.keyId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(source.communityId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(source.keyId)) {
		throw new Error('GridSpace communityId and keyId must be 1 to 64 ASCII letters, digits, underscores or hyphens.');
	}
	if (typeof source.secretEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(source.secretEnv)) {
		throw new Error('GridSpace secretEnv must name an environment variable.');
	}
	const encoded = env[source.secretEnv];
	if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
		throw new Error('GridSpace requires a base64-encoded 32-byte shared secret in secretEnv.');
	}
	const secret = Buffer.from(encoded, 'base64');
	if (secret.length !== 32 || secret.toString('base64') !== encoded) {
		throw new Error('GridSpace shared secret has an invalid encoding.');
	}
	const origin = httpsOrigin(ownUrl);
	const peerOrigin = httpsOrigin(source.peerUrl);
	if (origin === peerOrigin) throw new Error('GridSpace peer must be a different origin.');
	const transportOrigin = source.peerTransportUrl == null ? undefined : httpsOrigin(source.peerTransportUrl);
	if (source.peerTlsCaFile != null && (!transportOrigin || typeof source.peerTlsCaFile !== 'string' || source.peerTlsCaFile.length === 0)) throw new Error('GridSpace private CA requires a transport URL and a certificate file.');
	const transportCa = source.peerTlsCaFile == null ? undefined : readFileSync(source.peerTlsCaFile, 'utf8');
	return { origin, peerOrigin, transportOrigin, transportCa, communityId: source.communityId, keyId: source.keyId, secret };
}

function signature(config: GridspacePeerConfig, sender: string, recipient: string, method: string, path: string, timestamp: string, nonce: string, body: Buffer): string {
	const digest = createHash('sha256').update(body).digest('hex');
	const message = ['gridspace-v1', config.communityId, config.keyId, sender, recipient, method, path, timestamp, nonce, digest].join('\n');
	return createHmac('sha256', config.secret).update(message).digest('base64url');
}

export function createGridspaceHeaders(config: GridspacePeerConfig, method: string, path: string, body: Buffer, now = Date.now()): Record<string, string> {
	const timestamp = String(now);
	const nonce = randomBytes(24).toString('base64url');
	return {
		'content-type': 'application/json',
		'x-gridspace-origin': config.origin,
		'x-gridspace-key-id': config.keyId,
		'x-gridspace-timestamp': timestamp,
		'x-gridspace-nonce': nonce,
		'x-gridspace-signature': signature(config, config.origin, config.peerOrigin, method, path, timestamp, nonce, body),
	};
}

/** Authenticate exact wire bytes before allowing a nonce into the shared replay store. */
export function verifyGridspaceRequest(config: GridspacePeerConfig, method: string, path: string, body: Buffer, headers: Record<string, string | string[] | undefined>, now = Date.now()): string | null {
	const origin = headers['x-gridspace-origin'];
	const keyId = headers['x-gridspace-key-id'];
	const timestamp = headers['x-gridspace-timestamp'];
	const nonce = headers['x-gridspace-nonce'];
	const received = headers['x-gridspace-signature'];
	if (origin !== config.peerOrigin || keyId !== config.keyId || typeof timestamp !== 'string' || typeof nonce !== 'string' || typeof received !== 'string') return null;
	if (!/^\d{13}$/.test(timestamp) || !/^[A-Za-z0-9_-]{32}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(received)) return null;
	if (Math.abs(now - Number(timestamp)) > GRIDSPACE_CLOCK_SKEW_MS) return null;
	const expected = signature(config, origin, config.origin, method, path, timestamp, nonce, body);
	if (!timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return null;
	return nonce;
}
