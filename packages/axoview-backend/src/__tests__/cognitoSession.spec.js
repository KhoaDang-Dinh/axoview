import { generateKeyPairSync, sign } from 'crypto';
import { jest } from '@jest/globals';
import {
  exchangeCognitoCode,
  refreshCognitoSession,
  revokeCognitoSession
} from '../cognitoSession.js';
import { clearCognitoJwksCacheForTests } from '../cognitoAuth.js';
import { makeCtx } from './helpers/memoryAdapter.js';

const region = 'ap-southeast-1';
const userPoolId = 'ap-southeast-1_abc123';
const clientId = 'spa-client-id';
const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'session-key', kty: 'RSA', alg: 'RS256' };

function accessToken() {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'session-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: issuer,
    token_use: 'access',
    client_id: clientId,
    sub: 'user-session-test',
    exp: Math.floor(Date.now() / 1000) + 600
  })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

const env = {
  COGNITO_REGION: region,
  COGNITO_USER_POOL_ID: userPoolId,
  COGNITO_CLIENT_ID: clientId,
  COGNITO_DOMAIN: 'https://axoview.auth.ap-southeast-1.amazoncognito.com',
  PUBLIC_BASE_URL: 'https://axoview.example.com/'
};

beforeEach(() => {
  clearCognitoJwksCacheForTests();
  process.env.NODE_ENV = 'production';
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.NODE_ENV;
});

describe('Cognito auth-code session endpoints', () => {
  test('exchanges a PKCE code against the configured callback and sets an HttpOnly refresh cookie', async () => {
    const access = accessToken();
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/oauth2/token')) {
        const form = new URLSearchParams(init.body);
        expect(form.get('redirect_uri')).toBe('https://axoview.example.com/app/auth/callback');
        expect(form.get('code_verifier')).toBe('a'.repeat(48));
        return new Response(JSON.stringify({ access_token: access, expires_in: 300, refresh_token: 'refresh-secret' }), { status: 200 });
      }
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    });
    const result = await exchangeCognitoCode(null, makeCtx({
      env,
      body: { code: 'authorization-code', codeVerifier: 'a'.repeat(48) }
    }));
    expect(result.status).toBe(200);
    expect(result.body.user.sub).toBe('user-session-test');
    expect(result.headers['Set-Cookie']).toContain('HttpOnly');
    expect(result.headers['Set-Cookie']).toContain('Secure');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('does not accept a callback body without a PKCE verifier', async () => {
    await expect(exchangeCognitoCode(null, makeCtx({ env, body: { code: 'code' } })))
      .rejects.toMatchObject({ status: 400 });
  });

  test('refresh requires the HttpOnly refresh token', async () => {
    await expect(refreshCognitoSession(null, makeCtx({ env })))
      .rejects.toMatchObject({ status: 401 });
  });

  test('logout clears the refresh cookie even if Cognito cannot be reached', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const result = await revokeCognitoSession(null, makeCtx({ env, refreshToken: 'refresh-secret' }));
    expect(result.status).toBe(204);
    expect(result.headers['Set-Cookie']).toContain('Max-Age=0');
    expect(result.headers['Set-Cookie']).toContain('Secure');
  });
});
