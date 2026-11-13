/**
 * private_key_jwt (clientAssertion.js): a client assertion authenticates a
 * client only when it is signed by a key the client published, says it is
 * from that client and for this server, is current, and is used once.
 */
import crypto from 'crypto';
import { describe, expect, it, test } from '@jest/globals';
import { createAssertionVerifier, decodeAssertion, claimedClient } from '../clientAssertion.js';

const CLIENT = 'https://chatgpt.example/oauth/client.json';
const JWKS_URI = 'https://chatgpt.example/oauth/jwks.json';
const ISSUER = 'https://axoview.example/api/oauth';
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const NOW = Date.UTC(2026, 10, 13, 4, 0, 0);
const nowS = Math.floor(NOW / 1000);

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A key pair for `alg` and its public JWK. */
function keyPair(alg, kid = `${alg}-1`, options = {}) {
  const pair = {
    RS256: () => crypto.generateKeyPairSync('rsa', { modulusLength: options.bits ?? 2048 }),
    PS256: () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }),
    ES256: () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }),
    EdDSA: () => crypto.generateKeyPairSync('ed25519')
  }[alg]();
  return { alg, kid, privateKey: pair.privateKey, jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig' } };
}

function sign({ alg, kid, privateKey }, claims = {}, header = {}) {
  const input = `${b64({ alg, kid, typ: 'JWT', ...header })}.${b64({
    iss: CLIENT, sub: CLIENT, aud: ISSUER, iat: nowS, exp: nowS + 120, jti: crypto.randomUUID(), ...claims
  })}`;
  const data = Buffer.from(input);
  const signature = {
    RS256: () => crypto.sign('sha256', data, privateKey),
    PS256: () => crypto.sign('sha256', data, { key: privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }),
    ES256: () => crypto.sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' }),
    EdDSA: () => crypto.sign(null, data, privateKey)
  }[alg]();
  return `${input}.${signature.toString('base64url')}`;
}

/** A verifier whose JWKS URL serves `keys()` and counts fetches; jtis kept in memory. */
function setup(keys, { clock = { now: NOW } } = {}) {
  const used = new Set();
  const fetches = [];
  const verify = createAssertionVerifier({
    useAssertion: async (clientId, jti) => {
      const key = `${clientId}\n${jti}`;
      if (used.has(key)) return false;
      used.add(key);
      return true;
    },
    fetchKeys: async (url) => {
      fetches.push(url);
      const current = keys();
      if (current instanceof Error) throw current;
      return { body: JSON.stringify({ keys: current }), maxAgeMs: 3_600_000 };
    },
    now: () => clock.now
  });
  const client = { client_id: CLIENT, jwksUri: JWKS_URI };
  return { verify: (assertion, c = client) => verify(c, assertion, [ISSUER, TOKEN_ENDPOINT]), fetches, clock };
}
const refusal = (promise) => promise.then(() => 'accepted', (error) => error.message);

describe.each(['RS256', 'PS256', 'ES256', 'EdDSA'])('%s', (alg) => {
  const key = keyPair(alg);
  it('a signed, current assertion for this server authenticates the client, once', async () => {
    const { verify } = setup(() => [key.jwk]);
    const assertion = sign(key);
    await expect(verify(assertion)).resolves.toBeUndefined();
    expect(await refusal(verify(assertion))).toBe('client_assertion was already used');
  });
  it('a signature by another key of the same kind does not', async () => {
    const other = keyPair(alg, key.kid);
    const { verify } = setup(() => [key.jwk]);
    expect(await refusal(verify(sign(other)))).toMatch(/signature does not verify/);
  });
});

describe('the claims', () => {
  const key = keyPair('ES256');
  const check = async (claims, header) => refusal(setup(() => [key.jwk]).verify(sign(key, claims, header)));

  test('aud is the issuer or the endpoint the request went to, as a string or in a list', async () => {
    expect(await check({ aud: TOKEN_ENDPOINT })).toBe('accepted');
    expect(await check({ aud: ['https://other.example', ISSUER] })).toBe('accepted');
    expect(await check({ aud: 'https://other.example/api/oauth' })).toBe(`client_assertion aud must be ${ISSUER}`);
    expect(await check({ aud: undefined })).toMatch(/aud must be/);
  });

  test('iss and sub are the client', async () => {
    expect(await check({ iss: 'https://evil.example/client.json' })).toMatch(/iss and sub/);
    expect(await check({ sub: 'someone' })).toMatch(/iss and sub/);
  });

  test('current: not expired, at most five minutes ahead, nothing from the future (60 s leeway)', async () => {
    expect(await check({ exp: nowS - 30 })).toBe('accepted');
    expect(await check({ exp: nowS - 61 })).toBe('client_assertion has expired');
    expect(await check({ exp: nowS + 360 })).toBe('accepted');
    expect(await check({ exp: nowS + 361 })).toBe('client_assertion lives longer than 5 minutes');
    expect(await check({ exp: undefined })).toBe('client_assertion has no exp');
    expect(await check({ exp: 1e300 })).toBe('client_assertion has no exp');
    expect(await check({ iat: nowS + 61 })).toBe('client_assertion iat is in the future');
    expect(await check({ nbf: nowS + 61 })).toBe('client_assertion nbf is in the future');
    expect(await check({ nbf: 'soon' })).toBe('client_assertion nbf is not a date');
  });

  test('a jti, used once per client', async () => {
    expect(await check({ jti: undefined })).toBe('client_assertion has no jti');
    expect(await check({ jti: '' })).toBe('client_assertion has no jti');
  });

  test('the header names a signing alg and carries no key of its own', async () => {
    expect(await check({}, { jwk: key.jwk })).toMatch(/may not carry keys/);
    expect(await check({}, { jku: 'https://evil.example/jwks' })).toMatch(/may not carry keys/);
    expect(await check({}, { crit: ['exp'] })).toMatch(/may not carry keys/);
    expect(await check({}, { kid: 7 })).toMatch(/kid is not a string/);
  });
});

describe('what is never trusted', () => {
  test('alg none, HMAC with the public key as secret, an alg the client pinned otherwise', async () => {
    const rsa = keyPair('RS256');
    const { verify } = setup(() => [rsa.jwk]);
    const unsigned = `${b64({ alg: 'none' })}.${b64({ iss: CLIENT, sub: CLIENT, aud: ISSUER, exp: nowS + 60, jti: 'a' })}.`;
    expect(await refusal(verify(unsigned))).toBe('client_assertion is not a JWT');
    const input = `${b64({ alg: 'HS256', kid: rsa.kid })}.${b64({ iss: CLIENT, sub: CLIENT, aud: ISSUER, exp: nowS + 60, jti: 'b' })}`;
    const hmac = crypto.createHmac('sha256', JSON.stringify(rsa.jwk)).update(input).digest('base64url');
    expect(await refusal(verify(`${input}.${hmac}`))).toMatch(/alg must be one of/);
    expect(await refusal(verify(sign(rsa), { client_id: CLIENT, jwksUri: JWKS_URI, signingAlg: 'PS256' })))
      .toBe('client_assertion alg must be PS256');
  });

  test('weak, private, mislabelled or wrong-curve keys', async () => {
    const weak = keyPair('RS256', 'weak', { bits: 1024 });
    expect(await refusal(setup(() => [weak.jwk]).verify(sign(weak)))).toMatch(/does not verify/);
    const rsa = keyPair('RS256');
    const privateJwk = { ...rsa.privateKey.export({ format: 'jwk' }), kid: rsa.kid };
    expect(await refusal(setup(() => [privateJwk]).verify(sign(rsa)))).toMatch(/does not verify/);
    expect(await refusal(setup(() => [{ ...rsa.jwk, use: 'enc' }]).verify(sign(rsa)))).toMatch(/does not verify/);
    expect(await refusal(setup(() => [{ ...rsa.jwk, alg: 'PS256' }]).verify(sign(rsa)))).toMatch(/does not verify/);
    // An ES256 assertion against a P-384 key.
    const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' });
    const es = { alg: 'ES256', kid: 'p384', privateKey: p384.privateKey };
    expect(await refusal(setup(() => [{ ...p384.publicKey.export({ format: 'jwk' }), kid: 'p384' }]).verify(sign(es)))).toMatch(/does not verify/);
  });

  test('garbage', async () => {
    const { verify } = setup(() => []);
    for (const junk of ['', 'a.b', 'a.b.c.d', 'x'.repeat(9000), 'e30.e30.!!', `${b64([])}.${b64({})}.c2ln`]) {
      expect(await refusal(verify(junk))).toBe('client_assertion is not a JWT');
    }
  });
});

describe('the client\'s keys', () => {
  test('fetched once and cached; inline keys need no fetch', async () => {
    const key = keyPair('ES256');
    const { verify, fetches } = setup(() => [key.jwk]);
    await verify(sign(key));
    await verify(sign(key));
    expect(fetches).toEqual([JWKS_URI]);
    const inline = setup(() => { throw new Error('no fetch'); });
    await expect(inline.verify(sign(key), { client_id: CLIENT, jwks: { keys: [key.jwk] } })).resolves.toBeUndefined();
    expect(inline.fetches).toEqual([]);
  });

  test('a rotated key is picked up by one refetch, at most once a minute', async () => {
    const old = keyPair('ES256', 'old');
    const next = keyPair('ES256', 'new');
    let published = [old.jwk];
    const clock = { now: NOW };
    const { verify, fetches } = setup(() => published, { clock });
    await verify(sign(old));
    // Rotated less than a minute after the last fetch: not yet.
    published = [next.jwk];
    clock.now += 30_000;
    expect(await refusal(verify(sign(next)))).toMatch(/does not verify/);
    expect(fetches).toHaveLength(1);
    clock.now += 31_000;
    await expect(verify(sign(next))).resolves.toBeUndefined();
    expect(fetches).toHaveLength(2);
  });

  test('a failed refetch keeps the cached keys; with none cached, the failure is reported', async () => {
    const key = keyPair('ES256', 'k');
    let published = [key.jwk];
    const clock = { now: NOW };
    const { verify } = setup(() => published, { clock });
    await verify(sign(key));
    published = new Error('down');
    clock.now += 2 * 86_400_000;
    const later = Math.floor(clock.now / 1000);
    await expect(verify(sign(key, { iat: later, exp: later + 120 }))).resolves.toBeUndefined();
    const fresh = setup(() => new Error('down'));
    expect(await refusal(fresh.verify(sign(key)))).toBe('down');
  });
});

test('decoding, unverified: which client an assertion claims to be from', () => {
  const key = keyPair('EdDSA');
  expect(claimedClient(sign(key))).toBe(CLIENT);
  expect(claimedClient('nope')).toBeUndefined();
  expect(decodeAssertion(sign(key)).header).toMatchObject({ alg: 'EdDSA', kid: key.kid });
});
