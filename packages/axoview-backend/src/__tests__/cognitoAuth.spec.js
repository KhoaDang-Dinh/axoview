import { generateKeyPairSync, sign } from 'crypto';
import { jest } from '@jest/globals';
import {
  clearCognitoJwksCacheForTests,
  verifyCognitoAccessToken
} from '../cognitoAuth.js';

const REGION = 'ap-southeast-1';
const POOL = 'ap-southeast-1_abc123';
const CLIENT = 'spa-client-id';
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`;
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', kty: 'RSA', use: 'sig', alg: 'RS256' };

function token(claimOverrides = {}, key = privateKey, kid = 'test-key') {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER,
    token_use: 'access',
    client_id: CLIENT,
    sub: 'user-sub-123',
    iat: 1_800_000_000,
    exp: 1_800_000_600,
    ...claimOverrides
  })).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), key).toString('base64url')}`;
}

function fetchJwks(keys = [jwk]) {
  return jest.fn(async () => ({
    ok: true,
    json: async () => ({ keys })
  }));
}

const options = (fetchImpl) => ({
  region: REGION,
  userPoolId: POOL,
  clientId: CLIENT,
  now: () => 1_800_000_100,
  fetchImpl
});

beforeEach(() => clearCognitoJwksCacheForTests());

describe('verifyCognitoAccessToken', () => {
  test('accepts a signed access token from the configured pool and client', async () => {
    const fetchImpl = fetchJwks();
    await expect(verifyCognitoAccessToken(token(), options(fetchImpl))).resolves.toEqual({
      sub: 'user-sub-123'
    });
    expect(fetchImpl).toHaveBeenCalledWith(`${ISSUER}/.well-known/jwks.json`, expect.any(Object));
  });

  test.each([
    ['wrong issuer', { iss: 'https://attacker.example' }],
    ['wrong client', { client_id: 'another-client' }],
    ['ID token', { token_use: 'id' }],
    ['expired token', { exp: 1_800_000_099 }],
    ['future token', { nbf: 1_800_000_101 }],
    ['invalid subject', { sub: '../other-user' }]
  ])('rejects %s', async (_label, claims) => {
    await expect(
      verifyCognitoAccessToken(token(claims), options(fetchJwks()))
    ).rejects.toThrow();
  });

  test('accepts any of several configured app clients (web and mobile), and only those', async () => {
    const both = { ...options(fetchJwks()), clientId: ['web-client', CLIENT] };
    await expect(verifyCognitoAccessToken(token(), both)).resolves.toEqual({ sub: 'user-sub-123' });
    await expect(
      verifyCognitoAccessToken(token({ client_id: 'third-client' }), both)
    ).rejects.toThrow('JWT client is invalid');
  });

  test('refuses to run with no app client configured', async () => {
    for (const clientId of [[], [''], null, undefined]) {
      await expect(
        verifyCognitoAccessToken(token(), { ...options(fetchJwks()), clientId })
      ).rejects.toThrow('Cognito auth is misconfigured');
    }
  });

  test('rejects a signature made by a different key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await expect(
      verifyCognitoAccessToken(token({}, other), options(fetchJwks()))
    ).rejects.toThrow('JWT signature is invalid');
  });

  test('refreshes the key set once when Cognito rotates to a new kid', async () => {
    const otherPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const otherJwk = {
      ...otherPair.publicKey.export({ format: 'jwk' }),
      kid: 'rotated-key',
      kty: 'RSA',
      use: 'sig',
      alg: 'RS256'
    };
    const signedWithRotatedKey = token({}, otherPair.privateKey, 'rotated-key');
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ keys: [jwk] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ keys: [otherJwk] }) });
    await expect(
      verifyCognitoAccessToken(signedWithRotatedKey, options(fetchImpl))
    ).resolves.toEqual({ sub: 'user-sub-123' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
