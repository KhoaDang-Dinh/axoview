/**
 * private_key_jwt client authentication (RFC 7523 §2.2, OpenID Connect Core
 * §9): a client that publishes its public keys, such as ChatGPT, signs each
 * token request with a short-lived JWT instead of holding a secret.
 *
 *   client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
 *   client_assertion=<JWT>
 *
 * Checked here, with node's crypto (no JWT library):
 *   - header: alg RS256, PS256, ES256 or EdDSA (never none or HMAC); no key
 *     material or key URL in the header (jwk, jku, x5u, x5c) and no crit;
 *     the key is only ever one the client published;
 *   - key: from the client's JWKS (clientMetadata.js), matched by kid when
 *     the header names one, public only, RSA at least 2048 bits, the curve the
 *     alg needs; `use` and `alg` respected when the key states them;
 *   - claims: iss and sub are the client_id; aud is the issuer or the endpoint
 *     the request went to; exp in the future and at most 5 minutes away; nbf
 *     and iat not in the future (60 s leeway each way); jti present, and used
 *     once: the store claims it like any one-time credential.
 *
 * Keys from a jwks_uri are fetched within the same SSRF fence as client
 * metadata, cached for the max-age asked (1 minute to 1 day), and refetched
 * at most once a minute when a signature does not verify with what is cached
 * (the client rotated its keys). A failed refetch keeps the cached keys.
 */
import crypto from 'crypto';
import { ClientError, SIGNING_ALGS, fetchFenced } from './clientMetadata.js';

export const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const LEEWAY_S = 60;
const MAX_LIFETIME_S = 300;
const MAX_ASSERTION_CHARS = 8192;
const JWKS_MAX_BYTES = 32 * 1024;
const MAX_KEYS = 20;
const CACHE_MIN_MS = 60_000;
const CACHE_MAX_MS = 86_400_000;
const REFETCH_COOLDOWN_MS = 60_000;
const FORBIDDEN_HEADERS = ['jwk', 'jku', 'x5u', 'x5c', 'crit'];

/** A client assertion that does not authenticate the client; its message is safe to return. */
export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.oauthError = 'invalid_client';
  }
}

const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** The three parts of a compact JWS, decoded but NOT verified. Throws AssertionError. */
export function decodeAssertion(assertion) {
  if (typeof assertion !== 'string' || assertion.length > MAX_ASSERTION_CHARS) throw new AssertionError('client_assertion is not a JWT');
  const parts = assertion.split('.');
  if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part))) throw new AssertionError('client_assertion is not a JWT');
  const json = (part) => {
    try {
      const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  const header = json(parts[0]);
  const payload = json(parts[1]);
  if (!header || !payload) throw new AssertionError('client_assertion is not a JWT');
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url') };
}

/** The issuer an assertion claims, unverified: tells the token endpoint which client to look up. */
export function claimedClient(assertion) {
  try {
    const { iss } = decodeAssertion(assertion).payload;
    return typeof iss === 'string' ? iss : undefined;
  } catch {
    return undefined;
  }
}

const KEY_TYPE = { RS256: 'RSA', PS256: 'RSA', ES256: 'EC', EdDSA: 'OKP' };

/** A published JWK as a node public key, when it may verify `alg`; else null. */
function publicKeyFor(jwk, alg) {
  if (!jwk || typeof jwk !== 'object' || jwk.kty !== KEY_TYPE[alg]) return null;
  // A published private key is a broken client, not a key to trust.
  if (['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'].some((field) => field in jwk)) return null;
  if (jwk.use !== undefined && jwk.use !== 'sig') return null;
  if (jwk.key_ops !== undefined && !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes('verify'))) return null;
  if (jwk.alg !== undefined && jwk.alg !== alg) return null;
  let material;
  if (jwk.kty === 'RSA') material = { kty: 'RSA', n: jwk.n, e: jwk.e };
  else if (jwk.kty === 'EC') {
    if (jwk.crv !== 'P-256') return null;
    material = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  } else {
    if (jwk.crv !== 'Ed25519') return null;
    material = { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
  }
  try {
    const key = crypto.createPublicKey({ key: material, format: 'jwk' });
    if (jwk.kty === 'RSA' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return null;
    return key;
  } catch {
    return null;
  }
}

/** Whether `signature` over `signingInput` verifies with `key` under `alg`. */
export function signatureVerifies(alg, key, signingInput, signature) {
  const data = Buffer.from(signingInput);
  try {
    switch (alg) {
      case 'RS256': return crypto.verify('sha256', data, key, signature);
      case 'PS256': return crypto.verify('sha256', data, {
        key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32
      }, signature);
      case 'ES256': return signature.length === 64 && crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
      case 'EdDSA': return crypto.verify(null, data, key, signature);
      default: return false;
    }
  } catch {
    return false;
  }
}

const isNumericDate = (value) => Number.isSafeInteger(value) && value > 0;

/** The claims checks, after the signature verified. Throws AssertionError. */
function checkClaims(payload, clientId, audiences, nowS) {
  if (payload.iss !== clientId || payload.sub !== clientId) throw new AssertionError('client_assertion iss and sub must be the client_id');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.some((value) => typeof value === 'string' && audiences.includes(value))) {
    throw new AssertionError(`client_assertion aud must be ${audiences[0]}`);
  }
  if (!isNumericDate(payload.exp)) throw new AssertionError('client_assertion has no exp');
  if (payload.exp <= nowS - LEEWAY_S) throw new AssertionError('client_assertion has expired');
  if (payload.exp > nowS + MAX_LIFETIME_S + LEEWAY_S) throw new AssertionError('client_assertion lives longer than 5 minutes');
  for (const claim of ['nbf', 'iat']) {
    if (payload[claim] === undefined) continue;
    if (!isNumericDate(payload[claim])) throw new AssertionError(`client_assertion ${claim} is not a date`);
    if (payload[claim] > nowS + LEEWAY_S) throw new AssertionError(`client_assertion ${claim} is in the future`);
  }
  if (typeof payload.jti !== 'string' || payload.jti.length === 0 || payload.jti.length > 256) {
    throw new AssertionError('client_assertion has no jti');
  }
}

/**
 * @param {object} deps
 * @param {(clientId: string, jti: string, expires: number) => Promise<boolean>} deps.useAssertion
 *        claim a jti once (store.useAssertion): true for the first use only
 * @param {(url: string, options: object) => Promise<{body: string, maxAgeMs: number}>} [deps.fetchKeys]
 * @param {() => number} [deps.now]
 */
export function createAssertionVerifier({ useAssertion, fetchKeys = fetchFenced, now = Date.now }) {
  const cache = new Map(); // jwksUri -> { until, fetchedAt, keys }

  async function fetchKeySet(uri) {
    const { body, maxAgeMs } = await fetchKeys(uri, { what: 'the client\'s keys', maxBytes: JWKS_MAX_BYTES });
    let keys;
    try {
      keys = JSON.parse(body)?.keys;
    } catch {
      keys = null;
    }
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS) throw new ClientError('the client\'s keys are not a JWKS');
    if (cache.size > 200) cache.clear();
    const entry = { until: now() + Math.min(CACHE_MAX_MS, Math.max(CACHE_MIN_MS, maxAgeMs)), fetchedAt: now(), keys };
    cache.set(uri, entry);
    return entry;
  }

  /** The client's published keys; `fresh` asks for a refetch (rotation), at most once a minute. */
  async function keysOf(client, fresh = false) {
    if (client.jwks) return client.jwks.keys;
    if (!client.jwksUri) return [];
    const cached = cache.get(client.jwksUri);
    if (cached && cached.until > now() && !(fresh && now() - cached.fetchedAt >= REFETCH_COOLDOWN_MS)) return cached.keys;
    try {
      return (await fetchKeySet(client.jwksUri)).keys;
    } catch (error) {
      if (cached) return cached.keys;
      throw error;
    }
  }

  /**
   * Checks that `assertion` authenticates `client` for a request to one of
   * `audiences` (the issuer first). Resolves when it does and uses up its
   * jti; throws AssertionError (or ClientError when the keys cannot be had).
   */
  return async function verifyAssertion(client, assertion, audiences) {
    const { header, payload, signingInput, signature } = decodeAssertion(assertion);
    const alg = header.alg;
    if (!SIGNING_ALGS.includes(alg)) throw new AssertionError(`client_assertion alg must be one of ${SIGNING_ALGS.join(', ')}`);
    if (client.signingAlg && alg !== client.signingAlg) throw new AssertionError(`client_assertion alg must be ${client.signingAlg}`);
    if (FORBIDDEN_HEADERS.some((name) => name in header)) throw new AssertionError('client_assertion header may not carry keys or crit');
    if (header.kid !== undefined && typeof header.kid !== 'string') throw new AssertionError('client_assertion kid is not a string');

    const verifies = (keys) => keys
      .filter((jwk) => header.kid === undefined || jwk?.kid === header.kid)
      .some((jwk) => {
        const key = publicKeyFor(jwk, alg);
        return key !== null && signatureVerifies(alg, key, signingInput, signature);
      });
    if (!verifies(await keysOf(client)) && !(client.jwksUri && verifies(await keysOf(client, true)))) {
      throw new AssertionError('client_assertion signature does not verify with the client\'s published keys');
    }

    const nowS = Math.floor(now() / 1000);
    checkClaims(payload, client.client_id, audiences, nowS);
    // Used once: a copied assertion cannot authenticate a second request.
    if (!(await useAssertion(client.client_id, payload.jti, (payload.exp + LEEWAY_S) * 1000))) {
      throw new AssertionError('client_assertion was already used');
    }
  };
}
