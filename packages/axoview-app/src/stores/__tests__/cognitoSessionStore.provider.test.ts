import { TextEncoder } from 'util';
import { webcrypto } from 'crypto';
import {
  beginCognitoSignIn,
  bootstrapCognitoSession,
  setCognitoNavigatorForTests,
  useCognitoSessionStore,
  type CognitoAuthConfig
} from '../cognitoSessionStore';

const config: CognitoAuthConfig = {
  domain: 'https://axoview-dev-1.auth.ap-southeast-1.amazoncognito.com',
  clientId: 'client',
  redirectUri: 'https://dev.example.com/app/auth/callback',
  logoutUri: 'https://dev.example.com/',
  providers: ['Google']
};

// PKCE needs TextEncoder and crypto.subtle, which jsdom does not provide.
Object.assign(globalThis, { TextEncoder });
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

describe('Cognito sign-in with an external provider', () => {
  let visited: string[];

  beforeEach(() => {
    visited = [];
    setCognitoNavigatorForTests((url) => visited.push(url));
    sessionStorage.clear();
    window.history.pushState({}, '', '/app');
    useCognitoSessionStore.getState()._clear('signed-out');
  });

  test('Continue with Google goes straight to Google through Cognito (PKCE kept)', async () => {
    await beginCognitoSignIn(config, 'Google');
    expect(visited).toHaveLength(1);
    const url = new URL(visited[0]);
    expect(url.origin + url.pathname).toBe(`${config.domain}/oauth2/authorize`);
    expect(url.searchParams.get('identity_provider')).toBe('Google');
    expect(url.searchParams.get('client_id')).toBe('client');
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
  });

  test('Continue with email shows the Cognito page (no identity_provider)', async () => {
    await beginCognitoSignIn(config);
    expect(new URL(visited[0]).searchParams.has('identity_provider')).toBe(false);
  });

  test('first sign-in after an account link is retried once, then reported', async () => {
    const linkError = '?error=invalid_request&error_description=Already+found+an+entry+for+username+google_1093';

    await beginCognitoSignIn(config, 'Google');
    window.history.pushState({}, '', `/app/auth/callback${linkError}`);
    await bootstrapCognitoSession(config);
    // Retried automatically, with Google again, and still loading.
    expect(visited).toHaveLength(2);
    expect(new URL(visited[1]).searchParams.get('identity_provider')).toBe('Google');
    expect(useCognitoSessionStore.getState().status).not.toBe('error');

    // The same error again is not retried a second time.
    window.history.pushState({}, '', `/app/auth/callback${linkError}`);
    await bootstrapCognitoSession(config);
    expect(visited).toHaveLength(2);
    expect(useCognitoSessionStore.getState().status).toBe('error');
    expect(useCognitoSessionStore.getState().error).toBe('Sign-in was cancelled or rejected');
  });

  test('other sign-in errors are not retried', async () => {
    await beginCognitoSignIn(config, 'Google');
    window.history.pushState({}, '', '/app/auth/callback?error=access_denied&error_description=User+cancelled');
    await bootstrapCognitoSession(config);
    expect(visited).toHaveLength(1);
    expect(useCognitoSessionStore.getState().status).toBe('error');
  });
});
