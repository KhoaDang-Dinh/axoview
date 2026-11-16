import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

// Signed out on a diagram link (/app/d/<id>?page=<view>): after sign-in the
// user lands back on that diagram, not on an empty /app.

let mockLocation = { pathname: '/', search: '', key: 'default' };
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate
}));

let mockSession: { status: string; user: unknown; error: string | null } = { status: 'signed-out', user: null, error: null };
jest.mock('../../stores/cognitoSessionStore', () => {
  const useStore = (selector: (s: unknown) => unknown) => selector(mockSession);
  useStore.getState = () => mockSession;
  return {
    useCognitoSessionStore: useStore,
    bootstrapCognitoSession: async () => {},
    beginCognitoSignIn: jest.fn()
  };
});
jest.mock('../AppStorageContext', () => ({
  useAppStorage: () => ({
    isInitialized: true,
    runtimeConfig: { authMode: 'cognito', serverStorage: true, cognito: { domain: 'd', clientId: 'c', redirectUri: 'r', logoutUri: 'l' } }
  })
}));

import { CognitoSessionProvider, rememberSignInReturn, takeSignInReturn } from '../CognitoSessionProvider';

beforeEach(() => {
  sessionStorage.clear();
  mockNavigate.mockClear();
  mockSession = { status: 'signed-out', user: null, error: null };
  mockLocation = { pathname: '/', search: '', key: 'default' };
  window.history.pushState({}, '', '/app');
});

describe('the return path', () => {
  it('keeps a diagram link, with or without its page', () => {
    rememberSignInReturn('/d/diagram_mw3azeie_ngmtunnn?page=page-two');
    expect(takeSignInReturn()).toBe('/d/diagram_mw3azeie_ngmtunnn?page=page-two');
    rememberSignInReturn('/d/abc');
    expect(takeSignInReturn()).toBe('/d/abc');
    rememberSignInReturn('/d/abc?page=page%20one%2F%C3%A4');
    expect(takeSignInReturn()).toBe('/d/abc?page=page%20one%2F%C3%A4');
  });

  it("keeps an agent's consent page (ADR 0059), and only with a well-formed request id", () => {
    rememberSignInReturn('/oauth/consent?request=abcdefghijklmnopqrstuvwx');
    expect(takeSignInReturn()).toBe('/oauth/consent?request=abcdefghijklmnopqrstuvwx');
    for (const path of ['/oauth/consent?request=short', '/oauth/consent?request=abcdefghijklmnopqrstuvwx&next=//evil.example', '/oauth/consent']) {
      rememberSignInReturn(path);
      expect(takeSignInReturn()).toBe('/');
    }
  });

  it('is used once', () => {
    rememberSignInReturn('/d/abc');
    expect(takeSignInReturn()).toBe('/d/abc');
    expect(takeSignInReturn()).toBe('/');
  });

  it('never keeps anything but a diagram link or a consent page, so it cannot send the user elsewhere', () => {
    for (const path of [
      '//evil.example/d/abc', 'https://evil.example/', '/d/abc/../../admin', '/display/abc',
      '/d/abc?page=x&next=https://evil.example', '/d/' + 'a'.repeat(65), '/', '/ai/connect/x'
    ]) {
      rememberSignInReturn(path);
      expect(takeSignInReturn()).toBe('/');
    }
  });

  it('a tampered stored value is ignored', () => {
    sessionStorage.setItem('axoview-sign-in-return', 'https://evil.example/');
    expect(takeSignInReturn()).toBe('/');
  });
});

describe('CognitoSessionProvider', () => {
  it('signed out on a diagram link: remembers it while showing sign-in', async () => {
    mockLocation = { pathname: '/d/abc', search: '?page=details', key: 'k' };
    render(<CognitoSessionProvider><div>editor</div></CognitoSessionProvider>);
    expect(await screen.findByText('Sign in to AxoView')).toBeTruthy();
    expect(sessionStorage.getItem('axoview-sign-in-return')).toBe('/d/abc?page=details');
  });

  it('back from sign-in: returns to the remembered diagram', async () => {
    sessionStorage.setItem('axoview-sign-in-return', '/d/abc?page=details');
    mockSession = { status: 'signed-in', user: { sub: 'u1' }, error: null };
    mockLocation = { pathname: '/auth/callback', search: '', key: 'cb' };
    window.history.pushState({}, '', '/app/auth/callback');
    render(<CognitoSessionProvider><div>editor</div></CognitoSessionProvider>);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/d/abc?page=details', { replace: true }));
    expect(sessionStorage.getItem('axoview-sign-in-return')).toBeNull();
  });

  it('back from sign-in with nothing remembered: /app, as before', async () => {
    mockSession = { status: 'signed-in', user: { sub: 'u1' }, error: null };
    mockLocation = { pathname: '/auth/callback', search: '', key: 'cb' };
    window.history.pushState({}, '', '/app/auth/callback');
    render(<CognitoSessionProvider><div>editor</div></CognitoSessionProvider>);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true }));
  });
});
