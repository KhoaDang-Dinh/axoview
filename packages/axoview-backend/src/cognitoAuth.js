import { createPublicKey, verify as verifySignature } from 'crypto';

const JWKS_TTL_MS = 60 * 60 * 1000;
const jwksCache = new Map();

function decodeSegment(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('Malformed JWT');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function userPoolIssuer(region, userPoolId) {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region || '')) throw new Error('Invalid Cognito region');
  if (!/^[\w-]+_[A-Za-z0-9]+$/.test(userPoolId || '')) {
    throw new Error('Invalid Cognito user pool id');
  }
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

function configuredIssuer(issuer, userPoolId) {
  if (typeof issuer !== 'string') throw new Error('Invalid Cognito issuer');
  const match = /^https:\/\/cognito-idp\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.amazonaws\.com\/([\w-]+_[A-Za-z0-9]+)$/.exec(issuer);
  if (!match || match[2] !== userPoolId) throw new Error('Invalid Cognito issuer');
  return issuer;
}

async function loadJwks(issuer, { force = false, fetchImpl = fetch } = {}) {
  const cached = jwksCache.get(issuer);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.keys;

  const response = await fetchImpl(`${issuer}/.well-known/jwks.json`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error('Could not load Cognito signing keys');
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw new Error('Invalid Cognito JWKS');
  const keys = new Map(
    body.keys
      .filter((key) => key?.kty === 'RSA' && typeof key.kid === 'string')
      .map((key) => [key.kid, key])
  );
  if (keys.size === 0) throw new Error('Cognito JWKS has no RSA keys');
  jwksCache.set(issuer, { keys, expiresAt: Date.now() + JWKS_TTL_MS });
  return keys;
}

/**
 * Verify a Cognito access token and return only identity fields derived from
 * its signed claims. The caller supplies the pool and app client(s) from
 * trusted deployment configuration; neither issuer nor key URL comes from the
 * token. `clientId` is one app client id or a list of them (the web client and
 * the mobile client share one user pool, so a person's workspace is the same
 * on both).
 */
export async function verifyCognitoAccessToken(token, {
  region,
  userPoolId,
  issuer: configuredIssuerUrl,
  clientId,
  now = () => Math.floor(Date.now() / 1000),
  fetchImpl = fetch
}) {
  const clientIds = (Array.isArray(clientId) ? clientId : [clientId]).filter(
    (id) => typeof id === 'string' && id.length > 0
  );
  if ((!region && !configuredIssuerUrl) || !userPoolId || clientIds.length === 0) {
    throw new Error('Cognito auth is misconfigured');
  }
  if (typeof token !== 'string' || token.length > 16_384) throw new Error('Invalid JWT');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeSegment(encodedHeader);
  const claims = decodeSegment(encodedPayload);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw new Error('Unsupported JWT signing algorithm');
  }

  const issuer = configuredIssuerUrl
    ? configuredIssuer(configuredIssuerUrl, userPoolId)
    : userPoolIssuer(region, userPoolId);
  if (claims.iss !== issuer || claims.token_use !== 'access') {
    throw new Error('JWT issuer or token type is invalid');
  }
  if (!clientIds.includes(claims.client_id)) throw new Error('JWT client is invalid');
  const currentTime = now();
  if (!Number.isFinite(claims.exp) || claims.exp <= currentTime) throw new Error('JWT is expired');
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > currentTime)) {
    throw new Error('JWT is not active');
  }
  if (typeof claims.sub !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(claims.sub)) {
    throw new Error('JWT subject is invalid');
  }

  let jwks = await loadJwks(issuer, { fetchImpl });
  let jwk = jwks.get(header.kid);
  // Refresh once to handle a rotated signing key without accepting an unknown kid.
  if (!jwk) {
    jwks = await loadJwks(issuer, { force: true, fetchImpl });
    jwk = jwks.get(header.kid);
  }
  if (!jwk) throw new Error('Unknown Cognito signing key');

  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const valid = verifySignature(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKey,
    Buffer.from(encodedSignature, 'base64url')
  );
  if (!valid) throw new Error('JWT signature is invalid');
  return {
    sub: claims.sub,
    ...(typeof claims.username === 'string' ? { username: claims.username } : {})
  };
}

export function clearCognitoJwksCacheForTests() {
  jwksCache.clear();
}
