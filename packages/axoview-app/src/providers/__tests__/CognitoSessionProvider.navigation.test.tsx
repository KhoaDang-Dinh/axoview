/**
 * Regression (dev, 2026-11-09: "page id keeps changing and blinks", Cognito
 * deployments only): the provider restored the session on EVERY navigation
 * (location.key), swapping the whole app for a spinner each time. The editor
 * unmounted, reloaded the diagram, wrote ?page= back to the URL (another
 * navigation), and blinked again. Now the session is restored once per page
 * load, and again only when the tab arrives at /auth/callback.
 */
import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';

let mockLocation = { pathname: '/d/abc', search: '', key: 'k0' };
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate
}));
jest.mock('../../services/sync/tabChannel', () => ({ postToTabs: jest.fn(), onTabMessage: () => () => {} }));
jest.mock('../../stores/authStore', () => ({ signOutDriveFromOtherTab: () => {} }));
const mockStorageValue = {
  isInitialized: true,
  runtimeConfig: { authMode: 'cognito', serverStorage: true, cognito: { domain: 'd', clientId: 'c', redirectUri: 'r', logoutUri: 'l' } }
};
jest.mock('../AppStorageContext', () => ({ useAppStorage: () => mockStorageValue }));
const mockBootstrap = jest.fn(async () => {});
jest.mock('../../stores/cognitoSessionStore', () => ({
  ...jest.requireActual('../../stores/cognitoSessionStore'),
  bootstrapCognitoSession: (...args: unknown[]) => mockBootstrap(...(args as []))
}));

import { useCognitoSessionStore } from '../../stores/cognitoSessionStore';
import { CognitoSessionProvider } from '../CognitoSessionProvider';

let mounts = 0;
function Editor() {
  useEffect(() => { mounts += 1; }, []);
  return <div>editor</div>;
}

beforeEach(() => {
  mounts = 0;
  mockBootstrap.mockReset();
  mockBootstrap.mockImplementation(async () => {
    useCognitoSessionStore.getState()._setSession({ accessToken: 't', expiresIn: 3600, user: { sub: 'u1' } as never });
  });
  mockLocation = { pathname: '/d/abc', search: '', key: 'k0' };
});

it('navigating inside the app keeps the editor mounted and does not restore the session again', async () => {
  const { rerender } = render(<CognitoSessionProvider><Editor /></CognitoSessionProvider>);
  expect(await screen.findByText('editor')).toBeTruthy();
  expect(mockBootstrap).toHaveBeenCalledTimes(1);

  // A page switch (?page=), another diagram, back home: three navigations.
  for (const [pathname, search, key] of [['/d/abc', '?page=p2', 'k1'], ['/d/xyz', '', 'k2'], ['/', '', 'k3']]) {
    mockLocation = { pathname, search, key };
    await act(async () => { rerender(<CognitoSessionProvider><Editor /></CognitoSessionProvider>); });
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('editor')).toBeTruthy();
  }
  expect(mounts).toBe(1);
  expect(mockBootstrap).toHaveBeenCalledTimes(1);
});

it('arriving at /auth/callback restores the session again, without hiding the app', async () => {
  const { rerender } = render(<CognitoSessionProvider><Editor /></CognitoSessionProvider>);
  await screen.findByText('editor');
  mockLocation = { pathname: '/auth/callback', search: '?code=c&state=s', key: 'k1' };
  await act(async () => { rerender(<CognitoSessionProvider><Editor /></CognitoSessionProvider>); });
  expect(mockBootstrap).toHaveBeenCalledTimes(2);
  expect(mounts).toBe(1);
});
