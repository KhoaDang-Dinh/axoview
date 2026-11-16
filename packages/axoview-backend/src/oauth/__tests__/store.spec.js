/**
 * One-time OAuth credentials are used exactly once, however many attempts
 * arrive together (ADR 0059 addendum 2026-11-12): a consent request, an
 * authorization code, a refresh token. The store's adapter here delays every
 * read, so all the attempts have read the record before any of them removes
 * it: read-then-delete alone would let every one of them through.
 */
import { describe, expect, test } from '@jest/globals';
import { createOAuthStore, sha256 } from '../store.js';

/** In-memory adapter; reads are slow, putIfAbsent is atomic (as fs and S3 are). */
function slowAdapter() {
  const objects = new Map();
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  return {
    objects,
    async get(key) { const value = objects.get(key) ?? null; await pause(); return value; },
    async put(key, value) { objects.set(key, value); },
    async putIfAbsent(key, value) {
      if (objects.has(key)) return false;
      objects.set(key, value);
      return true;
    },
    async delete(key) { await pause(); objects.delete(key); },
    async list(prefix) { return [...objects.keys()].filter((key) => key.startsWith(prefix)); }
  };
}

const ATTEMPTS = 20;
const together = (attempt) => Promise.all(Array.from({ length: ATTEMPTS }, () => attempt()));
const CODE = { sub: 'alice', clientId: 'c1', grantId: 'g1', redirectUri: 'http://127.0.0.1/cb', codeChallenge: 'x', resource: 'r', scope: 'diagrams:read' };

describe('used exactly once under concurrency', () => {
  test('an authorization code', async () => {
    const adapter = slowAdapter();
    const store = createOAuthStore({ adapter });
    const code = await store.issueCode(CODE);
    const results = await together(() => store.takeCode(code));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({ sub: 'alice', clientId: 'c1' });
    // And never again.
    expect(await store.takeCode(code)).toBeNull();
    expect(adapter.objects.has(`oauth/codes/${sha256(code)}`)).toBe(false);
  });

  test('a refresh token (rotation)', async () => {
    const store = createOAuthStore({ adapter: slowAdapter() });
    const { refresh } = await store.issueTokens({ sub: 'alice', clientId: 'c1', grantId: 'g1', scope: 'diagrams:read', resource: 'r' });
    const results = await together(async () => {
      const record = await store.readToken(refresh);
      return record ? store.useRefreshToken(refresh, record) : false;
    });
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.readToken(refresh)).toBeNull();
  });

  test('a consent request', async () => {
    const store = createOAuthStore({ adapter: slowAdapter() });
    const id = await store.saveRequest({ clientId: 'c1', redirectUri: 'http://127.0.0.1/cb', scopes: ['diagrams:read'] });
    const results = await together(() => store.takeRequest(id));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.readRequest(id)).toBeNull();
  });
});

describe('still refused when they should be', () => {
  test('an expired code is not usable and leaves no claim', async () => {
    let clock = 1_000_000;
    const adapter = slowAdapter();
    const store = createOAuthStore({ adapter, now: () => clock });
    const code = await store.issueCode(CODE);
    clock += 121_000;
    expect(await store.takeCode(code)).toBeNull();
    expect([...adapter.objects.keys()].filter((key) => key.startsWith('oauth/used/'))).toEqual([]);
  });

  test('an unknown or malformed code, request or token', async () => {
    const store = createOAuthStore({ adapter: slowAdapter() });
    expect(await store.takeCode('nope')).toBeNull();
    expect(await store.takeCode(undefined)).toBeNull();
    expect(await store.takeRequest('../../etc/passwd')).toBeNull();
    expect(await store.takeRequest('abcdefghijklmnopqrstuvwx')).toBeNull();
    expect(await store.readToken('short')).toBeNull();
  });

  test('a claim records when the credential expires, for a later sweep', async () => {
    const adapter = slowAdapter();
    const store = createOAuthStore({ adapter, now: () => 5000 });
    const code = await store.issueCode(CODE);
    await store.takeCode(code);
    const [claimKey] = [...adapter.objects.keys()].filter((key) => key.startsWith('oauth/used/'));
    expect(JSON.parse(new TextDecoder().decode(adapter.objects.get(claimKey)))).toEqual({ usedAt: 5000, expires: 125000 });
  });
});
