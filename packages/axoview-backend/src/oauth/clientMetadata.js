/**
 * Who an OAuth client is (MCP authorization, 2026-07-28 "Client Registration"):
 *   - a Client ID Metadata Document: the client_id is an https URL with a
 *     path, and the JSON there names the client and its redirect URIs;
 *   - or a client registered here through Dynamic Client Registration
 *     (deprecated in MCP, kept for clients that do not support CIMD yet).
 *
 * Fetching a CIMD URL is a request the server makes on an outsider's say-so,
 * so it is fenced (SSRF): https only, port 443, no IP literals, every address
 * the name resolves to checked at connect time (no private, loopback,
 * link-local, carrier-grade NAT or multicast ranges, so DNS rebinding cannot
 * slip one in), no redirects, 5 s, 16 KB. Documents are cached per URL for the
 * max-age they ask for, between 1 minute and 1 day.
 */
import https from 'https';
import dns from 'dns';
import net from 'net';

export const CIMD_MAX_BYTES = 16 * 1024;
const CIMD_TIMEOUT_MS = 5000;
const CACHE_MIN_MS = 60_000;
const CACHE_MAX_MS = 86_400_000;

export class ClientError extends Error {
  constructor(message) {
    super(message);
    this.oauthError = 'invalid_client';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for a redirect URI that is a loopback address over http (RFC 8252 §7.3). */
export function isLoopbackRedirect(uri) {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** A redirect URI a client may register: https, or http on a loopback address. No fragment. */
export function isAcceptableRedirect(uri) {
  if (typeof uri !== 'string' || uri.length > 2000) return false;
  try {
    const url = new URL(uri);
    if (url.hash) return false;
    return url.protocol === 'https:' || isLoopbackRedirect(uri);
  } catch {
    return false;
  }
}

/**
 * Whether `requested` is one of `registered`: exactly, except that a loopback
 * redirect may use any port (native apps pick a free one, RFC 8252 §7.3).
 */
export function redirectMatches(registered, requested) {
  if (registered.includes(requested)) return true;
  if (!isLoopbackRedirect(requested)) return false;
  const want = new URL(requested);
  return registered.some((candidate) => {
    if (!isLoopbackRedirect(candidate)) return false;
    const have = new URL(candidate);
    return have.hostname === want.hostname && have.pathname === want.pathname && have.search === want.search;
  });
}

/** True for an address no outside fetch may reach. */
export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

/** dns.lookup that refuses private addresses, used at connect time. */
export function safeLookup(hostname, options, callback) {
  // Node's family autoselection requests all:true and expects an array.
  // Preserve that contract while checking every candidate at connect time.
  dns.lookup(hostname, options, (error, address, family) => {
    if (error) return callback(error);
    const addresses = options.all ? address : [{ address, family }];
    if (!Array.isArray(addresses) || addresses.length === 0 ||
        addresses.some((entry) => !entry || isPrivateAddress(entry.address))) {
      return callback(new Error('address not allowed'));
    }
    if (options.all) return callback(null, addresses);
    callback(null, address, family);
  });
}

/** GET an https URL within the fence above; resolves { body, maxAgeMs }. */
function fetchFenced(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      lookup: safeLookup,
      timeout: CIMD_TIMEOUT_MS,
      headers: { accept: 'application/json', 'user-agent': 'Axoview-OAuth/1.0' }
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new ClientError(`client metadata answered ${response.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > CIMD_MAX_BYTES) {
          request.destroy();
          reject(new ClientError('client metadata is too large'));
        } else {
          chunks.push(chunk);
        }
      });
      response.on('end', () => {
        const maxAge = /max-age=(\d+)/.exec(response.headers['cache-control'] || '');
        const maxAgeMs = maxAge ? Number(maxAge[1]) * 1000 : CACHE_MIN_MS;
        resolve({ body: Buffer.concat(chunks).toString('utf8'), maxAgeMs });
      });
    });
    request.on('timeout', () => request.destroy(new ClientError('client metadata timed out')));
    request.on('error', (error) => reject(error instanceof ClientError ? error : new ClientError('client metadata could not be fetched')));
  });
}

/** True when a client_id is a CIMD URL: https, a path, no fragment, no credentials, default port. */
export function isMetadataUrl(clientId) {
  if (typeof clientId !== 'string' || clientId.length > 500) return false;
  try {
    const url = new URL(clientId);
    return url.protocol === 'https:' && url.pathname !== '/' && !url.hash && !url.username &&
      !url.password && (url.port === '' || url.port === '443') && !net.isIP(url.hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

/** Checks a fetched CIMD document; returns the client or throws ClientError. */
export function clientFromDocument(clientId, text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ClientError('client metadata is not JSON');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ClientError('client metadata is not an object');
  if (doc.client_id !== clientId) throw new ClientError('client metadata client_id does not match its URL');
  if (typeof doc.client_name !== 'string' || !doc.client_name.trim()) throw new ClientError('client metadata has no client_name');
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0 || doc.redirect_uris.length > 20 ||
      !doc.redirect_uris.every(isAcceptableRedirect)) {
    throw new ClientError('client metadata redirect_uris must be https or loopback http URLs');
  }
  const method = doc.token_endpoint_auth_method ?? 'none';
  if (method !== 'none') throw new ClientError('only public clients (token_endpoint_auth_method "none") are supported');
  return {
    client_id: clientId,
    client_name: doc.client_name.trim().slice(0, 100),
    redirect_uris: doc.redirect_uris,
    registration: 'metadata'
  };
}

/**
 * @param {object} deps
 * @param {(clientId: string) => Promise<object|null>} deps.registeredClient  a DCR client, or null
 * @param {(url: string) => Promise<{body: string, maxAgeMs: number}>} [deps.fetchDocument]
 * @param {() => number} [deps.now]
 */
export function createClientResolver({ registeredClient, fetchDocument = fetchFenced, now = Date.now }) {
  const cache = new Map(); // url -> { until, client }
  return async function resolveClient(clientId) {
    if (isMetadataUrl(clientId)) {
      const cached = cache.get(clientId);
      if (cached && cached.until > now()) return cached.client;
      const { body, maxAgeMs } = await fetchDocument(clientId);
      const client = clientFromDocument(clientId, body);
      if (cache.size > 500) cache.clear();
      cache.set(clientId, { until: now() + Math.min(CACHE_MAX_MS, Math.max(CACHE_MIN_MS, maxAgeMs)), client });
      return client;
    }
    if (typeof clientId !== 'string' || !/^dcr_[a-f0-9]{32}$/.test(clientId)) throw new ClientError('unknown client_id');
    const client = await registeredClient(clientId);
    if (!client) throw new ClientError('unknown client_id');
    return { ...client, registration: 'dynamic' };
  };
}
