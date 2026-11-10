/**
 * Where a tab goes when the session ends (owner decision, 2026-11-10): signing
 * out, or the session expiring, sends every app tab to the landing page; a
 * sign-in service outage does not.
 */
const mockPostToTabs = jest.fn();
jest.mock('../../services/sync/tabChannel', () => ({ postToTabs: (...args: unknown[]) => mockPostToTabs(...args) }));
let releaseWipe: () => void = () => {};
const mockWipe = jest.fn(() => new Promise<void>((resolve) => { releaseWipe = resolve; }));
jest.mock('../draftStore', () => ({ wipeAllDrafts: () => mockWipe() }));

import {
  bootstrapCognitoSession,
  getCognitoAccessToken,
  setCognitoNavigatorForTests,
  signOutCognito,
  useCognitoSessionStore,
  type CognitoAuthConfig
} from '../cognitoSessionStore';

const config: CognitoAuthConfig = {
  domain: 'https://axoview-dev-1.auth.ap-southeast-1.amazoncognito.com',
  clientId: 'client',
  redirectUri: 'https://dev.example.com/app/auth/callback',
  logoutUri: 'https://dev.example.com/'
};
const SESSION = { accessToken: 't', expiresIn: 3600, user: { sub: 'u1', email: 'a@example.com' } };

const reply = (status: number, body: unknown = {}) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

let visited: string[];
let fetchMock: jest.Mock;
beforeEach(() => {
  visited = [];
  setCognitoNavigatorForTests((url) => visited.push(url));
  mockPostToTabs.mockClear();
  mockWipe.mockClear();
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  window.history.pushState({}, '', '/app/d/abc');
  useCognitoSessionStore.getState()._clear('booting' as never);
});

/** Signed in through a bootstrap (it also arms the refresh), with a token that needs refreshing. */
async function signedInNeedingRefresh(): Promise<void> {
  fetchMock.mockImplementationOnce(() => reply(200, SESSION));
  await bootstrapCognitoSession(config);
  expect(useCognitoSessionStore.getState().status).toBe('signed-in');
  useCognitoSessionStore.setState({ expiresAt: Date.now() });
}

test('signing out: drafts are wiped first, then this tab goes to the landing page', async () => {
  await signedInNeedingRefresh();
  fetchMock.mockImplementationOnce(() => reply(204));
  const done = signOutCognito();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mockPostToTabs).toHaveBeenCalledWith({ type: 'account-signed-out' });
  expect(visited).toEqual([]); // still wiping
  releaseWipe();
  await done;
  expect(visited).toEqual(['/']);
});

test('the session expired (refresh refused, 401): every tab is told and this one goes to the landing page', async () => {
  await signedInNeedingRefresh();
  fetchMock.mockImplementationOnce(() => reply(401, { error: 'Session expired' }));
  expect(await getCognitoAccessToken()).toBeNull();
  expect(useCognitoSessionStore.getState().status).toBe('signed-out');
  expect(mockPostToTabs).toHaveBeenCalledWith({ type: 'account-session-ended' });
  expect(visited).toEqual(['/']);
  // The drafts stay for the same person's next sign-in.
  expect(mockWipe).not.toHaveBeenCalled();
});

test('the sign-in service is down (502): no one is sent anywhere', async () => {
  await signedInNeedingRefresh();
  fetchMock.mockImplementationOnce(() => reply(502, { error: 'Sign-in service unavailable' }));
  expect(await getCognitoAccessToken()).toBeNull();
  expect(useCognitoSessionStore.getState().status).toBe('error');
  expect(mockPostToTabs).not.toHaveBeenCalled();
  expect(visited).toEqual([]);
});

test('a visitor who was never signed in stays on the sign-in screen', async () => {
  fetchMock.mockImplementationOnce(() => reply(401, { error: 'Session expired' }));
  await bootstrapCognitoSession(config);
  expect(useCognitoSessionStore.getState().status).toBe('signed-out');
  expect(mockPostToTabs).not.toHaveBeenCalled();
  expect(visited).toEqual([]);
});
