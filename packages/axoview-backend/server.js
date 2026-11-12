import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import * as routes from './src/routes.js';
import { createAiChatRouter } from './src/ai/chat.js';
import { createMcpRouter } from './src/ai/mcp.js';
import { createFsAdapter } from './src/adapters/fs.js';
import { createAwsPublicAdapter, createAwsWorkspaceAdapter } from './src/adapters/aws.js';
import { addWorkspaceScope } from './src/adapters/workspace.js';
import {
  SHARED_WORKSPACE,
  createDynamoSyncCursor,
  createMemorySyncCursor,
  describeChange,
  collectSyncEvents,
  resyncEvent,
  sseFrame
} from './src/syncCursor.js';
import { verifyCognitoAccessToken } from './src/cognitoAuth.js';
import {
  cognitoRefreshCookieName,
  exchangeCognitoCode,
  refreshCognitoSession,
  revokeCognitoSession
} from './src/cognitoSession.js';
import { releaseInfoFor } from './src/releaseInfo.js';
import { createSharing, SharingError } from './src/sharing.js';
import { createAgentSettings } from './src/agentSettings.js';
import { createOAuthStore } from './src/oauth/store.js';
import { createClientResolver } from './src/oauth/clientMetadata.js';
import { createOAuthRouter, ISSUER_PATH, MCP_PATH } from './src/oauth/router.js';
import { createWorkspaceMcpRouter } from './src/ai/workspaceMcp.js';
import { createCognitoDirectory } from './src/cognitoDirectory.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.BACKEND_PORT || 3001;

const STORAGE_ENABLED = process.env.ENABLE_SERVER_STORAGE === 'true';
const STORAGE_PATH = process.env.STORAGE_PATH || '/data/diagrams';
const STORAGE_ADAPTER = process.env.STORAGE_ADAPTER || 'fs';
const COGNITO_ISSUER = process.env.COGNITO_ISSUER || '';
const ISSUER_REGION = /^https:\/\/cognito-idp\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.amazonaws\.com\//.exec(COGNITO_ISSUER)?.[1] || '';
const AWS_REGION = process.env.AWS_REGION || process.env.COGNITO_REGION || ISSUER_REGION;
const DATA_BUCKET = process.env.DATA_BUCKET || process.env.AXOVIEW_DATA_BUCKET || '';
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || process.env.AXOVIEW_DYNAMODB_TABLE || '';
const ENABLE_GIT_BACKUP = process.env.ENABLE_GIT_BACKUP === 'true';

// Express env exposed to route handlers (matches Worker `ctx.env`).
// Phase 2 AI chat (src/ai/chat.js). Built once at startup; an invalid AI
// setting only disables /api/ai. Its readiness is published in /api/config.
const aiChatRouter = createAiChatRouter();

const routeEnv = {
  STORAGE_ENABLED,
  ENABLE_GIT_BACKUP,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || null,
  AUTH_MODE: process.env.AUTH_MODE || 'none',
  COGNITO_REGION: process.env.COGNITO_REGION || process.env.AWS_REGION || ISSUER_REGION || null,
  COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID || null,
  COGNITO_CLIENT_ID: process.env.COGNITO_CLIENT_ID || null,
  // Mobile app (docs/mobile-api.md): its own public Cognito app client and
  // custom-scheme redirect, e.g. axoview://auth/callback.
  COGNITO_MOBILE_CLIENT_ID: process.env.COGNITO_MOBILE_CLIENT_ID || null,
  COGNITO_MOBILE_REDIRECT_URI: process.env.COGNITO_MOBILE_REDIRECT_URI || null,
  COGNITO_DOMAIN: process.env.COGNITO_DOMAIN || null,
  COGNITO_IDENTITY_PROVIDERS: process.env.COGNITO_IDENTITY_PROVIDERS || null,
  COGNITO_ISSUER: COGNITO_ISSUER || null,
  // A5/CHR-08: surfaced to the client via /api/config so the app's own link
  // builders resolve against the operator's canonical base (see routes.js).
  AI_CHAT_ENABLED: process.env.AI_CHAT_ENABLED,
  AI_GUEST_ENABLED: process.env.AI_GUEST_ENABLED,
  AI_DIAGRAM_CONTEXT_ENABLED: process.env.AI_DIAGRAM_CONTEXT_ENABLED,
  AI_MCP_ENABLED: process.env.AI_MCP_ENABLED,
  AI_RAG_ENABLED: process.env.AI_RAG_ENABLED,
  AI_AGENT_WRITE_ENABLED: process.env.AI_AGENT_WRITE_ENABLED,
  AI_LIVE_CHAT: aiChatRouter.ready,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || null
};

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(
  helmet({
    // This server returns JSON only (never HTML / the SPA), so rather than
    // disabling CSP we lock it all the way down: default-src 'none' blocks every
    // resource class and frame-ancestors 'none' blocks framing. Strictly
    // additive to the SPA's own CSP, which nginx / _headers still delivers for
    // the app origin (this server never serves the app).
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

// CORS allowlist (security review 2026-07-05). A bare `cors()` emitted
// `Access-Control-Allow-Origin: *`, which — combined with the AUTH_MODE=none
// default — let any website the operator visited read/write their diagrams
// cross-origin (drive-by). In every real deployment `/api/*` is same-origin
// (nginx fronts both the app and the API on one origin), so the browser needs
// no ACAO at all; only `npm run dev` (SPA :3000 → backend :3001) is genuinely
// cross-origin. Default the allowlist to that dev origin and let operators
// widen it explicitly via ALLOWED_ORIGINS (comma-separated). Unknown origins
// get no ACAO header, so cross-origin reads/writes are blocked; same-origin and
// non-browser (no Origin header) requests are unaffected.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    credentials: true,
    origin(origin, cb) {
      if (!origin) return cb(null, true); // same-origin / curl / server-to-server
      return cb(null, ALLOWED_ORIGINS.includes(origin));
    }
  })
);

// S2/SHARE-09: CORS is a RESPONSE-side control. The allowlist above makes the
// browser withhold the response from an unknown origin — but the request has
// already executed on the server. Any request the browser classes as
// CORS-safelisted skips the preflight entirely, including `POST` with
// `Content-Type: text/plain`, and `POST /api/diagrams/:id/share` needs no body
// at all. Measured on the default self-host config (AUTH_MODE=none): a
// cross-origin share POST from `https://evil.example` returned 200 with NO
// `access-control-allow-origin` header and the diagram was genuinely published.
// `PUT`/`PATCH`/`DELETE` were already safe (they force a preflight the
// allowlist refuses), so the exposure was exactly the safelisted-request subset
// — which the ACAO check the 2026-07-05 security review relied on cannot see.
//
// Reject the REQUEST, not just the response: a disallowed Origin never reaches
// a handler. Requests with no Origin header (curl, server-to-server) are
// unaffected, matching the CORS callback above.
//
// Browsers send `Origin` on EVERY non-GET request, same-origin ones included, so
// "no Origin" is not what the editor's own writes look like. Treating it that
// way refused every create/save/share on the Docker image from v3.9.0 (dev never
// saw it: its :3000 origin is allowlisted). The deployment's own origin is
// therefore always allowed: an Origin whose host[:port] is the Host the request
// was sent to (nginx forwards `$http_host`, port included), or PUBLIC_BASE_URL's
// origin (a front proxy may rewrite Host). The scheme is not compared, because
// TLS usually terminates in front of nginx. A cross-site page can forge neither
// header, so SHARE-09 still holds. A DNS-rebinding page does count as
// same-origin; it could already read, and only AUTH_MODE=shared-token closes it.
const PUBLIC_ORIGIN = (() => {
  try {
    return process.env.PUBLIC_BASE_URL ? new URL(process.env.PUBLIC_BASE_URL).origin : null;
  } catch {
    return null;
  }
})();

function isOwnOrigin(req, origin) {
  if (origin === PUBLIC_ORIGIN) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    const o = new URL(origin);
    // Parsing Host with the origin's scheme drops a default port (`:80`/`:443`).
    return o.host === new URL(`${o.protocol}//${host}`).host;
  } catch {
    return false; // `Origin: null` (opaque origins) or a malformed Host
  }
}

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.includes(origin) || isOwnOrigin(req, origin)) return next();
  return res.status(403).json({ error: 'Origin not allowed' });
});

app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// Auth (Cognito access tokens, shared-token, or no auth)
// ---------------------------------------------------------------------------
const AUTH_MODE = process.env.AUTH_MODE || 'none';
const AUTH_SHARED_SECRET = process.env.AUTH_SHARED_SECRET || '';

function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const OAUTH_PUBLIC_PATHS = new Set([
  MCP_PATH,
  `${MCP_PATH}/.well-known/oauth-protected-resource`,
  `${ISSUER_PATH}/.well-known/openid-configuration`,
  `${ISSUER_PATH}/.well-known/oauth-authorization-server`,
  `${ISSUER_PATH}/register`,
  `${ISSUER_PATH}/authorize`,
  `${ISSUER_PATH}/token`,
  `${ISSUER_PATH}/revoke`
]);

// Anchored to exactly match the Worker's regex (packages/axoview-worker/src/auth.ts)
// so both runtimes bypass auth for the identical shape — a bare `startsWith`
// exempted any path under the prefix, drifting from the Worker.
const PUBLIC_SNAPSHOT_RE = /^\/api\/public\/diagrams\/[A-Za-z0-9_-]{21,64}$/;

function isPublicRoute(req) {
  // Always-public endpoints. Per ADR 0010 D6, the public namespace is read-only;
  // both endpoints are GET-only to match the Worker (packages/axoview-worker/src/auth.ts).
  if (req.method === 'GET' && req.path === '/api/config') return true;
  // The public manual over MCP (src/ai/mcp.js): read-only, public docs only,
  // and a 404 unless AI_MCP_DOCS_ENABLED is true.
  if (req.path === '/api/mcp') return true;
  // Agents (ADR 0059): the workspace MCP server checks its own OAuth tokens,
  // and the OAuth endpoints an MCP client calls before it has one. The
  // consent and connected-apps calls (requests/, grants) stay signed in.
  if (OAUTH_PUBLIC_PATHS.has(req.path)) return true;
  if (req.method === 'GET' && PUBLIC_SNAPSHOT_RE.test(req.path)) return true;
  if (
    req.method === 'POST' &&
    ['/api/auth/callback', '/api/auth/refresh', '/api/auth/logout'].includes(req.path)
  ) return true;
  return false;
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return null; }
  }
  return null;
}

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (isPublicRoute(req)) return next();
  if (AUTH_MODE === 'none') return next();
  if (AUTH_MODE === 'shared-token') {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!AUTH_SHARED_SECRET || !constantTimeEquals(token, AUTH_SHARED_SECRET)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  }
  if (AUTH_MODE === 'cognito') {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    verifyCognitoAccessToken(token, {
      region: process.env.COGNITO_REGION || process.env.AWS_REGION,
      userPoolId: process.env.COGNITO_USER_POOL_ID,
      // Web and mobile app clients of the same pool.
      clientId: [process.env.COGNITO_CLIENT_ID, process.env.COGNITO_MOBILE_CLIENT_ID].filter(Boolean),
      issuer: COGNITO_ISSUER || undefined
    })
      .then((user) => {
        req.user = user;
        next();
      })
      .catch(() => res.status(401).json({ error: 'Unauthorized' }));
    return;
  }
  // cf-access only meaningful behind Cloudflare Access — reject if misconfigured here
  return res.status(500).json({ error: `AUTH_MODE "${AUTH_MODE}" not supported on this runtime` });
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------
const adapter = STORAGE_ADAPTER === 'aws'
  ? createAwsPublicAdapter({ bucketName: DATA_BUCKET, tableName: DYNAMODB_TABLE, region: AWS_REGION })
  : addWorkspaceScope(createFsAdapter(STORAGE_PATH));

/** One workspace's storage: a signed-in person's own, or a diagram owner's. */
function workspaceAdapter(workspaceId) {
  return STORAGE_ADAPTER === 'aws'
    ? createAwsWorkspaceAdapter({
        workspaceId,
        bucketName: DATA_BUCKET,
        tableName: DYNAMODB_TABLE,
        region: AWS_REGION
      })
    : adapter.forWorkspace(workspaceId);
}

// Sharing a diagram with another account by email (src/sharing.js, ADR 0057):
// needs accounts (Cognito, with the pool to look people up in) and storage.
const sharing = STORAGE_ENABLED && AUTH_MODE === 'cognito' && routeEnv.COGNITO_USER_POOL_ID && routeEnv.COGNITO_REGION
  ? createSharing({
      adapterFor: workspaceAdapter,
      ...createCognitoDirectory({ userPoolId: routeEnv.COGNITO_USER_POOL_ID, region: routeEnv.COGNITO_REGION })
    })
  : null;
routeEnv.SHARING_ENABLED = !!sharing;
// What a person may do with someone else's diagram, by permission level
// (src/sharing.js). The owner and a Full admin may do everything, except that
// the folder a diagram sits in belongs to the owner's own file tree.
const OWNER_FOLDER_ROUTES = new Set(['PATCH /api/diagrams/:id/move']);
const READ_ROUTES = new Set(['GET /api/diagrams/:id']);
// What each person lets their AI agents do (src/agentSettings.js): needs a
// signed-in person's workspace, with or without sharing.
const agentSettings = STORAGE_ENABLED ? createAgentSettings({ adapterFor: workspaceAdapter }) : null;

// Realtime multi-device sync (src/syncCursor.js): every write bumps the
// workspace's change cursor; /api/sync/events streams it to the other devices.
// AWS: a DynamoDB item every API pod reads. fs (one process): in memory.
const syncCursor = STORAGE_ADAPTER === 'aws'
  ? createDynamoSyncCursor({ tableName: DYNAMODB_TABLE, region: AWS_REGION })
  : createMemorySyncCursor();
const SYNC_POLL_MS = Number(process.env.SYNC_POLL_MS) || 1000;
const SYNC_HEARTBEAT_MS = Number(process.env.SYNC_HEARTBEAT_MS) || 15_000;
// Streams end after this long and the client reconnects (Last-Event-ID), so
// a stream never outlives the access token it was opened with by much, and
// connections rebalance across API pods.
const SYNC_MAX_STREAM_MS = Number(process.env.SYNC_MAX_STREAM_MS) || 5 * 60_000;
// A change whose queue entry is not readable after this long is sent as
// `resync` (the entry's write failed, or it is older than the queue).
const SYNC_GAP_MS = Number(process.env.SYNC_GAP_MS) || 3_000;
// The device (browser tab) that made a change, so it can ignore its own echo.
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// Presence (who else has the workspace open) rides the sync stream; 'off'
// stops the announcements (the app then always batches its uploads).
const SYNC_PRESENCE = process.env.SYNC_PRESENCE !== 'off';

/** A request header that is a well-formed device or browser id, else null. */
function idHeader(req, name) {
  const value = req.headers[name];
  return typeof value === 'string' && DEVICE_ID_RE.test(value) ? value : null;
}

// Open sync streams, ended at shutdown so their tabs reconnect to another pod.
const openSyncStreams = new Set();
let shuttingDown = false;

function syncWorkspaceId(req) {
  return req.user?.sub || SHARED_WORKSPACE;
}

if (STORAGE_ENABLED && STORAGE_ADAPTER === 'fs') {
  (async () => {
    try {
      await fs.access(STORAGE_PATH);
      const files = await fs.readdir(STORAGE_PATH);
      console.log(
        `Storage directory exists: ${STORAGE_PATH} (${files.length} files)`
      );
    } catch {
      console.log(`Creating storage directory: ${STORAGE_PATH}`);
      await fs.mkdir(STORAGE_PATH, { recursive: true });
    }
  })().catch((err) => console.error('Failed to initialize storage:', err));
}

// ---------------------------------------------------------------------------
// Express → routes.js bridge
// ---------------------------------------------------------------------------

function getPublicBaseUrl(req) {
  // Prefer an operator-configured canonical base so share links cannot be
  // poisoned via the client-controlled Host / X-Forwarded-Proto headers
  // (security review 2026-07-05). Falls back to request-derived headers only
  // when PUBLIC_BASE_URL is unset, preserving the previous default behaviour.
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  }
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader) || req.protocol;
  return `${proto}://${req.get('host')}`;
}

function makeCtx(req) {
  return {
    params: req.params,
    body: req.body,
    query: req.query,
    env: routeEnv,
    user: req.user || null,
    ifMatch: /^\"([1-9][0-9]*)\"$/.test(req.headers['if-match'] || '')
      ? Number(req.headers['if-match'].slice(1, -1))
      : undefined,
    refreshToken: getCookie(req, cognitoRefreshCookieName),
    publicBaseUrl: getPublicBaseUrl(req)
  };
}

/**
 * Who should hear about a change to diagram `id` in `owner`'s workspace: the
 * owner and everyone it is shared with (each through their own sync stream).
 */
async function diagramAudience(owner, id) {
  const audience = new Set([owner]);
  if (sharing && id) {
    try {
      for (const sub of await sharing.memberSubs(owner, id)) audience.add(sub);
    } catch (err) {
      console.warn('[sharing] could not read members', err?.name || err);
    }
  }
  return audience;
}

/**
 * Tell the user's other devices about a successful write, and for a shared
 * diagram everyone else who has it. Never fails the write: a missed bump only
 * delays the other devices until their next reconnect or focus check.
 */
async function publishChange(req, route, result, target) {
  const change = describeChange({
    method: req.method,
    route,
    params: req.params,
    body: req.body,
    result
  });
  if (!change) return;
  const device = req.headers['x-axoview-device'];
  if (typeof device === 'string' && DEVICE_ID_RE.test(device)) change.origin = device;
  change.at = new Date().toISOString();
  const workspaces = change.kind === 'diagram' && target?.owner
    ? await diagramAudience(target.owner, change.id)
    : new Set([syncWorkspaceId(req)]);
  for (const workspace of workspaces) {
    try {
      await syncCursor.bump(workspace, change);
    } catch (err) {
      console.warn('[sync] could not publish %s %s', req.method, route, err?.name || err);
    }
  }
}

/**
 * The storage a request acts on, and the caller's role there: their own
 * workspace ('owner'), or for a diagram shared with them its owner's, with
 * what their permission level allows (src/sharing.js).
 */
async function requestTarget(req) {
  if (!req.user?.sub) return { adapter, owner: null, shared: false, role: null };
  const own = { adapter: workspaceAdapter(req.user.sub), owner: req.user.sub, shared: false, role: 'owner' };
  const route = `${req.method} ${req.route?.path}`;
  const id = req.params?.id;
  if (!sharing || !id || !req.route?.path?.startsWith('/api/diagrams/:id')) return own;
  const access = await sharing.accessTo(req.user.sub, id);
  if (!access) return own;
  const target = { adapter: workspaceAdapter(access.owner), owner: access.owner, shared: true, role: access.role };
  if (READ_ROUTES.has(route)) return target;
  if (access.role === 'admin') {
    if (OWNER_FOLDER_ROUTES.has(route)) {
      throw new SharingError(403, 'owner-folders', "Only the owner can move it between the owner's folders");
    }
    return target;
  }
  throw new SharingError(403, 'view-only', 'You can only view this diagram');
}

async function notify(workspaces, change) {
  for (const workspace of new Set(workspaces)) {
    try {
      await syncCursor.bump(workspace, { ...change, at: new Date().toISOString() });
    } catch (err) {
      console.warn('[sharing] could not notify', err?.name || err);
    }
  }
}

function adapt(handler, { requireStorage = true, sync = null } = {}) {
  return async (req, res) => {
    if (requireStorage && !STORAGE_ENABLED) {
      return res.status(503).json({ error: 'Server storage is disabled' });
    }
    try {
      const target = await requestTarget(req);
      const result = await handler(target.adapter, makeCtx(req));
      // `sync: false`: a write that changed nothing (an unchanged save) has
      // nothing to tell the other devices.
      if (sync && result.sync !== false && result.status >= 200 && result.status < 300) {
        await publishChange(req, sync, result, target);
      }
      // A diagram other people have: the app uploads its saves at once
      // instead of batching them (axoview-app DiagramLifecycleProvider).
      if (sharing && req.params?.id && req.route?.path === '/api/diagrams/:id' && result.status < 300 &&
          (target.shared || (target.owner && (await diagramAudience(target.owner, req.params.id)).size > 1))) {
        res.setHeader('X-Axoview-Shared', target.shared ? 'with-you' : 'by-you');
        res.setHeader('X-Axoview-Role', target.role);
      }
      for (const [name, value] of Object.entries(result.headers || {})) {
        res.setHeader(name, value);
      }
      res.status(result.status).json(result.body);
    } catch (err) {
      if (err && typeof err.status === 'number') {
        return res.status(err.status).json(err.body);
      }
      // User-controlled req.method/req.path are passed as %s arguments, NOT
      // interpolated into the format string, so a path containing %-specifiers
      // can't be re-interpreted by util.format (CodeQL: tainted-format-string).
      console.error('[%s %s]', req.method, req.path, err);
      res.status(500).json({ error: 'Internal error' });
    }
  };
}

// ---------------------------------------------------------------------------
// Health probe (ADR 0010 Decision 8)
// ---------------------------------------------------------------------------
// Cached probe — orchestrators may poll every few seconds; we don't want to
// touch the disk on every request.
const HEALTH_TTL_MS = 10_000;
let healthCache = { ts: 0, ok: false, reason: 'not-yet-probed' };

async function probeStorage() {
  if (!STORAGE_ENABLED) return { ok: true };
  if (STORAGE_ADAPTER === 'aws') {
    try {
      await adapter.healthcheck();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.name || 'aws-storage-unreachable' };
    }
  }
  const probePath = path.join(STORAGE_PATH, `.healthz.${process.pid}.tmp`);
  try {
    await fs.mkdir(STORAGE_PATH, { recursive: true });
    await fs.writeFile(probePath, '');
    await fs.unlink(probePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.code || 'storage-unreachable' };
  }
}

app.get('/healthz', async (req, res) => {
  const now = Date.now();
  if (now - healthCache.ts > HEALTH_TTL_MS) {
    const probe = await probeStorage();
    healthCache = { ts: now, ...probe };
  }
  if (healthCache.ok) {
    // The release this image was built from, for the in-cluster release
    // reporter only (src/releaseInfo.js).
    const release = releaseInfoFor(req);
    return res.status(200).json({
      ok: true,
      adapter: STORAGE_ADAPTER,
      storage_writable: STORAGE_ENABLED,
      ...(release ? { release } : {})
    });
  }
  return res.status(503).json({ ok: false, reason: healthCache.reason });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Config — never gated by STORAGE_ENABLED; sole boot probe per ADR 0009 D2
app.get('/api/config', adapt(routes.getConfig, { requireStorage: false }));
app.post('/api/auth/callback', adapt(exchangeCognitoCode, { requireStorage: false }));
app.post('/api/auth/refresh', adapt(refreshCognitoSession, { requireStorage: false }));
app.post('/api/auth/logout', adapt(revokeCognitoSession, { requireStorage: false }));

// Phase 2: server-enforced, authenticated Bedrock chat. No guest access.
app.use('/api/ai', aiChatRouter);
// Outside agents on a person's diagrams (ADR 0059): Axoview's OAuth server
// and the workspace MCP server. Both need accounts, storage and sharing (the
// proposals live there), and AI_MCP_ENABLED. Mounted before the public
// manual's /api/mcp, which would otherwise answer /api/mcp/workspace.
const agentsEnabled = process.env.AI_MCP_ENABLED === 'true' && !!sharing;
const oauthStore = agentsEnabled ? createOAuthStore({ adapter: workspaceAdapter('_oauth') }) : null;
app.use(createOAuthRouter({
  enabled: agentsEnabled,
  store: oauthStore,
  resolveClient: oauthStore ? createClientResolver({ registeredClient: oauthStore.registeredClient }) : async () => null,
  publicBaseUrl: process.env.PUBLIC_BASE_URL || ''
}));
app.use(MCP_PATH, createWorkspaceMcpRouter({
  enabled: agentsEnabled,
  store: oauthStore,
  sharing,
  adapterFor: workspaceAdapter,
  notify: (sub, change) => notify([sub], change),
  loadDiagram: async (workspace, id) => {
    try {
      return (await routes.getDiagram(workspace, { params: { id } })).body;
    } catch (err) {
      if (err?.status === 404) return null;
      throw err;
    }
  },
  publicBaseUrl: process.env.PUBLIC_BASE_URL || ''
}));
app.use('/api/mcp', createMcpRouter());

// Diagrams (`sync`: the route, for the change other devices are told about)
app.get('/api/diagrams', adapt(async (requestAdapter, ctx) => {
  const result = await routes.listDiagrams(requestAdapter, ctx);
  // Diagrams other people shared with this person, marked `shared`.
  if (sharing && ctx.user?.sub) result.body = [...result.body, ...await sharing.sharedWithMe(ctx.user.sub)];
  return result;
}));
app.get('/api/diagrams/:id', adapt(routes.getDiagram));
app.post('/api/diagrams', adapt(routes.createDiagram, { sync: '/api/diagrams' }));
app.put('/api/diagrams/:id', adapt(routes.saveDiagram, { sync: '/api/diagrams/:id' }));
app.patch('/api/diagrams/:id', adapt(routes.patchDiagram, { sync: '/api/diagrams/:id' }));
app.patch('/api/diagrams/:id/move', adapt(routes.moveDiagram, { sync: '/api/diagrams/:id/move' }));
app.delete('/api/diagrams/:id', adapt(routes.deleteDiagram, { sync: '/api/diagrams/:id' }));

// Folders
app.get('/api/folders', adapt(routes.listFolders));
app.post('/api/folders', adapt(routes.createFolder, { sync: '/api/folders' }));
app.put('/api/folders/:id', adapt(routes.renameFolder, { sync: '/api/folders/:id' }));
app.patch('/api/folders/:id/move', adapt(routes.moveFolder, { sync: '/api/folders/:id/move' }));
app.delete('/api/folders/:id', adapt(routes.deleteFolder, { sync: '/api/folders/:id' }));

// Tree manifest
app.get('/api/tree-manifest', adapt(routes.getTreeManifest));
app.put('/api/tree-manifest', adapt(routes.saveTreeManifest, { sync: '/api/tree-manifest' }));

// Realtime sync: one Server-Sent Events stream per open tab. Each change to
// the workspace (any device, any API pod) arrives as
//   event: change   data: { seq, kind, action, id, version, name, deleted, origin, at }
// with kind `resync` when changes were missed. `ready` opens the stream with
// the current sequence; `: ping` comments every SYNC_HEARTBEAT_MS keep the ALB
// and CloudFront connections open. Express only: the Worker runtime does not
// serve it, and clients fall back to checking on focus (404).
app.get('/api/sync/events', async (req, res) => {
  if (!STORAGE_ENABLED) {
    return res.status(503).json({ error: 'Server storage is disabled' });
  }
  // Shutting down: refuse new streams; the client retries (another pod, once
  // the load balancer has dropped this one).
  if (shuttingDown) {
    return res.status(503).set('Retry-After', '1').json({ error: 'Shutting down' });
  }
  const workspaceId = syncWorkspaceId(req);
  let closed = false;

  // Presence: which browsers have this workspace open, so a browser alone can
  // batch its uploads and one with company saves at once (the app's
  // services/sync/presence.ts). One event when a stream opens ('join' for a
  // fresh tab, 'renew' for the reconnect every few minutes), one when the tab
  // closes it ('leave'), and one 'here' from each other browser's stream when a
  // new tab joins, so the newcomer learns who was already there. Ids only: a
  // random id per tab and per browser, never who the user is.
  const device = idHeader(req, 'x-axoview-device');
  const browser = idHeader(req, 'x-axoview-browser');
  const answered = new Set();
  const announce = (action) => {
    if (!SYNC_PRESENCE || !device || !browser) return Promise.resolve();
    return syncCursor
      .bump(workspaceId, { kind: 'presence', action, origin: device, browser, at: new Date().toISOString() })
      .catch((err) => console.warn('[sync] presence %s not published', action, err?.name || err));
  };

  openSyncStreams.add(res);
  req.on('close', () => {
    closed = true;
    openSyncStreams.delete(res);
    // Only the tab closing it is the browser leaving. A stream the server
    // ended (its maximum age, a shutdown) is reconnected at once: no 'leave'.
    if (!res.writableEnded && !shuttingDown) void announce('leave');
  });
  const write = (chunk) => { if (!closed) res.write(chunk); };

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    // no-transform: no proxy may compress (and so buffer) the stream.
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  const header = req.headers['last-event-id'];
  let lastSeq = typeof header === 'string' && /^[0-9]{1,15}$/.test(header) ? Number(header) : null;
  try {
    let gapSince = null;
    // Sends what the stream missed, replaying the queue (src/syncCursor.js);
    // a gap that outlives SYNC_GAP_MS becomes one `resync`.
    const catchUp = async (current) => {
      const result = await collectSyncEvents(syncCursor, workspaceId, lastSeq, current);
      for (const event of result.events) {
        write(sseFrame(event.event, event.seq, event.data));
        // A new tab of ANOTHER browser joined: tell it this one is here, once.
        const data = event.data;
        if (
          data.kind === 'presence' && data.action === 'join' && data.browser !== browser &&
          typeof data.origin === 'string' && !answered.has(data.origin)
        ) {
          answered.add(data.origin);
          void announce('here');
        }
      }
      lastSeq = result.lastSeq;
      if (result.complete) {
        gapSince = null;
      } else if (gapSince === null) {
        gapSince = Date.now();
      } else if (Date.now() - gapSince >= SYNC_GAP_MS) {
        const resync = resyncEvent(current.seq);
        write(sseFrame(resync.event, resync.seq, resync.data));
        lastSeq = current.seq;
        gapSince = null;
        return true;
      }
      return result.events.length > 0;
    };

    const current = await syncCursor.read(workspaceId);
    write('retry: 3000\n\n');
    const resuming = lastSeq !== null;
    if (lastSeq === null) lastSeq = current.seq;
    const resumedWithChanges = await catchUp(current);
    if (!resumedWithChanges && gapSince === null) {
      write(sseFrame('ready', current.seq, { seq: current.seq }));
    }
    await announce(resuming ? 'renew' : 'join');

    const started = Date.now();
    let lastWrite = Date.now();
    while (!closed && !shuttingDown && Date.now() - started < SYNC_MAX_STREAM_MS) {
      await syncCursor.wait(workspaceId, SYNC_POLL_MS);
      if (closed) break;
      const next = await syncCursor.read(workspaceId);
      if (await catchUp(next)) {
        lastWrite = Date.now();
      } else if (Date.now() - lastWrite >= SYNC_HEARTBEAT_MS) {
        write(': ping\n\n');
        lastWrite = Date.now();
      }
    }
  } catch (err) {
    console.error('[sync] stream for %s failed', req.path, err?.name || err);
  }
  openSyncStreams.delete(res);
  if (!closed && !res.writableEnded) res.end();
});

// Share
// People a diagram is shared with and their permission levels (ADR 0057 §5):
// the owner and Full admins list, add by email, change levels and remove.
// The person added hears about it on their sync stream, so the diagram
// appears in their explorer at once.
const SHARING_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SUB_RE = /^[A-Za-z0-9-]{1,128}$/;
function sharingRoute(handler) {
  return async (req, res) => {
    if (!sharing) return res.status(404).json({ error: 'Sharing is not available here' });
    if (!req.user?.sub) return res.status(401).json({ error: 'Unauthorized' });
    if (!SHARING_ID_RE.test(req.params.id || '')) return res.status(400).json({ error: 'Invalid id' });
    if (req.params.sub !== undefined && !SUB_RE.test(req.params.sub)) {
      return res.status(400).json({ error: 'Invalid member' });
    }
    try {
      const { status, body, headers = {} } = await handler(req, res);
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      res.status(status).json(body);
    } catch (err) {
      // A SharingError, or a refusal from a storage route the handler used (routes.js HttpError).
      if (err instanceof SharingError || (typeof err?.status === 'number' && err.body)) {
        return res.status(err.status).json(err.body);
      }
      console.error('[sharing %s]', req.method, err);
      res.status(500).json({ error: 'Internal error', reason: 'error' });
    }
  };
}
app.get('/api/diagrams/:id/members', sharingRoute(async (req) => {
  const owner = await sharing.managedBy(req.user.sub, req.params.id);
  return { status: 200, body: { members: await sharing.listMembers(owner, req.params.id) } };
}));
app.post('/api/diagrams/:id/members', sharingRoute(async (req) => {
  const owner = await sharing.managedBy(req.user.sub, req.params.id);
  const member = await sharing.addMember(owner, req.params.id, req.body?.email, req.body?.role || 'viewer', req.user.sub);
  await notify([member.sub], { kind: 'diagram', action: 'create', id: req.params.id });
  return { status: 201, body: { member } };
}));
app.patch('/api/diagrams/:id/members/:sub', sharingRoute(async (req) => {
  const owner = await sharing.managedBy(req.user.sub, req.params.id);
  const member = await sharing.setRole(owner, req.params.id, req.params.sub, req.body?.role);
  // Their explorer and open tab learn the new level (it changes how it opens).
  await notify([member.sub], { kind: 'diagram', action: 'update', id: req.params.id });
  return { status: 200, body: { member } };
}));
app.delete('/api/diagrams/:id/members/:sub', sharingRoute(async (req) => {
  const owner = await sharing.managedBy(req.user.sub, req.params.id);
  await sharing.removeMember(owner, req.params.id, req.params.sub);
  await notify([req.params.sub], { kind: 'diagram', action: 'delete', id: req.params.id });
  return { status: 200, body: { removed: req.params.sub } };
}));

// Proposals: changes an outside agent proposed through the workspace MCP
// server (ADR 0059). Only the agent's own person sees and decides them, and
// only while they may change the diagram (its owner or a Full admin). They
// hold operations: the person's app works out the diagram with the approved
// ones made, and approving IS saving that diagram. (The in-app assistant is
// approved in the chat instead.)
app.get('/api/diagrams/:id/proposals', sharingRoute(async (req) => {
  const owner = await sharing.managedBy(req.user.sub, req.params.id);
  return { status: 200, body: { proposals: await sharing.pendingProposals(owner, req.params.id, req.user.sub) } };
}));
// Approve = save, then record (ADR 0059 addendum 2026-11-12). The request
// carries the diagram with the approved steps made (`document`) and the state
// it was built on: If-Match "<version>", or `baseModified` on a store without
// versions. In this order:
//   1. the proposal is this person's and still waiting;
//   2. the diagram is saved against that state. If it changed since (409), or
//      no state was given (428), or storage fails, nothing is recorded: the
//      proposal keeps waiting and the diagram is untouched;
//   3. only then is "approved" recorded, with the version that holds the
//      change. The agent reads that record, so it never sees "approved" for a
//      change that is not stored.
// If the answer is lost and the app asks again, step 1 finds the recorded
// approval and returns it without saving twice.
app.post('/api/diagrams/:id/proposals/:pid/approve', sharingRoute(async (req, res) => {
  const id = req.params.id;
  const pid = req.params.pid;
  const owner = await sharing.managedBy(req.user.sub, id);
  if (!SHARING_ID_RE.test(pid || '')) return { status: 400, body: { error: 'Invalid proposal' } };
  const proposal = await sharing.proposalFor(owner, id, pid, req.user.sub);
  if (proposal.status === 'approved') return { status: 200, body: { proposal } };
  if (proposal.status !== 'pending') throw new SharingError(409, 'already-decided', 'That proposal was already rejected');

  const document = req.body?.document;
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { status: 400, body: { error: 'The diagram with the approved changes is required', reason: 'no-document' } };
  }
  const applied = Number.isInteger(req.body?.applied) && req.body.applied >= 0 ? req.body.applied : null;
  const target = {
    adapter: workspaceAdapter(owner),
    owner,
    shared: owner !== req.user.sub,
    role: owner === req.user.sub ? 'owner' : 'admin'
  };
  const saved = await routes.saveDiagram(target.adapter, {
    ...makeCtx(req),
    params: { id },
    body: document,
    mustMatch: true,
    ifUnmodified: typeof req.body.baseModified === 'string' ? req.body.baseModified : undefined
  });
  // Stored. The app learns the new version whatever happens next, and the
  // person's other devices and the people the diagram is shared with hear of
  // the save as of any other.
  for (const [name, value] of Object.entries(saved.headers || {})) res.setHeader(name, value);
  if (saved.sync !== false) {
    await publishChange({ method: 'PUT', params: { id }, body: document, headers: req.headers, user: req.user },
      '/api/diagrams/:id', saved, target);
  }
  const version = /^"([1-9][0-9]*)"$/.exec(saved.headers?.ETag || '')?.[1];
  const resolved = await sharing.resolveProposal(owner, id, pid, 'approved', req.user.sub, {
    applied,
    version: version ? Number(version) : null
  });
  await notify([req.user.sub], { kind: 'proposal', action: 'resolve', id });
  return { status: 200, body: { proposal: resolved, lastModified: saved.body?.lastModified ?? null } };
}));
app.post('/api/diagrams/:id/proposals/:pid/reject', sharingRoute(async (req) => {
  const id = req.params.id;
  const owner = await sharing.managedBy(req.user.sub, id);
  if (!SHARING_ID_RE.test(req.params.pid || '')) return { status: 400, body: { error: 'Invalid proposal' } };
  const resolved = await sharing.resolveProposal(owner, id, req.params.pid, 'rejected', req.user.sub);
  await notify([req.user.sub], { kind: 'proposal', action: 'resolve', id });
  return { status: 200, body: { proposal: resolved } };
}));

// What this person lets their AI agents do (src/agentSettings.js).
async function agentRoute(req, res, work) {
  if (!agentSettings) return res.status(503).json({ error: 'Server storage is disabled' });
  if (!req.user?.sub) return res.status(401).json({ error: 'Unauthorized' });
  try {
    res.status(200).json(await work(req.user.sub));
  } catch (err) {
    if (err instanceof SharingError) return res.status(err.status).json(err.body);
    console.error('[agent settings %s]', req.method, err);
    res.status(500).json({ error: 'Internal error', reason: 'error' });
  }
}
app.get('/api/agent', (req, res) => agentRoute(req, res, (sub) => agentSettings.get(sub)));
app.put('/api/agent', (req, res) => agentRoute(req, res, (sub) => agentSettings.set(sub, req.body?.level)));

app.post('/api/diagrams/:id/share', adapt(routes.shareDiagram));
// SHARE-10 (owner ruling 2026-07-30): the read stays exempt from
// ENABLE_SERVER_STORAGE=false — a published artifact surviving an API
// kill-switch is normal (S3/Pages/publish-to-web) — and REVOCATION becomes
// exempt alongside it, because "unpublish" must always remain reachable. The
// pair moves together; documented in docs/deployment.md.
app.delete('/api/diagrams/:id/share', adapt(routes.unshareDiagram, { requireStorage: false }));
app.get('/api/public/diagrams/:uuid', adapt(routes.getPublicSnapshot, { requireStorage: false }));

// ---------------------------------------------------------------------------
// Terminal error middleware (S2/SHARE-08)
// ---------------------------------------------------------------------------
// `body-parser` rejections never reach `adapt()`'s wrapper — it only wraps the
// HANDLER — so they fell through to Express's built-in handler, which answers
// with an HTML error page containing a Node stack trace. The client's
// `response.json()` then threw, so instead of the ADR 0011 failure dialog
// naming the cause the user got a generic error or nothing at all. Measured
// against the real server: a truncated JSON body returned 400 `text/html`
// carrying `SyntaxError`, and an 11 MB body returned 413 `text/html` carrying
// `entity too large` and `at ` stack frames.
//
// The worker is the correct sibling: its `bodyLimit` answers
// `{ error: 'Payload too large' }` as JSON with 413, and its `onError`
// deliberately logs the stack while keeping it out of the response. Match it.
// Typed on `err.type` rather than the message, and mounted last so a parser
// error raised before any route still lands here.
// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by its arity
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  console.error('[%s %s] unhandled', req.method, req.path, err);
  return res.status(500).json({ error: 'Internal error' });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`Axoview Backend Server running on port ${PORT}`);
  console.log(`Server storage: ${STORAGE_ENABLED ? 'ENABLED' : 'DISABLED'}`);
  if (STORAGE_ENABLED) {
    console.log(`Storage adapter: ${STORAGE_ADAPTER}`);
    if (STORAGE_ADAPTER === 'fs') console.log(`Storage path: ${STORAGE_PATH}`);
    console.log(`Git backup: ${ENABLE_GIT_BACKUP ? 'ENABLED' : 'DISABLED'}`);
  }
  console.log(`CORS allowed origins: ${ALLOWED_ORIGINS.join(', ') || '(none — same-origin only)'}`);
  // Security review 2026-07-05: storage-on + no-auth is a network-reachable,
  // unauthenticated read/write store. CORS is now locked down (drive-by from a
  // web page is blocked), but anyone who can reach the port directly still has
  // full access. Warn loudly so operators set AUTH_MODE before exposing it.
  if (STORAGE_ENABLED && AUTH_MODE === 'none') {
    console.warn(
      '[SECURITY] Server storage is ENABLED with AUTH_MODE=none — the API is ' +
        'UNAUTHENTICATED. Anyone who can reach this port can read, modify, and ' +
        'publicly share every diagram. Do NOT expose it beyond loopback/a trusted ' +
        'LAN. Set AUTH_MODE=shared-token + AUTH_SHARED_SECRET (see docs/deployment.md).'
    );
  }
  if (
    AUTH_MODE === 'cognito' &&
    (!routeEnv.COGNITO_ISSUER || !routeEnv.COGNITO_USER_POOL_ID || !routeEnv.COGNITO_CLIENT_ID)
  ) {
    console.error('[SECURITY] AUTH_MODE=cognito but Cognito configuration is incomplete.');
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown (Kubernetes rollouts, docker stop)
// ---------------------------------------------------------------------------
// The container runs `node server.js` as PID 1, and PID 1 ignores SIGTERM
// unless it handles it: without this, every pod waited out the full grace
// period (30s) for SIGKILL on every rollout, and open sync streams were cut
// mid-write. On SIGTERM:
//   1. end every sync stream at once (its tab reconnects to another pod in
//      about a second) and refuse new ones (503);
//   2. keep answering ordinary requests for SHUTDOWN_DRAIN_MS while the load
//      balancer stops sending new ones here;
//   3. stop accepting connections, let requests in flight finish, exit; force
//      the exit after SHUTDOWN_FORCE_MS so a stuck request cannot hold it.
const SHUTDOWN_DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS ?? 5_000);
const SHUTDOWN_FORCE_MS = Number(process.env.SHUTDOWN_FORCE_MS ?? 10_000);

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: ending ${openSyncStreams.size} sync stream(s), draining for ${SHUTDOWN_DRAIN_MS} ms`);
  for (const res of openSyncStreams) {
    if (!res.writableEnded) res.end();
  }
  openSyncStreams.clear();
  setTimeout(() => {
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => {
      server.closeAllConnections?.();
      process.exit(0);
    }, SHUTDOWN_FORCE_MS).unref();
  }, SHUTDOWN_DRAIN_MS).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
