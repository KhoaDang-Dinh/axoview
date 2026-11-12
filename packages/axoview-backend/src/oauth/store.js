/**
 * The OAuth server's state (ADR 0059), as small JSON objects in one system
 * workspace of the storage adapter (S3 on AWS, files on fs), so every API pod
 * sees the same state:
 *
 *   oauth/clients/<client_id>          a client registered through DCR
 *   oauth/requests/<id>                an authorization request waiting for consent (10 min)
 *   oauth/codes/<sha256(code)>         an authorization code (2 min, used once)
 *   oauth/tokens/<sha256(token)>       an access token (1 h) or refresh token (30 days)
 *   oauth/grants/<sub>/<grantId>       what a person let one client do
 *   oauth/used/<sha256(credential)>    a one-time credential that was used
 *
 * Codes and tokens are stored only as hashes: a copy of the bucket gives no
 * usable credential. A token is valid only while its grant exists, so
 * disconnecting a client (deleting its grant) ends every token it holds.
 * Expired objects are deleted when next read.
 *
 * One-time credentials (a consent request, an authorization code, a refresh
 * token) are used by CLAIMING them: creating oauth/used/<hash> with the
 * adapter's putIfAbsent, which exactly one of any number of concurrent
 * attempts wins, on every API pod. Reading the record and deleting it is not
 * enough: two attempts can both read it before either deletes. A claim is
 * never deleted by the request that made it, because an attempt that read the
 * record earlier could then claim it again; it carries the credential's
 * expiry so a sweep can remove it afterwards.
 */
import crypto from 'crypto';

export const ACCESS_TTL_MS = 3_600_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;
export const CODE_TTL_MS = 120_000;
export const REQUEST_TTL_MS = 600_000;
const GRANT_CACHE_MS = 10_000;

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** S256 PKCE check: BASE64URL(SHA256(verifier)) === challenge, verifier 43-128 chars. */
export function pkceMatches(verifier, challenge) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(String(challenge));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A grant's id: one per person and client. */
export const grantIdFor = (sub, clientId) => sha256(`${sub}\n${clientId}`).slice(0, 32);

/**
 * @param {object} deps
 * @param {object} deps.adapter  the system workspace's storage adapter
 * @param {() => number} [deps.now]
 */
export function createOAuthStore({ adapter, now = Date.now }) {
  const grantCache = new Map(); // `${sub}/${grantId}` -> { at, grant }

  async function read(key) {
    const bytes = await adapter.get(key);
    if (!bytes) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }
  const write = (key, value) => adapter.put(key, new TextEncoder().encode(JSON.stringify(value)));
  const remove = async (key) => {
    try {
      await adapter.delete(key);
    } catch {
      /* already gone */
    }
  };
  /** Read a record that expires; an expired one is deleted and reads as null. */
  async function readLive(key) {
    const record = await read(key);
    if (!record) return null;
    if (typeof record.expires === 'number' && record.expires <= now()) {
      await remove(key);
      return null;
    }
    return record;
  }

  const grantKey = (sub, grantId) => `oauth/grants/${sub}/${grantId}`;

  /** Claim a one-time credential: true for exactly one caller, ever. */
  const claim = (credential, expires) => adapter.putIfAbsent(
    `oauth/used/${sha256(credential)}`,
    new TextEncoder().encode(JSON.stringify({ usedAt: now(), expires: typeof expires === 'number' ? expires : null }))
  );

  return {
    // --- clients (DCR) ---------------------------------------------------
    async registerClient({ client_name, redirect_uris }) {
      const client = {
        client_id: `dcr_${crypto.randomBytes(16).toString('hex')}`,
        client_name,
        redirect_uris,
        client_id_issued_at: Math.floor(now() / 1000)
      };
      await write(`oauth/clients/${client.client_id}`, client);
      return client;
    },
    registeredClient: (clientId) => read(`oauth/clients/${clientId}`),

    // --- authorization requests ------------------------------------------
    async saveRequest(request) {
      const id = randomToken(18);
      await write(`oauth/requests/${id}`, { ...request, expires: now() + REQUEST_TTL_MS });
      return id;
    },
    readRequest: (id) => (/^[A-Za-z0-9_-]{24}$/.test(id) ? readLive(`oauth/requests/${id}`) : Promise.resolve(null)),
    /** The request, for the one decision that gets to answer it; null for any other. */
    async takeRequest(id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(id)) return null;
      const key = `oauth/requests/${id}`;
      const record = await readLive(key);
      if (!record || !(await claim(`request:${id}`, record.expires))) return null;
      await remove(key);
      return record;
    },

    // --- codes -------------------------------------------------------------
    async issueCode(fields) {
      const code = randomToken();
      await write(`oauth/codes/${sha256(code)}`, { ...fields, expires: now() + CODE_TTL_MS });
      return code;
    },
    /**
     * The code's record, for the one attempt that gets to use it: a code works
     * once, however many requests present it at the same moment.
     */
    async takeCode(code) {
      if (typeof code !== 'string' || code.length > 100) return null;
      const key = `oauth/codes/${sha256(code)}`;
      const record = await readLive(key);
      if (!record || !(await claim(`code:${code}`, record.expires))) return null;
      await remove(key);
      return record;
    },

    // --- tokens ------------------------------------------------------------
    /** A fresh access token and refresh token for a grant. */
    async issueTokens({ sub, clientId, grantId, scope, resource }) {
      const access = randomToken();
      const refresh = randomToken();
      const base = { sub, clientId, grantId, scope, resource };
      await write(`oauth/tokens/${sha256(access)}`, { ...base, kind: 'access', expires: now() + ACCESS_TTL_MS });
      await write(`oauth/tokens/${sha256(refresh)}`, { ...base, kind: 'refresh', expires: now() + REFRESH_TTL_MS });
      return { access, refresh, expiresIn: ACCESS_TTL_MS / 1000 };
    },
    async readToken(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
      return readLive(`oauth/tokens/${sha256(token)}`);
    },
    dropToken: (token) => remove(`oauth/tokens/${sha256(token)}`),
    /**
     * Use up a refresh token (rotation): true for the one attempt that gets to
     * exchange it, false for any other, concurrent or later. The token is
     * gone afterwards.
     */
    async useRefreshToken(token, record) {
      if (!(await claim(`refresh:${token}`, record.expires))) return false;
      await remove(`oauth/tokens/${sha256(token)}`);
      return true;
    },

    // --- grants ------------------------------------------------------------
    async saveGrant(sub, { clientId, clientName, scopes, redirectHost }) {
      const grantId = grantIdFor(sub, clientId);
      const existing = await read(grantKey(sub, grantId));
      const grant = {
        id: grantId,
        clientId,
        clientName,
        scopes,
        redirectHost,
        createdAt: existing?.createdAt || new Date(now()).toISOString(),
        updatedAt: new Date(now()).toISOString()
      };
      await write(grantKey(sub, grantId), grant);
      grantCache.set(`${sub}/${grantId}`, { at: now(), grant });
      return grant;
    },
    /** The grant, cached briefly: a disconnect reaches other pods within 10 s. */
    async readGrant(sub, grantId) {
      const cacheKey = `${sub}/${grantId}`;
      const cached = grantCache.get(cacheKey);
      if (cached && now() - cached.at < GRANT_CACHE_MS) return cached.grant;
      const grant = await read(grantKey(sub, grantId));
      if (grantCache.size > 5000) grantCache.clear();
      grantCache.set(cacheKey, { at: now(), grant });
      return grant;
    },
    async listGrants(sub) {
      // Adapters differ in how much of the key list() returns; the last
      // segment is the grant id either way.
      // The trailing slash keeps a prefix-matching store (S3) to this person.
      const keys = await adapter.list(`oauth/grants/${sub}/`);
      const ids = keys.map((key) => key.split('/').pop()).filter((id) => /^[a-f0-9]{32}$/.test(id));
      const grants = await Promise.all(ids.map((id) => read(grantKey(sub, id))));
      return grants.filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async updateGrantScopes(sub, grantId, scopes) {
      const grant = await read(grantKey(sub, grantId));
      if (!grant) return null;
      const next = { ...grant, scopes, updatedAt: new Date(now()).toISOString() };
      await write(grantKey(sub, grantId), next);
      grantCache.set(`${sub}/${grantId}`, { at: now(), grant: next });
      return next;
    },
    async dropGrant(sub, grantId) {
      await remove(grantKey(sub, grantId));
      grantCache.set(`${sub}/${grantId}`, { at: now(), grant: null });
    }
  };
}
