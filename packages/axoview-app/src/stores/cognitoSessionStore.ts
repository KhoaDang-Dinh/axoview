import { create } from 'zustand';
import { apiBaseUrl } from '../utils/apiBaseUrl';

export interface CognitoAuthConfig {
  domain: string;
  clientId: string;
  redirectUri: string;
  logoutUri: string;
  /** External sign-in providers on the app client, e.g. ['Google'] (email is always available). */
  providers?: string[];
}

export interface CognitoUser {
  sub: string;
  username?: string;
}

type SessionStatus = 'booting' | 'signed-out' | 'signed-in' | 'error';

interface SessionState {
  status: SessionStatus;
  user: CognitoUser | null;
  accessToken: string | null;
  expiresAt: number;
  error: string | null;
  _setSession: (value: { accessToken: string; expiresIn: number; user: CognitoUser }) => void;
  _clear: (status?: SessionStatus, error?: string | null) => void;
}

const useCognitoSessionStore = create<SessionState>((set) => ({
  status: 'booting',
  user: null,
  accessToken: null,
  expiresAt: 0,
  error: null,
  _setSession: ({ accessToken, expiresIn, user }) => set({
    status: 'signed-in', user, accessToken, expiresAt: Date.now() + expiresIn * 1000, error: null
  }),
  _clear: (status = 'signed-out', error = null) => set({
    status, user: null, accessToken: null, expiresAt: 0, error
  })
}));

export { useCognitoSessionStore };

const STATE_KEY = 'axoview.cognito.state';
const VERIFIER_KEY = 'axoview.cognito.verifier';
// The external provider of the sign-in in flight, and whether the one automatic
// retry after an account link was used (see bootstrapCognitoSession).
const PROVIDER_KEY = 'axoview.cognito.provider';
const LINK_RETRY_KEY = 'axoview.cognito.linkRetry';
// Cognito refuses the first sign-in right after the pre sign-up trigger links
// an external identity to an existing account; the same sign-in then succeeds.
const LINKED_ACCOUNT_ERROR = /already found an entry for username/i;

let assignLocation = (url: string): void => window.location.assign(url);
/** Test seam: jsdom cannot navigate, so tests capture the authorize URL instead. */
export function setCognitoNavigatorForTests(fn: (url: string) => void): void {
  assignLocation = fn;
}
let activeConfig: CognitoAuthConfig | null = null;
let refreshPromise: Promise<string | null> | null = null;

function randomBase64Url(size = 32): string {
  const bytes = new Uint8Array(size);
  window.crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach((value) => { binary += String.fromCharCode(value); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function pkceChallenge(verifier: string): Promise<string> {
  const bytes = new TextEncoder().encode(verifier);
  const digest = await window.crypto.subtle.digest('SHA-256', bytes);
  let binary = '';
  new Uint8Array(digest).forEach((value) => { binary += String.fromCharCode(value); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function rememberResult(result: { accessToken: string; expiresIn: number; user: CognitoUser }): void {
  if (!result || typeof result.accessToken !== 'string' || typeof result.user?.sub !== 'string') {
    throw new Error('The sign-in response was incomplete');
  }
  useCognitoSessionStore.getState()._setSession(result);
}

async function refreshSession(): Promise<string | null> {
  if (!activeConfig) return null;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const response = await fetch(`${apiBaseUrl()}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (!response.ok) {
        useCognitoSessionStore.getState()._clear('signed-out');
        return null;
      }
      const body = await response.json();
      rememberResult({ accessToken: body.accessToken, expiresIn: body.expiresIn, user: body.user });
      return body.accessToken;
    } catch (error) {
      useCognitoSessionStore.getState()._clear('error', 'Could not refresh the sign-in session');
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export async function getCognitoAccessToken(): Promise<string | null> {
  const state = useCognitoSessionStore.getState();
  if (state.accessToken && state.expiresAt > Date.now() + 60_000) return state.accessToken;
  return refreshSession();
}

/**
 * Start the Cognito authorization-code + PKCE flow. With `provider` (e.g.
 * 'Google') Cognito sends the browser straight to that provider instead of its
 * own sign-in page.
 */
export async function beginCognitoSignIn(config = activeConfig, provider?: string): Promise<void> {
  if (!config) throw new Error('Cognito sign-in is not configured');
  activeConfig = config;
  const state = randomBase64Url(32);
  const verifier = randomBase64Url(64);
  const challenge = await pkceChallenge(verifier);
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  if (provider) sessionStorage.setItem(PROVIDER_KEY, provider);
  else sessionStorage.removeItem(PROVIDER_KEY);
  const authorize = new URL('/oauth2/authorize', config.domain);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(provider ? { identity_provider: provider } : {})
  }).toString();
  assignLocation(authorize.toString());
}

export async function bootstrapCognitoSession(config: CognitoAuthConfig): Promise<void> {
  activeConfig = config;
  const currentUrl = new URL(window.location.href);
  const code = currentUrl.searchParams.get('code');
  const returnedState = currentUrl.searchParams.get('state');
  if (currentUrl.pathname.endsWith('/auth/callback') && (code || currentUrl.searchParams.has('error'))) {
    const expectedState = sessionStorage.getItem(STATE_KEY);
    const verifier = sessionStorage.getItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);
    const provider = sessionStorage.getItem(PROVIDER_KEY);
    sessionStorage.removeItem(PROVIDER_KEY);
    if (currentUrl.searchParams.has('error')) {
      const description = currentUrl.searchParams.get('error_description') || '';
      if (provider && LINKED_ACCOUNT_ERROR.test(description) && !sessionStorage.getItem(LINK_RETRY_KEY)) {
        // First sign-in after linking this provider to an existing account:
        // retry once, which Cognito then accepts. Status stays 'booting'
        // (spinner) while the browser goes back to the provider.
        sessionStorage.setItem(LINK_RETRY_KEY, '1');
        await beginCognitoSignIn(config, provider);
        return;
      }
      sessionStorage.removeItem(LINK_RETRY_KEY);
      useCognitoSessionStore.getState()._clear('error', 'Sign-in was cancelled or rejected');
      return;
    }
    sessionStorage.removeItem(LINK_RETRY_KEY);
    if (!code || !verifier || !expectedState || returnedState !== expectedState) {
      useCognitoSessionStore.getState()._clear('error', 'The sign-in response could not be verified');
      return;
    }
    try {
      const response = await fetch(`${apiBaseUrl()}/api/auth/callback`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, codeVerifier: verifier })
      });
      if (!response.ok) throw new Error('Sign-in failed');
      rememberResult(await response.json());
      window.history.replaceState({}, document.title, currentUrl.pathname);
    } catch {
      useCognitoSessionStore.getState()._clear('error', 'Could not finish signing in');
    }
    return;
  }
  await refreshSession();
  if (useCognitoSessionStore.getState().status === 'booting') {
    useCognitoSessionStore.getState()._clear('signed-out');
  }
}

export async function signOutCognito(): Promise<void> {
  try {
    await fetch(`${apiBaseUrl()}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
  } finally {
    sessionStorage.removeItem(STATE_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);
    sessionStorage.removeItem(PROVIDER_KEY);
    sessionStorage.removeItem(LINK_RETRY_KEY);
    useCognitoSessionStore.getState()._clear('signed-out');
  }
}
