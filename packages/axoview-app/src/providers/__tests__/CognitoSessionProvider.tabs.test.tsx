import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';

// Another tab signs out: this one shows the sign-in screen. Another tab signs
// in: this one (on the sign-in screen) picks up the session.

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
jest.mock('../../stores/cognitoSessionStore', () => ({
  ...jest.requireActual('../../stores/cognitoSessionStore'),
  bootstrapCognitoSession: (...args: unknown[]) => mockBootstrap(...(args as []))
}));

import { useCognitoSessionStore } from '../../stores/cognitoSessionStore';
import { CognitoSessionProvider } from '../CognitoSessionProvider';

const signIn = () => useCognitoSessionStore.getState()._setSession({
  accessToken: 't', expiresIn: 3600, user: { sub: 'u1', email: 'a@example.com' } as never
});

beforeEach(() => {
  mockDriveSignOut.mockClear();
  mockBootstrap.mockReset();
  mockBootstrap.mockImplementation(async () => {});
});

it('another tab signed out: the editor gives way to the sign-in screen', async () => {
  signIn();
  render(<CognitoSessionProvider><div>editor</div></CognitoSessionProvider>);
  expect(await screen.findByText('editor')).toBeTruthy();
  await act(async () => { tabHandler!({ type: 'account-signed-out' }); });
  expect(await screen.findByText('Sign in to AxoView')).toBeTruthy();
  expect(screen.queryByText('editor')).toBeNull();
});

it('another tab signed in: a tab on the sign-in screen restores the session', async () => {
  useCognitoSessionStore.getState()._clear('signed-out');
  render(<CognitoSessionProvider><div>editor</div></CognitoSessionProvider>);
  expect(await screen.findByText('Sign in to AxoView')).toBeTruthy();
  mockBootstrap.mockClear();
  mockBootstrap.mockImplementation(async () => { signIn(); });
  await act(async () => { tabHandler!({ type: 'account-signed-in' }); });
  expect(mockBootstrap).toHaveBeenCalledWith(cognito);
  await waitFor(() => expect(screen.queryByText('editor')).toBeTruthy());
});

it('another tab signed in while this one already is: nothing to do', async () => {
  signIn();
  render(<CognitoSessionProvider><div>editor</div></CognitoSessionProvider>);
  await screen.findByText('editor');
  mockBootstrap.mockClear();
  await act(async () => { tabHandler!({ type: 'account-signed-in' }); });
  expect(mockBootstrap).not.toHaveBeenCalled();
});

it('another tab disconnected Google Drive: so does this one', async () => {
  signIn();
  render(<CognitoSessionProvider><div>editor</div></CognitoSessionProvider>);
  await screen.findByText('editor');
  await act(async () => { tabHandler!({ type: 'drive-signed-out' }); });
  expect(mockDriveSignOut).toHaveBeenCalledTimes(1);
});
