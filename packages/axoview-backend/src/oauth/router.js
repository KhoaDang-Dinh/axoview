/**
 * Axoview as an OAuth 2.1 authorization server for MCP clients (ADR 0059,
 * MCP authorization 2026-07-28). An outside agent (Claude Code, Claude,
 * ChatGPT, Gemini CLI, Codex) gets a token to act as one person, after that
 * person signs in with their usual account and approves it in the app.
 *
 * Public (no Axoview session):
 *   GET  metadata at the three discovery URLs for issuer <base>/api/oauth, and
 *        the MCP server's protected resource metadata
 *   POST /api/oauth/register    Dynamic Client Registration (public clients only)
 *   GET  /api/oauth/authorize   checks the request, then sends the browser to
 *                               the consent page in the app
 *   POST /api/oauth/token       authorization_code (PKCE S256, resource-bound)
 *                               and refresh_token (rotated on every use)
 *   POST /api/oauth/revoke
 *
 * Clients are public ("none": Claude, Claude Code) or sign each token and
 * revocation request with a key they publish ("private_key_jwt": ChatGPT;
 * clientAssertion.js). A client whose metadata does not offer "none" must
 * sign; one that offers both may. Codes and tokens remember which it was, so
 * a token issued to a signing client cannot be refreshed without a signature.
 * Signed in (the app's Cognito session, req.user):
 *   GET  /api/oauth/requests/:id     what the consent page shows
 *   POST /api/oauth/requests/:id     { approve, scopes } -> { redirect }
 *   GET  /api/oauth/grants           the clients this person connected
 *   PATCH/DELETE /api/oauth/grants/:id
 *
 * Nothing redirects before the client and its redirect URI check out (no open
 * redirect); every redirect back carries `iss` (RFC 9207).
 */
import express, { Router } from 'express';
import { ClientError, SIGNING_ALGS, TOKEN_AUTH_METHODS, isAcceptableRedirect, isLoopbackRedirect, redirectMatches } from './clientMetadata.js';
import { ASSERTION_TYPE, claimedClient } from './clientAssertion.js';
import { pkceMatches } from './store.js';

export const SCOPES = Object.freeze({
  read: 'diagrams:read',
  propose: 'diagrams:propose'
});
export const SCOPES_SUPPORTED = Object.freeze([SCOPES.read, SCOPES.propose]);
export const MCP_PATH = '/api/mcp/workspace';
export const ISSUER_PATH = '/api/oauth';

const REGISTRATIONS_PER_HOUR = 30;

/** The deployment's base URL: PUBLIC_BASE_URL, else the request's own. */
export function baseUrlOf(req, publicBaseUrl) {
  if (publicBaseUrl) return publicBaseUrl.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

/** Discovery documents for a base URL. */
export function metadataFor(base) {
  const issuer = `${base}${ISSUER_PATH}`;
  return {
    authorizationServer: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      // "none" stays listed: Claude uses a metadata document only when it is.
      token_endpoint_auth_methods_supported: [...TOKEN_AUTH_METHODS],
      token_endpoint_auth_signing_alg_values_supported: [...SIGNING_ALGS],
      revocation_endpoint_auth_methods_supported: [...TOKEN_AUTH_METHODS],
      revocation_endpoint_auth_signing_alg_values_supported: [...SIGNING_ALGS],
      scopes_supported: [...SCOPES_SUPPORTED],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true
    },
    protectedResource: {
      resource: `${base}${MCP_PATH}`,
      authorization_servers: [issuer],
      scopes_supported: [...SCOPES_SUPPORTED],
      bearer_methods_supported: ['header'],
      resource_name: 'Axoview diagrams'
    },
    resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource${MCP_PATH}`
  };
}

/** Same resource, tolerating upper-case scheme and host and one trailing slash. */
export function sameResource(given, expected) {
  if (typeof given !== 'string') return false;
  try {
    const a = new URL(given);
    const b = new URL(expected);
    return a.protocol === b.protocol && a.host === b.host &&
      a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '') && !a.search && !a.hash;
  } catch {
    return false;
  }
}

/** The supported scopes asked for; all of them when none are named. */
function requestedScopes(scope) {
  if (typeof scope !== 'string' || !scope.trim()) return [...SCOPES_SUPPORTED];
  const asked = scope.split(/\s+/).filter((s) => SCOPES_SUPPORTED.includes(s));
  // Proposing implies reading: a token that may propose must see what it proposes on.
  if (asked.includes(SCOPES.propose) && !asked.includes(SCOPES.read)) asked.unshift(SCOPES.read);
  return asked;
}

function withParams(uri, params) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  return url.toString();
}

const tokenError = (res, status, error, description) =>
  res.status(status).set('Cache-Control', 'no-store').json({ error, ...(description ? { error_description: description } : {}) });

/**
 * @param {object} deps
 * @param {ReturnType<import('./store.js').createOAuthStore>} deps.store
 * @param {(clientId: string) => Promise<object>} deps.resolveClient
 * @param {(client: object, assertion: string, audiences: string[]) => Promise<void>} [deps.verifyAssertion]
 *        private_key_jwt (clientAssertion.js); without it, signing clients are refused
 * @param {string} [deps.publicBaseUrl]
 * @param {boolean} [deps.enabled]
 * @param {() => number} [deps.now]
 */
export function createOAuthRouter({
  store, resolveClient, verifyAssertion = null, publicBaseUrl = '', enabled = true, now = Date.now, log = console
}) {
  const router = Router();
  const registrations = new Map(); // ip -> [timestamps]
  const form = express.urlencoded({ extended: false, limit: '16kb' });

  // Per route, not router.use: this router is mounted at the root (for the
  // /.well-known paths), so a router-wide guard would touch every request.
  const guard = (req, res, next) => {
    if (!enabled) return res.status(404).json({ error: 'Agent sign-in is not enabled here' });
    res.set('Cache-Control', 'no-store');
    next();
  };

  /**
   * The client a token or revocation request is from, authenticated as its
   * record requires. `required`: the client must sign ("private_key_jwt").
   * Resolves { clientId } or { error } (an invalid_client description).
   */
  async function authenticateClient(req, { required, audience }) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const assertion = body.client_assertion;
    const signed = assertion !== undefined || body.client_assertion_type !== undefined;
    const clientId = typeof body.client_id === 'string' ? body.client_id : (signed ? claimedClient(assertion) : undefined);
    if (!signed) return required ? { error: 'This client must authenticate with private_key_jwt' } : { clientId };
    if (body.client_assertion_type !== ASSERTION_TYPE || typeof assertion !== 'string') {
      return { error: `client_assertion_type must be ${ASSERTION_TYPE}` };
    }
    if (typeof clientId !== 'string') return { error: 'client_assertion names no client' };
    if (!verifyAssertion) return { error: 'private_key_jwt is not available here' };
    let client;
    try {
      client = await resolveClient(clientId);
    } catch (error) {
      return { error: error instanceof ClientError ? error.message : 'the client could not be identified' };
    }
    if (!client?.jwksUri && !client?.jwks) return { error: 'This client publishes no keys to sign with' };
    const { authorizationServer } = metadataFor(baseUrlOf(req, publicBaseUrl));
    try {
      await verifyAssertion(client, assertion, [authorizationServer.issuer, authorizationServer[audience]]);
    } catch (error) {
      if (error?.oauthError === 'invalid_client') return { error: error.message };
      throw error;
    }
    return { clientId };
  }
  const clientError = (res, description) => tokenError(res.set('WWW-Authenticate', 'Bearer'), 401, 'invalid_client', description);

  // ---------------------------------------------------------------- discovery
  const asMetadata = (req, res) => res.json(metadataFor(baseUrlOf(req, publicBaseUrl)).authorizationServer);
  const prMetadata = (req, res) => res.json(metadataFor(baseUrlOf(req, publicBaseUrl)).protectedResource);
  router.get(`/.well-known/oauth-authorization-server${ISSUER_PATH}`, guard, asMetadata);
  router.get(`/.well-known/openid-configuration${ISSUER_PATH}`, guard, asMetadata);
  router.get(`${ISSUER_PATH}/.well-known/openid-configuration`, guard, asMetadata);
  router.get(`${ISSUER_PATH}/.well-known/oauth-authorization-server`, guard, asMetadata);
  router.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, guard, prMetadata);
  router.get(`${MCP_PATH}/.well-known/oauth-protected-resource`, guard, prMetadata);

  // ---------------------------------------------------------------- DCR
  router.post(`${ISSUER_PATH}/register`, guard, async (req, res) => {
    const ip = req.ip || 'unknown';
    const hourAgo = now() - 3_600_000;
    const recent = (registrations.get(ip) || []).filter((at) => at > hourAgo);
    if (recent.length >= REGISTRATIONS_PER_HOUR) return tokenError(res, 429, 'slow_down', 'Too many registrations');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const redirects = body.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length === 0 || redirects.length > 10 || !redirects.every(isAcceptableRedirect)) {
      return tokenError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be https or loopback http URLs');
    }
    if ((body.token_endpoint_auth_method ?? 'none') !== 'none') {
      return tokenError(res, 400, 'invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") are supported');
    }
    const grantTypes = body.grant_types ?? ['authorization_code'];
    if (!Array.isArray(grantTypes) || !grantTypes.every((g) => ['authorization_code', 'refresh_token'].includes(g))) {
      return tokenError(res, 400, 'invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported');
    }
    const name = typeof body.client_name === 'string' && body.client_name.trim()
      ? body.client_name.trim().slice(0, 100)
      : 'An unnamed app';
    recent.push(now());
    registrations.set(ip, recent);
    const client = await store.registerClient({ client_name: name, redirect_uris: redirects });
    res.status(201).json({
      ...client,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    });
  });

  // ---------------------------------------------------------------- authorize
  router.get(`${ISSUER_PATH}/authorize`, guard, async (req, res) => {
    const base = baseUrlOf(req, publicBaseUrl);
    const { authorizationServer, protectedResource } = metadataFor(base);
    const q = req.query;
    const one = (name) => (typeof q[name] === 'string' ? q[name] : undefined);
    // Until the client and its redirect URI check out, errors are shown, never redirected.
    const refuse = (message) => res.status(400).type('text/plain').send(`Axoview could not start this sign-in: ${message}`);
    let client;
    try {
      client = await resolveClient(one('client_id'));
    } catch (error) {
      return refuse(error instanceof ClientError ? error.message : 'the client could not be identified');
    }
    const redirectUri = one('redirect_uri');
    if (!redirectUri || !redirectMatches(client.redirect_uris, redirectUri)) {
      return refuse('redirect_uri is not one the client registered');
    }
    const back = (params) => res.redirect(302, withParams(redirectUri, { ...params, state: one('state'), iss: authorizationServer.issuer }));
    if (one('response_type') !== 'code') return back({ error: 'unsupported_response_type' });
    const challenge = one('code_challenge');
    if (one('code_challenge_method') !== 'S256' || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' });
    }
    if (!sameResource(one('resource'), protectedResource.resource)) {
      return back({ error: 'invalid_target', error_description: `resource must be ${protectedResource.resource}` });
    }
    const scopes = requestedScopes(one('scope'));
    if (scopes.length === 0) return back({ error: 'invalid_scope', error_description: `Supported: ${SCOPES_SUPPORTED.join(' ')}` });
    const state = one('state');
    if (state && state.length > 500) return back({ error: 'invalid_request', error_description: 'state is too long' });
    const requestId = await store.saveRequest({
      clientId: client.client_id,
      clientName: client.client_name,
      registration: client.registration,
      tokenAuth: client.tokenAuth ?? 'none',
      redirectUri,
      state: state ?? null,
      codeChallenge: challenge,
      resource: protectedResource.resource,
      scopes
    });
    res.redirect(302, `${base}/app/oauth/consent?request=${encodeURIComponent(requestId)}`);
  });

  // ---------------------------------------------------------------- consent (signed in)
  const describeRequest = (request) => {
    const redirect = new URL(request.redirectUri);
    let clientHost = null;
    try {
      clientHost = request.registration === 'metadata' ? new URL(request.clientId).host : null;
    } catch { /* a DCR id */ }
    return {
      clientName: request.clientName,
      clientHost,
      registration: request.registration,
      redirectHost: redirect.host,
      loopback: isLoopbackRedirect(request.redirectUri),
      scopes: request.scopes
    };
  };

  router.get(`${ISSUER_PATH}/requests/:id`, guard, async (req, res) => {
    if (!req.user?.sub) return res.status(401).json({ error: 'Unauthorized' });
    const request = await store.readRequest(req.params.id);
    if (!request) return res.status(404).json({ error: 'This sign-in request has expired. Start again from the app.', reason: 'expired' });
    res.json(describeRequest(request));
  });

  router.post(`${ISSUER_PATH}/requests/:id`, guard, async (req, res) => {
    if (!req.user?.sub) return res.status(401).json({ error: 'Unauthorized' });
    // One decision answers a request, however many arrive together.
    const request = await store.takeRequest(req.params.id);
    if (!request) return res.status(404).json({ error: 'This sign-in request has expired. Start again from the app.', reason: 'expired' });
    const { authorizationServer } = metadataFor(baseUrlOf(req, publicBaseUrl));
    const iss = authorizationServer.issuer;
    if (req.body?.approve !== true) {
      return res.json({ redirect: withParams(request.redirectUri, { error: 'access_denied', state: request.state, iss }) });
    }
    // The person may narrow what was asked, never widen it; reading always comes with it.
    const chosen = Array.isArray(req.body.scopes) ? req.body.scopes : request.scopes;
    const scopes = request.scopes.filter((s) => s === SCOPES.read || chosen.includes(s));
    const grant = await store.saveGrant(req.user.sub, {
      clientId: request.clientId,
      clientName: request.clientName,
      scopes,
      redirectHost: new URL(request.redirectUri).host
    });
    const code = await store.issueCode({
      sub: req.user.sub,
      clientId: request.clientId,
      grantId: grant.id,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      resource: request.resource,
      scope: scopes.join(' '),
      tokenAuth: request.tokenAuth ?? 'none'
    });
    res.json({ redirect: withParams(request.redirectUri, { code, state: request.state, iss }) });
  });

  // ---------------------------------------------------------------- token
  router.post(`${ISSUER_PATH}/token`, guard, form, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { protectedResource } = metadataFor(baseUrlOf(req, publicBaseUrl));
    const grantType = body.grant_type;
    const answer = async (record) => {
      const grant = await store.readGrant(record.sub, record.grantId);
      if (!grant) return tokenError(res, 400, 'invalid_grant', 'This app was disconnected');
      const scope = record.scope.split(' ').filter((s) => grant.scopes.includes(s)).join(' ');
      const tokens = await store.issueTokens({
        sub: record.sub, clientId: record.clientId, grantId: record.grantId, scope, resource: record.resource,
        tokenAuth: record.tokenAuth ?? 'none'
      });
      res.set('Cache-Control', 'no-store').json({
        access_token: tokens.access,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refresh,
        scope
      });
    };
    try {
      if (grantType === 'authorization_code') {
        const record = await store.takeCode(body.code);
        if (!record) return tokenError(res, 400, 'invalid_grant', 'The code is unknown, used or expired');
        const auth = await authenticateClient(req, { required: record.tokenAuth === 'private_key_jwt', audience: 'token_endpoint' });
        if (auth.error) return clientError(res, auth.error);
        if (auth.clientId !== record.clientId) return tokenError(res, 400, 'invalid_grant', 'The code was issued to another client');
        if (body.redirect_uri !== record.redirectUri) return tokenError(res, 400, 'invalid_grant', 'redirect_uri does not match');
        if (!pkceMatches(body.code_verifier, record.codeChallenge)) return tokenError(res, 400, 'invalid_grant', 'PKCE verification failed');
        if (body.resource !== undefined && !sameResource(body.resource, record.resource)) {
          return tokenError(res, 400, 'invalid_target', `resource must be ${protectedResource.resource}`);
        }
        return await answer(record);
      }
      if (grantType === 'refresh_token') {
        const record = await store.readToken(body.refresh_token);
        if (!record || record.kind !== 'refresh') return tokenError(res, 400, 'invalid_grant', 'The refresh token is unknown or expired');
        const auth = await authenticateClient(req, { required: record.tokenAuth === 'private_key_jwt', audience: 'token_endpoint' });
        if (auth.error) return clientError(res, auth.error);
        if (auth.clientId !== record.clientId) return tokenError(res, 400, 'invalid_grant', 'The token was issued to another client');
        if (body.resource !== undefined && !sameResource(body.resource, record.resource)) {
          return tokenError(res, 400, 'invalid_target', `resource must be ${protectedResource.resource}`);
        }
        // Rotation (OAuth 2.1 §4.3.1): the old refresh token works once, for
        // one request, however many present it together.
        if (!(await store.useRefreshToken(body.refresh_token, record))) {
          return tokenError(res, 400, 'invalid_grant', 'The refresh token is unknown or expired');
        }
        const narrowed = typeof body.scope === 'string' && body.scope.trim()
          ? record.scope.split(' ').filter((s) => body.scope.split(/\s+/).includes(s)).join(' ')
          : record.scope;
        return await answer({ ...record, scope: narrowed });
      }
      return tokenError(res, 400, 'unsupported_grant_type');
    } catch (error) {
      log.error?.('[oauth] token request failed: %s', error?.name || 'unknown');
      return tokenError(res, 500, 'server_error');
    }
  });

  router.post(`${ISSUER_PATH}/revoke`, guard, form, async (req, res) => {
    try {
      const token = req.body?.token;
      const record = await store.readToken(token).catch(() => null);
      // A signing client signs its revocations too (RFC 7009 §2.1); an
      // unknown token is still answered 200, so this tells nothing about it.
      const auth = await authenticateClient(req, {
        required: record?.tokenAuth === 'private_key_jwt', audience: 'revocation_endpoint'
      });
      if (auth.error) return clientError(res, auth.error);
      if (record && (auth.clientId === undefined || auth.clientId === record.clientId)) await store.dropToken(token);
      res.status(200).end();
    } catch (error) {
      log.error?.('[oauth] revocation failed: %s', error?.name || 'unknown');
      return tokenError(res, 500, 'server_error');
    }
  });

  // ---------------------------------------------------------------- grants (signed in)
  router.get(`${ISSUER_PATH}/grants`, guard, async (req, res) => {
    if (!req.user?.sub) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ grants: await store.listGrants(req.user.sub) });
  });
  router.patch(`${ISSUER_PATH}/grants/:id`, guard, async (req, res) => {
    if (!req.user?.sub) return res.status(401).json({ error: 'Unauthorized' });
    if (!/^[a-f0-9]{32}$/.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes : null;
    if (!scopes || !scopes.every((s) => SCOPES_SUPPORTED.includes(s))) {
      return res.status(400).json({ error: 'Unknown scope', reason: 'invalid-scope' });
    }
    const grant = await store.updateGrantScopes(req.user.sub, req.params.id, [SCOPES.read, ...scopes.filter((s) => s !== SCOPES.read)]);
    if (!grant) return res.status(404).json({ error: 'Not found' });
    res.json({ grant });
  });
  router.delete(`${ISSUER_PATH}/grants/:id`, guard, async (req, res) => {
    if (!req.user?.sub) return res.status(401).json({ error: 'Unauthorized' });
    if (!/^[a-f0-9]{32}$/.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    await store.dropGrant(req.user.sub, req.params.id);
    res.json({ removed: req.params.id });
  });

  return router;
}

/**
 * Who an MCP request acts for: the person, the client and its scopes, from a
 * Bearer token issued here for this server. Null when there is no valid one.
 */
export async function authenticateAgent(req, { store, publicBaseUrl = '' }) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const record = await store.readToken(header.slice(7).trim());
  if (!record || record.kind !== 'access') return null;
  const { protectedResource } = metadataFor(baseUrlOf(req, publicBaseUrl));
  // Audience: a token for another resource is not accepted here.
  if (!sameResource(record.resource, protectedResource.resource)) return null;
  const grant = await store.readGrant(record.sub, record.grantId);
  if (!grant) return null;
  return {
    sub: record.sub,
    clientId: record.clientId,
    clientName: grant.clientName,
    scopes: record.scope.split(' ').filter((s) => grant.scopes.includes(s))
  };
}
