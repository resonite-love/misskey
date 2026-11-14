/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { nextTick } from 'vue';
import OAuth from '@/pages/oauth.vue';
const { profile, request, user } = vi.hoisted(() => ({
 profile: { preferences: {} as Record<string, unknown> }, request: vi.fn(), user: { id: 'selected', username: 'selected', token: 'fixture-token' },
}));
vi.mock('@/preferences.js', () => ({ prefer: { profile } }));
vi.mock('@/i.js', () => ({ $i: user }));
vi.mock('@/accounts.js', () => ({ getAccounts: async () => [], getAccountWithSigninDialog: vi.fn(), getAccountWithSignupDialog: vi.fn() }));
vi.mock('@/os.js', () => ({}));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/utility/media-proxy.js', () => ({ getProxiedImageUrl: (x:string) => x }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: request }));
vi.mock('@/store.js', () => ({ store: { s: { visibility: 'followers', localOnly: true, memo: null, memo2: null } } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { pleaseSelectAccount: 'Choose', selectAccount: 'Account', continue: 'Continue', accept: 'Allow', reject: 'Deny', switchAccount: 'Switch', retry: 'Retry', somethingHappened: 'Failed', _auth: { scopeUser: 'Account', shareAccessAsk: 'Consent' }, _gridspace: { oauthPaletteFailed: 'Palette unavailable', oauthSettingsFailed: 'Settings unavailable' }, _permissions: {} }, tsx: { _auth: { shareAccess: () => '', permission: () => '' } } } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<div><slot/></div>' } }));

async function flushPromises() { await new Promise(resolve => setTimeout(resolve, 0)); await nextTick(); }

beforeEach(() => {
 request.mockReset().mockResolvedValue({});
 profile.preferences = { emojiPalettes: [[{}, [], { sync: true }]], emojiPaletteForMain: [[{}, null, {}]], emojiPaletteForReaction: [[{}, null, {}]], dataSaver: [[{}, { media: true, avatar: false, urlPreviewThumbnail: false, disableUrlPreview: false }, {}]], 'deck.profiles': [[{}, [{ columns: [], layout: [] }], {}]] };
 for (const [name, content] of [['gridspace-palette', 'true'], ['transaction-id', 'fixture-transaction']]) {const meta = document.createElement('meta'); meta.name = 'misskey:oauth:' + name; meta.content = content; document.head.appendChild(meta);}
});
afterEach(() => {cleanup(); document.querySelectorAll('form,meta[name^="misskey:oauth:"]').forEach(x => x.remove()); vi.restoreAllMocks();});

function renderConsent() {const wrapper = render(OAuth, { global: { stubs: { PageWithAnimBg: { template: '<div><slot/></div>' }, MkAvatar: true, MkUserName: true, MkAcct: true, MkLoading: true, Transition: true } } }); return wrapper;}

async function allow(wrapper: ReturnType<typeof render>) {
 await flushPromises(); await fireEvent.click(wrapper.container.querySelector('input[name="accountSelector"]')!);
 await fireEvent.click(wrapper.getByText('Continue')); await flushPromises();
 await fireEvent.click(wrapper.getByText('Allow')); await flushPromises();
}

test('submits authorization with legacy settings and reports only the skipped optional field', async() => {
 const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
 const wrapper = renderConsent(); await allow(wrapper);
 expect(submit).toHaveBeenCalledTimes(1);
 const form = document.querySelector('form')!;
 const snapshot = JSON.parse((form.querySelector('[name="gridspace_settings"]') as HTMLInputElement).value);
 expect(snapshot.values.dataSaver.code).toBe(false); expect(snapshot.skipped).toEqual(['deck.profiles']);
 expect(snapshot.visibility).toBe('followers'); expect(request).toHaveBeenCalledTimes(1);
});
test('shows the failing step and permits a fresh retry after a temporary cloud failure', async() => {
 request.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
 const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
 const wrapper = renderConsent(); await allow(wrapper);
 expect(wrapper.container.textContent).toContain('Palette unavailable'); expect(submit).not.toHaveBeenCalled();
 await fireEvent.click(wrapper.getByText('Retry'));
 await allow(wrapper); expect(submit).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(2);
});
