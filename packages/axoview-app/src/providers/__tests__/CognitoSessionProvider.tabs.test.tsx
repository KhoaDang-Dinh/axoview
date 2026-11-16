import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';

// Other tabs of this browser (owner decision, 2026-11-10): one signs in, the
// tabs on the sign-in screen take the session and go to /app; one signs out
// or finds the session expired, every app tab goes to the landing page.

// Stable, like the real hooks: the provider's bootstrap effect depends on both.
const mockLocation = { pathname: '/d/abc', search: '', key: 'k' };
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate
}));

let tabHandler: ((message: { type: string }) => void) | null = null;
jest.mock('../../services/sync/tabChannel', () => ({
  postToTabs: jest.fn(),
  onTabMessage: (handler: (message: { type: string }) => void) => { tabHandler = handler; return () => { tabHandler = null; }; }
}));
const mockDriveSignOut = jest.fn();
jest.mock('../../stores/authStore', () => ({ signOutDriveFromOtherTab: () => mockDriveSignOut() }));

// Stable, like the real context: the provider's bootstrap effect depends on it.
const mockStorageValue = {
  isInitialized: true,
  runtimeConfig: { authMode: 'cognito', serverStorage: true, cognito: { domain: 'd', clientId: 'c', redirectUri: 'r', logoutUri: 'l' } }
};
const cognito = mockStorageValue.runtimeConfig.cognito;
jest.mock('../AppStorageContext', () => ({
  useAppStorage: () => mockStorageValue
}));

const mockBootstrap = jest.fn(async () => {});
const mockWipe = jest.fn(async () => {});
jest.mock('../../stores/draftStore', () => ({ wipeAllDrafts: () => mockWipe() }));
jest.mock('../../stores/cognitoSessionStore', () => ({
  ...jest.requireActual('../../stores/cognitoSessionStore'),
  bootstrapCognitoSession: (...args: unknown[]) => mockBootstrap(...(args as []))
}));

import { setCognitoNavigatorForTests, useCognitoSessionStore } from '../../stores/cognitoSessionStore';
import { CognitoSessionProvider } from '../CognitoSessionProvider';

const signIn = () => useCognitoSessionStore.getState()._setSession({
  accessToken: 't', expiresIn: 3600, user: { sub: 'u1', email: 'a@example.com' } as never
});

let visited: string[] = [];
beforeEach(() => {
  visited = [];
  setCognitoNavigatorForTests((url) => visited.push(url));
  mockNavigate.mockClear();
  mockWipe.mockClear();
  mockDriveSignOut.mockClear();
  mockBootstrap.mockReset();
  mockBootstrap.mockImplementation(async () => {});
});

it('another tab signed out: the editor closes, drafts are wiped, and the tab goes to the landing page', async () => {
  signIn();
  render(<CognitoSessionProvider><div>editor</div></CognitoSessionProvider>);
  expect(await screen.findByText('editor')).toBeTruthy();
  await act(async () => { tabHandler!({ type: 'account-signed-out' }); });
  await waitFor(() => expect(visited).toEqual(['/']));
  expect(mockWipe).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('editor')).toBeNull();
});

it('another tab signed out: a tab already on the sign-in screen goes to the landing page too', async () => {
  useCognitoSessionStore.getState()._clear('signed-out');
  render(<CognitoSessionProvider><div>editor</div></CognitoSessionProvider>);
  await screen.findByText('Sign in to AxoView');
  await act(async () => { tabHandler!({ type: 'account-signed-out' }); });
  await waitFor(() => expect(visited).toEqual(['/']));
});

it('the session expired in another tab: this one goes to the landing page, drafts kept', async () => {
  signIn();
  render(<CognitoSessionProvider><div>editor</div></CognitoSessionProvider>);
  await screen.findByText('editor');
  await act(async () => { tabHandler!({ type: 'account-session-ended' }); });
  expect(visited).toEqual(['/']);
  expect(mockWipe).not.toHaveBeenCalled();
  expect(useCognitoSessionStore.getState().status).toBe('signed-out');
});

it('another tab signed in: a tab on the sign-in screen takes the session and goes to /app', async () => {
  useCognitoSessionStore.getState()._clear('signed-out');
  sessionStorage.setItem('axoview-sign-in-return', '/d/abc');
  render(<CognitoSessionProvider><div>editor</div></CognitoSessionProvider>);
  expect(await screen.findByText('Sign in to AxoView')).toBeTruthy();
  mockBootstrap.mockClear();
  mockBootstrap.mockImplementation(async () => { signIn(); });
  await act(async () => { tabHandler!({ type: 'account-signed-in' }); });
  expect(mockBootstrap).toHaveBeenCalledWith(cognito);
  await waitFor(() => expect(screen.queryByText('editor')).toBeTruthy());
  // The router's basename is /app, so '/' is the app's home.
  expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
  expect(sessionStorage.getItem('axoview-sign-in-return')).toBeNull();
  expect(visited).toEqual([]);
});

it('another tab signed in, but this tab could not get the session: it stays where it is', async () => {
  useCognitoSessionStore.getState()._clear('signed-out');
  render(<CognitoSessionProvider><div>editor</div></CognitoSessionProvider>);
  await screen.findByText('Sign in to AxoView');
  mockBootstrap.mockClear();
  await act(async () => { tabHandler!({ type: 'account-signed-in' }); });
  expect(mockBootstrap).toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
});

it('another tab signed in while this one already is: nothing to do', async () => {
  signIn();
  render(<CognitoSessionProvider><div>editor</div></CognitoSessionProvider>);
  await screen.findByText('editor');
  mockBootstrap.mockClear();
  await act(async () => { tabHandler!({ type: 'account-signed-in' }); });
  expect(mockBootstrap).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
});

it('another tab disconnected Google Drive: so does this one', async () => {
  signIn();
  render(<CognitoSessionProvider><div>editor</div></CognitoSessionProvider>);
  await screen.findByText('editor');
  await act(async () => { tabHandler!({ type: 'drive-signed-out' }); });
  expect(mockDriveSignOut).toHaveBeenCalledTimes(1);
});
