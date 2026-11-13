/**
 * A client that signs its token requests (ChatGPT, private_key_jwt) signs in
 * through the real OAuth router: authorize, consent, code, refresh, revoke.
 * Only the network is replaced: the client's metadata document and its JWKS
 * are served from memory. A public client (Claude) is unaffected.
 */
import crypto from 'crypto';
import express from 'express';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { createOAuthRouter } from '../router.js';
import { createOAuthStore } from '../store.js';
import { createClientResolver } from '../clientMetadata.js';
import { ASSERTION_TYPE, createAssertionVerifier } from '../clientAssertion.js';

const CHATGPT = 'https://chatgpt.example/oauth/client.json';
const CHATGPT_KEYS = 'https://chatgpt.example/oauth/jwks.json';
const CHATGPT_REDIRECT = 'https://chatgpt.example/connector_platform_oauth_redirect';
const CLAUDE = 'https://claude.example/oauth/claude-code-client-metadata';
const CLAUDE_REDIRECT = 'http://localhost/callback';

function memoryAdapter() {
  const objects = new Map();
  return {
    async get(key) { return objects.get(key) ?? null; },
    async put(key, value) { objects.set(key, value); },
    async putIfAbsent(key, value) {
      if (objects.has(key)) return false;
      objects.set(key, value);
      return true;
    },
    async delete(key) { objects.delete(key); },
    async list(prefix) { return [...objects.keys()].filter((key) => key.startsWith(prefix)); }
  };
}

const signing = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'chatgpt-2026';
const documents = {
  [CHATGPT]: {
    client_id: CHATGPT,
    client_name: 'ChatGPT',
    redirect_uris: [CHATGPT_REDIRECT],
    // As ChatGPT publishes it: the older singular preference names the method.
    token_endpoint_auth_method: 'private_key_jwt',
    jwks_uri: CHATGPT_KEYS
  },
  [CHATGPT_KEYS]: { keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' }] },
  [CLAUDE]: { client_id: CLAUDE, client_name: 'Claude Code', redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: 'none' }
};
const fetchDocument = async (url) => {
  if (!documents[url]) throw new Error(`unexpected fetch ${url}`);
  return { body: JSON.stringify(documents[url]), maxAgeMs: 300_000 };
};

let base;
let server;
let issuer;
beforeAll(async () => {
  const store = createOAuthStore({ adapter: memoryAdapter() });
  const app = express();
  app.use(express.json());
  // The app's session, reduced to a header.
  app.use((req, _res, next) => {
    if (req.headers['x-test-user']) req.user = { sub: req.headers['x-test-user'] };
    next();
  });
  app.use(createOAuthRouter({
    store,
    resolveClient: createClientResolver({ registeredClient: store.registeredClient, fetchDocument }),
    verifyAssertion: createAssertionVerifier({ useAssertion: store.useAssertion, fetchKeys: fetchDocument }),
    log: { error() {} }
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  issuer = `${base}/api/oauth`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

function assertion(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${encode({
    iss: CHATGPT, sub: CHATGPT, aud: issuer, iat: now, exp: now + 60, jti: crypto.randomUUID(), ...claims
  })}`;
  return `${input}.${crypto.sign('sha256', Buffer.from(input), signing.privateKey).toString('base64url')}`;
}
const signed = (claims) => ({ client_assertion_type: ASSERTION_TYPE, client_assertion: assertion(claims) });
const post = async (path, form) => {
  const response = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
};

/** Authorize as `clientId`, approve as alice; resolves the code and its verifier. */
async function signIn(clientId, redirectUri) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(`${issuer}/authorize`);
  for (const [key, value] of Object.entries({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: 'S256', state: 's1', resource: `${base}/api/mcp/workspace`
  })) authorize.searchParams.set(key, value);
  const started = await fetch(authorize, { redirect: 'manual' });
  expect(started.status).toBe(302);
  const request = new URL(started.headers.get('location')).searchParams.get('request');
  const approved = await fetch(`${issuer}/requests/${request}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'alice-1' }, body: JSON.stringify({ approve: true })
  });
  const code = new URL((await approved.json()).redirect).searchParams.get('code');
  return { code, verifier, redirectUri };
}
const exchange = ({ code, verifier, redirectUri }, extra) => post('/api/oauth/token', {
  grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, resource: `${base}/api/mcp/workspace`, ...extra
});

test('the server says it takes private_key_jwt, and still "none" (Claude needs that to use its document)', async () => {
  const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server/api/oauth`)).json();
  expect(metadata.token_endpoint_auth_methods_supported).toEqual(['none', 'private_key_jwt']);
  expect(metadata.token_endpoint_auth_signing_alg_values_supported).toEqual(['RS256', 'PS256', 'ES256', 'EdDSA']);
  expect(metadata.client_id_metadata_document_supported).toBe(true);
});

describe('ChatGPT (private_key_jwt)', () => {
  test('signs in: the authorize step accepts its document, its signed requests get and refresh tokens', async () => {
    const tokens = await exchange(await signIn(CHATGPT, CHATGPT_REDIRECT), signed());
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({ token_type: 'Bearer', scope: 'diagrams:read diagrams:propose' });
    // client_id may come in the body as well, when it is the same client.
    const refreshed = await post('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, client_id: CHATGPT, ...signed() });
    expect(refreshed.status).toBe(200);
    // An assertion aimed at the token endpoint itself is fine too.
    const again = await post('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshed.body.refresh_token, ...signed({ aud: `${issuer}/token` }) });
    expect(again.status).toBe(200);
  });

  test('without a signature, with a bad one, or with one used before: invalid_client, no tokens', async () => {
    const unsigned = await exchange(await signIn(CHATGPT, CHATGPT_REDIRECT), { client_id: CHATGPT });
    expect(unsigned).toMatchObject({ status: 401, body: { error: 'invalid_client', error_description: 'This client must authenticate with private_key_jwt' } });

    const forged = signed();
    forged.client_assertion = `${forged.client_assertion.slice(0, -4)}AAAA`;
    expect((await exchange(await signIn(CHATGPT, CHATGPT_REDIRECT), forged)).body.error).toBe('invalid_client');

    const wrongAudience = await exchange(await signIn(CHATGPT, CHATGPT_REDIRECT), signed({ aud: 'https://elsewhere.example/oauth' }));
    expect(wrongAudience).toMatchObject({ status: 401, body: { error: 'invalid_client' } });

    const once = signed();
    expect((await exchange(await signIn(CHATGPT, CHATGPT_REDIRECT), once)).status).toBe(200);
    const replayed = await exchange(await signIn(CHATGPT, CHATGPT_REDIRECT), once);
    expect(replayed).toMatchObject({ status: 401, body: { error_description: 'client_assertion was already used' } });

    const mismatched = await exchange(await signIn(CHATGPT, CHATGPT_REDIRECT), { client_id: CLAUDE, ...signed() });
    expect(mismatched.body.error).toBe('invalid_client');
  });

  test('its refresh token cannot be used without a signature, so a stolen one is worthless', async () => {
    const tokens = await exchange(await signIn(CHATGPT, CHATGPT_REDIRECT), signed());
    const stolen = await post('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, client_id: CHATGPT });
    expect(stolen).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
    // And the failed attempt did not use it up.
    const owner = await post('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, ...signed() });
    expect(owner.status).toBe(200);
  });

  test('revocation is signed too; an unsigned one is refused and the token keeps working', async () => {
    const tokens = await exchange(await signIn(CHATGPT, CHATGPT_REDIRECT), signed());
    const unsigned = await post('/api/oauth/revoke', { token: tokens.body.refresh_token, client_id: CHATGPT });
    expect(unsigned.status).toBe(401);
    const revoked = await post('/api/oauth/revoke', { token: tokens.body.refresh_token, ...signed({ aud: `${issuer}/revoke` }) });
    expect(revoked.status).toBe(200);
    const after = await post('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, ...signed() });
    expect(after).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });
});

describe('Claude Code (public client), unchanged', () => {
  test('signs in, refreshes and revokes with no signature', async () => {
    const tokens = await exchange(await signIn(CLAUDE, CLAUDE_REDIRECT), { client_id: CLAUDE });
    expect(tokens.status).toBe(200);
    const refreshed = await post('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, client_id: CLAUDE });
    expect(refreshed.status).toBe(200);
    expect((await post('/api/oauth/revoke', { token: refreshed.body.refresh_token, client_id: CLAUDE })).status).toBe(200);
  });

  test('cannot pass for ChatGPT, and an assertion it cannot back is refused', async () => {
    const tokens = await exchange(await signIn(CLAUDE, CLAUDE_REDIRECT), { client_id: CHATGPT });
    expect(tokens).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    const pretend = await exchange(await signIn(CLAUDE, CLAUDE_REDIRECT), {
      client_id: CLAUDE, client_assertion_type: ASSERTION_TYPE, client_assertion: assertion({ iss: CLAUDE, sub: CLAUDE })
    });
    expect(pretend).toMatchObject({ status: 401, body: { error_description: 'This client publishes no keys to sign with' } });
  });
});
