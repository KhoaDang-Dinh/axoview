import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { CognitoSessionProvider } from '../CognitoSessionProvider';

// A signed-out visitor on a Cognito deployment gets the sign-in screen instead
// of the editor. The boot splash (#ax-splash, fixed, z-index 9999) used to be
// cleared only by the editor shell, so it stayed on top of the sign-in screen
// and the page looked like an endless loading spinner.

// Stable like the real hooks: the provider's effect depends on both.
const mockLocation = { pathname: '/', key: 'default' };
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate
}));

const cognito = {
  domain: 'https://axoview-dev-1.auth.ap-southeast-1.amazoncognito.com',
  clientId: 'client',
  redirectUri: 'https://dev.example.com/app/auth/callback',
  logoutUri: 'https://dev.example.com/'
};
const storageValue = {
  isInitialized: true,
  runtimeConfig: { authMode: 'cognito', serverStorage: true, cognito }
};
jest.mock('../AppStorageContext', () => ({
  useAppStorage: () => storageValue
}));

describe('CognitoSessionProvider', () => {
  test('signed out on a Cognito deployment: shows sign-in and clears the boot splash', async () => {
    const splash = document.createElement('div');
    splash.id = 'ax-splash';
    document.body.appendChild(splash);

    const fetchedUrls: string[] = [];
    (global as any).fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes('/api/auth/refresh')) {
        // No refresh cookie yet: the server answers 401 and the app is signed out.
        return { ok: false, status: 401, json: async () => ({ error: 'Session expired' }) } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    render(
      <CognitoSessionProvider>
        <div>editor</div>
      </CognitoSessionProvider>
    );

    expect(await screen.findByText('Sign in to AxoView', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText('editor')).toBeNull();
    expect(fetchedUrls.some((url) => url.includes('/api/auth/refresh'))).toBe(true);
    await waitFor(() => expect(splash.classList.contains('ax-splash-hidden')).toBe(true), {
      timeout: 2000
    });
  });
});
