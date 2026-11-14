/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { nextTick } from 'vue';
import Settings from '@/pages/settings/gridspace.vue';

const { state, preferences, api, commit, set } = vi.hoisted(() => ({
	state: { accountSetupWizard: -1, recentlyUsedEmojis: [] as string[], gridspaceRecentEmojiImports: [] as string[] },
	preferences: { gridspacePaletteImports: [] as string[], gridspacePaletteImportPending: true, gridspaceProfileImportPending: false, gridspaceSettingsImportRequest: null as string | null, emojiPalettes: [] },
	api: vi.fn(), commit: vi.fn(), set: vi.fn(),
}));

vi.mock('@/store.js', () => ({ store: { s: state, ready: Promise.resolve(), loaded: new Promise(() => {}), set } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: preferences, cloudReady: Promise.resolve(), commit, setAccountOverride: vi.fn() } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer' } }));
vi.mock('@/accounts.js', () => ({ updateCurrentAccount: vi.fn() }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/os.js', () => ({}));
vi.mock('@/components/MkGridspaceListImport.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<div><slot/></div>' } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { _gridspace: { recentEmojiCopy: 'Import history', recentEmojiCopied: 'History imported', recentEmojiUnavailable: 'History unavailable', playImportStart: 'Copy Play', playImportFailed: 'Play failed' } }, tsx: { _gridspace: { playImportProgress: ({ done, total }: { done: number; total: number }) => `${done}/${total}` } } } }));

const key = JSON.stringify(['https://source.example', 'source-user']);
const status = { enabled: true, state: 'active', initiator: true, channelsEnabled: false, driveShared: true, peerOrigin: 'https://source.example', peerUserId: 'source-user', total: 0, items: [] };
let history: string[] | undefined;

beforeEach(() => {
	vi.clearAllMocks();
	status.channelsEnabled = false;
	Object.assign(state, { recentlyUsedEmojis: [':current:'], gridspaceRecentEmojiImports: [] });
	Object.assign(preferences, { gridspacePaletteImports: [], gridspacePaletteImportPending: true, gridspaceProfileImportPending: false, gridspaceSettingsImportRequest: null, emojiPalettes: [] });
	commit.mockImplementation((key: string, value: unknown) => Object.assign(preferences, { [key]: value }));
	set.mockImplementation((key: string, value: unknown) => Object.assign(state, { [key]: value }));
	history = [':source:', ':current:'];
	api.mockImplementation(async (endpoint: string) => {
		if (endpoint === 'gridspace/link') return status;
		if (endpoint === 'gridspace/private-grant') return { available: true, granted: true };
		if (endpoint === 'gridspace/palette') return { peerOrigin: status.peerOrigin, peerUserId: status.peerUserId,
			palette: { version: 1, palettes: [], forMain: null, forReaction: null, ...(history ? { recentlyUsedEmojis: history } : {}) } };
		throw new Error(`Unexpected request: ${endpoint}`);
	});
	sessionStorage.clear();
	window.history.replaceState({}, '', '/settings/gridspace');
});
afterEach(() => { cleanup(); sessionStorage.clear(); window.history.replaceState({}, '', '/'); });

async function mount() {
	const view = render(Settings, { global: { stubs: { MkA: { template: '<a><slot/></a>' }, MkLoading: true } } });
	for (let i = 0; i < 10; i++) { await new Promise(resolve => setTimeout(resolve, 0)); await nextTick(); }
	return view;
}

test('new-link imports include recent history and keep the receipt on this device', async () => {
	const view = await mount();
	expect(state.recentlyUsedEmojis).toEqual([':current:', ':source:']);
	expect(state.gridspaceRecentEmojiImports).toEqual([key]);
	expect(view.getByText('History imported')).toBeTruthy();
	expect(preferences.gridspacePaletteImportPending).toBe(false);
});

test('manual import works even after both palette and history were imported, without reapplying other settings', async () => {
	preferences.gridspacePaletteImports = [key];
	state.gridspaceRecentEmojiImports = [key];
	sessionStorage.setItem('gridspace-link:viewer', 'fixture-client');
	sessionStorage.setItem('gridspace-link:viewer:purpose', 'link');
	sessionStorage.setItem('gridspace-link:viewer:recent-emojis', 'true');
	window.history.replaceState({}, '', '/settings/gridspace?code=fixture&state=fixture&iss=https%3A%2F%2Fsource.example');
	await mount();
	expect(state.recentlyUsedEmojis).toEqual([':current:', ':source:']);
	expect(state.gridspaceRecentEmojiImports).toEqual([key]);
	expect(sessionStorage.getItem('gridspace-link:viewer:recent-emojis')).toBeNull();
	expect(api.mock.calls.map(([endpoint]) => endpoint)).not.toContain('gridspace/settings-import');
	expect(api.mock.calls.map(([endpoint]) => endpoint)).not.toContain('gridspace/play-import');
	expect(api.mock.calls.map(([endpoint]) => endpoint)).not.toContain('gridspace/profile-import');
	expect(commit).not.toHaveBeenCalledWith('emojiPalettes', expect.anything());
});

test('history-only callback leaves earlier profile and settings jobs pending even when channels are enabled', async () => {
	status.channelsEnabled = true;
	preferences.gridspacePaletteImports = [key];
	preferences.gridspaceProfileImportPending = true;
	preferences.gridspaceSettingsImportRequest = 'prior-settings-job';
	api.mockImplementation(async (endpoint: string) => {
		if (endpoint === 'gridspace/link') return status;
		if (endpoint === 'gridspace/private-grant' || endpoint === 'gridspace/collections' || endpoint === 'gridspace/drive') return { available: true, granted: true };
		if (endpoint === 'gridspace/palette') return { peerOrigin: status.peerOrigin, peerUserId: status.peerUserId, palette: { version: 1, palettes: [], forMain: null, forReaction: null, recentlyUsedEmojis: history } };
		throw new Error(`Unexpected request: ${endpoint}`);
	});
	sessionStorage.setItem('gridspace-link:viewer', 'fixture-client');
	sessionStorage.setItem('gridspace-link:viewer:purpose', 'link');
	sessionStorage.setItem('gridspace-link:viewer:recent-emojis', 'true');
	window.history.replaceState({}, '', '/settings/gridspace?code=fixture&state=fixture&iss=https%3A%2F%2Fsource.example');
	const view = await mount();
	expect(view.getByText('History imported')).toBeTruthy();
	expect(preferences.gridspaceProfileImportPending).toBe(true);
	expect(preferences.gridspaceSettingsImportRequest).toBe('prior-settings-job');
	expect(api.mock.calls.map(([endpoint]) => endpoint)).not.toContain('gridspace/profile-import');
	expect(api.mock.calls.map(([endpoint]) => endpoint)).not.toContain('gridspace/settings-import');
	expect(api.mock.calls.map(([endpoint]) => endpoint)).not.toContain('gridspace/play-import');
});

test('old source snapshots do not clear history or mark the import complete', async () => {
	history = undefined;
	await mount();
	expect(state.recentlyUsedEmojis).toEqual([':current:']);
	expect(state.gridspaceRecentEmojiImports).toEqual([]);
});

test('a normal retry does not fetch or reapply history already imported on this device', async () => {
	preferences.gridspacePaletteImports = [key];
	state.gridspaceRecentEmojiImports = [key];
	await mount();
	expect(state.recentlyUsedEmojis).toEqual([':current:']);
	expect(api.mock.calls.map(([endpoint]) => endpoint)).not.toContain('gridspace/palette');
});

test('manual Play import uses its own job and resumes through bounded steps', async () => {
 status.channelsEnabled = true;
 preferences.gridspacePaletteImports = [key];
 api.mockImplementation(async (endpoint: string, params?: { action?: string }) => {
  if (endpoint === 'gridspace/link') return status;
  if (['gridspace/private-grant', 'gridspace/collections', 'gridspace/drive'].includes(endpoint)) return { available: true, granted: true };
  if (endpoint === 'gridspace/play-import') {
   if (params?.action === 'status') return { started: false, complete: false, total: 0, done: 0, failed: 0, pending: 0 };
   if (params?.action === 'start') return { started: true, complete: false, total: 1, done: 0, failed: 0, pending: 1 };
   return { started: true, complete: true, total: 1, done: 1, failed: 0, pending: 0 };
  }
  throw new Error(`Unexpected request: ${endpoint}`);
 });
 const view = await mount();
 view.getByText('Copy Play').click();
 await vi.waitFor(() => expect(view.getByText('1/1')).toBeTruthy(), { timeout: 3000 });
 expect(api.mock.calls.filter(([endpoint]) => endpoint === 'gridspace/play-import').map(([, params]) => params.action)).toEqual(['status', 'start', 'step']);
 expect(api.mock.calls.map(([endpoint]) => endpoint)).not.toContain('gridspace/settings-import');
});
