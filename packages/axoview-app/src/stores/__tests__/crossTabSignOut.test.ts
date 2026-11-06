/**
 * Signing out in one tab signs out every tab of the browser: the Axoview
 * account (Cognito) and the Google Drive connection. Each tab saves pending
 * edits first.
 */
const posted: unknown[] = [];
jest.mock('../../services/sync/tabChannel', () => ({
  postToTabs: (message: unknown) => { posted.push(message); },
  onTabMessage: () => () => {}
}));

import { signOutCognito, signOutFromOtherTab, useCognitoSessionStore } from '../cognitoSessionStore';
import { signOutDriveFromOtherTab, useAuthStore } from '../authStore';
import { registerBeforeSignOut } from '../../services/session/beforeSignOut';

const signedIn = () => useCognitoSessionStore.getState()._setSession({
  accessToken: 'token', expiresIn: 3600, user: { sub: 'u1', email: 'a@example.com' } as never
});

beforeEach(() => {
  posted.length = 0;
  useCognitoSessionStore.getState()._clear('signed-out');
});

describe('the Axoview account', () => {
  it('signing out saves pending edits first, then logs out, then tells the other tabs', async () => {
    signedIn();
    const order: string[] = [];
    const off = registerBeforeSignOut(async () => { order.push('save'); });
    (global as { fetch?: unknown }).fetch = jest.fn(async (url: string) => { order.push(`fetch ${url}`); return { ok: true } as Response; });
    await signOutCognito();
    off();
    expect(order[0]).toBe('save');
    expect(order[1]).toMatch(/\/api\/auth\/logout$/);
    expect(useCognitoSessionStore.getState().status).toBe('signed-out');
    expect(posted).toEqual([{ type: 'account-signed-out' }]);
  });

  it('the other tabs are told even when the logout request fails', async () => {
    signedIn();
    (global as { fetch?: unknown }).fetch = jest.fn(async () => { throw new TypeError('offline'); });
    await expect(signOutCognito()).rejects.toThrow('offline');
    expect(useCognitoSessionStore.getState().status).toBe('signed-out');
    expect(posted).toEqual([{ type: 'account-signed-out' }]);
  });

  it('told by another tab: saves, drops the session, calls nothing, tells no one', async () => {
    signedIn();
    let saved = false;
    const off = registerBeforeSignOut(async () => { saved = true; });
    const fetchSpy = jest.fn();
    (global as { fetch?: unknown }).fetch = fetchSpy;
    await signOutFromOtherTab();
    off();
    expect(saved).toBe(true);
    expect(useCognitoSessionStore.getState()).toMatchObject({ status: 'signed-out', accessToken: null, user: null });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it('told by another tab while already signed out: nothing to do', async () => {
    let saved = false;
    const off = registerBeforeSignOut(async () => { saved = true; });
    await signOutFromOtherTab();
    off();
    expect(saved).toBe(false);
  });
});

describe('the Google Drive connection', () => {
  const connected = () => {
    const revoke = jest.fn();
    useAuthStore.getState()._setBridge({ requestToken: jest.fn(), revoke });
    useAuthStore.setState({ status: 'AUTHENTICATED', accessToken: 'drive-token', user: { email: 'a@example.com' } as never });
    return revoke;
  };

  it('signing out tells the other tabs', () => {
    connected();
    useAuthStore.getState().signOut();
    expect(useAuthStore.getState().status).toBe('UNAUTHENTICATED');
    expect(posted).toEqual([{ type: 'drive-signed-out' }]);
  });

  it('told by another tab: this tab drops its token too, without echoing the message', () => {
    const revoke = connected();
    signOutDriveFromOtherTab();
    expect(useAuthStore.getState()).toMatchObject({ status: 'UNAUTHENTICATED', accessToken: null });
    expect(revoke).toHaveBeenCalledWith('drive-token');
    expect(posted).toEqual([]);
    // A later sign-out of this tab's own is announced again.
    connected();
    useAuthStore.getState().signOut();
    expect(posted).toEqual([{ type: 'drive-signed-out' }]);
  });

  it('told by another tab while not connected: nothing to do', () => {
    useAuthStore.setState({ status: 'UNAUTHENTICATED', accessToken: null });
    signOutDriveFromOtherTab();
    expect(posted).toEqual([]);
  });
});
