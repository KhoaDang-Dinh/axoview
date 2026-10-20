import React from 'react';
import { render, screen } from '@testing-library/react';
import { CognitoSessionProvider } from '../CognitoSessionProvider';

// One "Continue with <provider>" button per external provider in
// /api/config's cognito.providers, above "Continue with email".

// Stable like the real hooks: the provider's effect depends on both.
const mockLocation = { pathname: '/', key: 'default' };
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate
}));

const storageValue: { isInitialized: boolean; runtimeConfig: Record<string, unknown> } = {
  isInitialized: true,
  runtimeConfig: {}
};
jest.mock('../AppStorageContext', () => ({
  useAppStorage: () => storageValue
}));

function cognitoConfig(providers?: string[]) {
  return {
    authMode: 'cognito',
    serverStorage: true,
    cognito: {
      domain: 'https://axoview-dev-1.auth.ap-southeast-1.amazoncognito.com',
      clientId: 'client',
      redirectUri: 'https://dev.example.com/app/auth/callback',
      logoutUri: 'https://dev.example.com/',
      ...(providers ? { providers } : {})
    }
  };
}

beforeEach(() => {
  (global as any).fetch = async () =>
    ({ ok: false, status: 401, json: async () => ({ error: 'Session expired' }) }) as Response;
});

test('shows Continue with Google when Google is configured', async () => {
  storageValue.runtimeConfig = cognitoConfig(['Google']);
  render(<CognitoSessionProvider><div>editor</div></CognitoSessionProvider>);
  expect(await screen.findByText('Continue with Google')).toBeTruthy();
  expect(screen.getByText('Continue with email')).toBeTruthy();
});

test('shows only email sign-in without external providers', async () => {
  storageValue.runtimeConfig = cognitoConfig();
  render(<CognitoSessionProvider><div>editor</div></CognitoSessionProvider>);
  expect(await screen.findByText('Continue with email')).toBeTruthy();
  expect(screen.queryByText('Continue with Google')).toBeNull();
});
