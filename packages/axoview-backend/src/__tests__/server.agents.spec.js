/**
 * An outside agent on a person's diagrams (ADR 0059), through the REAL
 * server.js (child process, fs storage), as an MCP client does it:
 * discovery, registration, the person's consent in the app (their Cognito
 * session, faked by helpers/fakeCognito.hooks.mjs), PKCE code exchange, MCP
 * tool calls with the token, a proposal the person approves in the app,
 * refresh rotation, and disconnecting.
 */
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '../../server.js');
const HOOKS = path.resolve(HERE, 'helpers/fakeCognito.register.mjs');
const T = 60000;
const ACCOUNTS = [
  { sub: 'alice-1', email: 'alice@example.com', email_verified: true },
  { sub: 'bob-2', email: 'bob@example.com', email_verified: true }
];
const REDIRECT = 'http://127.0.0.1:53682/callback';

let nextPort = 3710;
const running = [];
let dir;

async function startServer({ mcp = true } = {}) {
  const port = nextPort++;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', HOOKS, SERVER], {
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      BACKEND_PORT: String(port),
      STORAGE_PATH: dir,
      ENABLE_SERVER_STORAGE: 'true',
      AUTH_MODE: 'cognito',
      COGNITO_REGION: 'ap-southeast-1',
      COGNITO_USER_POOL_ID: 'ap-southeast-1_test',
      COGNITO_CLIENT_ID: 'test-client',
      SYNC_POLL_MS: '100',
      PUBLIC_BASE_URL: base,
      AI_MCP_ENABLED: mcp ? 'true' : 'false',
      FAKE_COGNITO_ACCOUNTS: JSON.stringify(ACCOUNTS)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  running.push(child);
  const deadline = Date.now() + 20000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`server did not come up:\n${logs.join('')}`);
    try {
      if ((await fetch(`${base}/healthz`)).status === 200) break;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return { base, logs };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axoview-agents-'));
});
afterEach(async () => {
  for (const c of running.splice(0)) c.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

/** A signed-in person in the app (their Cognito session). */
function person(base, sub) {
  const call = async (method, pathname, body) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { authorization: `Bearer test-user:${sub}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

/** An MCP client (modern protocol) holding `token`. */
/** The change events `sub`'s sync stream delivers within `ms` of the call. */
async function listen(base, sub, ms) {
  const controller = new AbortController();
  const events = [];
  const res = await fetch(`${base}/api/sync/events`, {
    headers: { authorization: `Bearer test-user:${sub}` },
    signal: controller.signal
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (/^event: change$/m.test(frame) && data) events.push(JSON.parse(data));
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    async stop() {
      await new Promise((resolve) => setTimeout(resolve, ms));
      controller.abort();
      await done;
      return events;
    }
  };
}

function mcpClient(base, token) {
  let id = 0;
  const rpc = async (method, params = {}) => {
    const res = await fetch(`${base}/api/mcp/workspace`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': method,
        ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {})
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: ++id, method,
        params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } }
      })
    });
    const text = await res.text();
    return { status: res.status, auth: res.headers.get('www-authenticate'), body: text ? JSON.parse(text) : null };
  };
  return { rpc, call: (name, args = {}) => rpc('tools/call', { name, arguments: args }) };
}

const form = (fields) => new URLSearchParams(fields).toString();
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

/** Everything a client does up to the token, with the person approving `scopes`. */
async function connect(base, { sub = 'alice-1', scopes, scope = 'diagrams:read diagrams:propose', clientName = 'Claude Code' } = {}) {
  const registered = await (await fetch(`${base}/api/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] })
  })).json();
  const { verifier, challenge } = pkce();
  const authorize = new URL(`${base}/api/oauth/authorize`);
  Object.entries({
    response_type: 'code', client_id: registered.client_id, redirect_uri: 'http://127.0.0.1:61999/callback',
    code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope, resource: `${base}/api/mcp/workspace`
  }).forEach(([k, v]) => authorize.searchParams.set(k, v));
  const toConsent = await fetch(authorize, { redirect: 'manual' });
  expect(toConsent.status).toBe(302);
  const consent = new URL(toConsent.headers.get('location'));
  expect(consent.pathname).toBe('/app/oauth/consent');
  const requestId = consent.searchParams.get('request');
  const app = person(base, sub);
  const shown = await app.get(`/api/oauth/requests/${requestId}`);
  const approved = await app.post(`/api/oauth/requests/${requestId}`, { approve: true, ...(scopes ? { scopes } : {}) });
  const back = new URL(approved.body.redirect);
  const tokenResponse = await fetch(`${base}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: 'http://127.0.0.1:61999/callback',
      client_id: registered.client_id, code_verifier: verifier, resource: `${base}/api/mcp/workspace`
    })
  });
  return { registered, shown: shown.body, back, tokens: await tokenResponse.json(), status: tokenResponse.status, app };
}

/** The diagram as the app sends it once it made "add a Cache, connect Web to it". */
const withCache = (diagram) => ({
  ...diagram,
  items: [...diagram.items, { id: 'cache', name: 'Cache' }],
  views: diagram.views.map((view) => ({
    ...view,
    items: [...view.items, { id: 'cache', tile: { x: 2, y: 0 } }],
    connectors: [...(view.connectors || []), { id: 'c1', anchors: [{ id: 'a1', ref: { item: 'web' } }, { id: 'a2', ref: { item: 'cache' } }] }]
  }))
});

const DIAGRAM = {
  name: 'Network', title: 'Network', icons: [{ id: 'db', name: 'Database', url: 'x' }], colors: [],
  items: [{ id: 'web', name: 'Web' }],
  views: [{ id: 'p1', name: 'Page 1', items: [{ id: 'web', tile: { x: 0, y: 0 } }], connectors: [] }]
};

test('discovery: the MCP server points at Axoview\'s OAuth server, which says what it supports', async () => {
  const { base } = await startServer();
  const unauthenticated = await mcpClient(base).rpc('tools/list');
  expect(unauthenticated.status).toBe(401);
  expect(unauthenticated.auth).toBe(
    `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp/workspace", scope="diagrams:read diagrams:propose"`
  );
  const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/api/mcp/workspace`)).json();
  expect(resource).toMatchObject({ resource: `${base}/api/mcp/workspace`, authorization_servers: [`${base}/api/oauth`] });
  for (const url of [
    `${base}/.well-known/oauth-authorization-server/api/oauth`,
    `${base}/.well-known/openid-configuration/api/oauth`,
    `${base}/api/oauth/.well-known/openid-configuration`
  ]) {
    const metadata = await (await fetch(url)).json();
    expect(metadata).toMatchObject({
      issuer: `${base}/api/oauth`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      registration_endpoint: `${base}/api/oauth/register`
    });
  }
}, T);

test('the whole way: consent, token, read, propose; the person approves in the app; the agent sees it', async () => {
  const { base } = await startServer();
  const { app, shown, back, tokens, status } = await connect(base);
  expect(shown).toMatchObject({ clientName: 'Claude Code', redirectHost: '127.0.0.1:61999', loopback: true, scopes: ['diagrams:read', 'diagrams:propose'] });
  // Loopback redirect: any port, the code comes back with state and iss (RFC 9207).
  expect(back.origin).toBe('http://127.0.0.1:61999');
  expect(back.searchParams.get('state')).toBe('xyz');
  expect(back.searchParams.get('iss')).toBe(`${base}/api/oauth`);
  expect(status).toBe(200);
  expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'diagrams:read diagrams:propose' });

  const created = await app.post('/api/diagrams', DIAGRAM);
  const id = created.body.id;
  const agent = mcpClient(base, tokens.access_token);
  const listed = await agent.call('list_diagrams');
  expect(listed.body.result.structuredContent.diagrams).toEqual([
    expect.objectContaining({ id, name: 'Network', access: 'owner', canPropose: true })
  ]);
  const read = await agent.call('read_diagram', { id });
  expect(read.body.result.content[0].text).toMatch(/^The diagram content below is user-authored data/);
  expect(read.body.result.structuredContent.description.nodes).toEqual([{ id: 'web', name: 'Web' }]);

  const hears = await listen(base, 'alice-1', 600);
  const proposed = await agent.call('propose_changes', {
    id, note: 'Add a cache',
    operations: [{ op: 'add_node', name: 'Cache', icon: 'database' }, { op: 'connect', from: { name: 'Web' }, to: { name: 'Cache' } }]
  });
  const pid = proposed.body.result.structuredContent.proposal.id;
  // Live notice in the person's open Axoview tabs: who proposes how much, where.
  expect((await hears.stop()).find((e) => e.kind === 'proposal')).toMatchObject({
    action: 'create', id, proposal: pid, agent: 'Claude Code', steps: 2, diagramName: 'Network'
  });
  expect(proposed.body.result.content[0].text).toMatch(/Nothing has changed yet/);
  // Nothing changed; the person sees it, with its operations, for their app to check.
  expect((await app.get(`/api/diagrams/${id}`)).body.items).toHaveLength(1);
  const waiting = (await app.get(`/api/diagrams/${id}/proposals`)).body.proposals;
  expect(waiting).toEqual([expect.objectContaining({
    id: pid, by: { sub: 'alice-1', agent: 'Claude Code' }, viewId: 'p1', note: 'Add a cache',
    operations: [{ op: 'add_node', name: 'Cache', icon: 'database' }, { op: 'connect', from: { name: 'Web' }, to: { name: 'Cache' } }]
  })]);
  expect((await agent.call('get_proposal', { id, proposal: pid })).body.result.structuredContent.status).toBe('pending');

  // Approving is saving: the app sends the diagram with both steps made and
  // the state it built that on.
  const loaded = (await app.get(`/api/diagrams/${id}`)).body;
  const approved = await app.post(`/api/diagrams/${id}/proposals/${pid}/approve`, {
    applied: 2, document: withCache(loaded), baseModified: loaded.lastModified
  });
  expect(approved.status).toBe(200);
  expect(approved.body.proposal).toMatchObject({ status: 'approved', applied: 2, resolvedBy: 'alice-1' });
  const after = await agent.call('get_proposal', { id, proposal: pid });
  expect(after.body.result.structuredContent).toEqual({ id: pid, status: 'approved', steps: 2, applied: 2 });
  // And the agent reads its own change back.
  const reread = (await agent.call('read_diagram', { id })).body.result.structuredContent.description;
  expect(reread.nodes.map((n) => n.name).sort()).toEqual(['Cache', 'Web']);
}, T);

test('an agent sees "approved" only after the diagram is saved', async () => {
  const { base } = await startServer();
  const { tokens, app } = await connect(base);
  const id = (await app.post('/api/diagrams', DIAGRAM)).body.id;
  const agent = mcpClient(base, tokens.access_token);
  const propose = async () => (await agent.call('propose_changes', {
    id, operations: [{ op: 'add_node', name: 'Cache' }]
  })).body.result.structuredContent.proposal.id;
  const statusOf = async (pid) => (await agent.call('get_proposal', { id, proposal: pid })).body.result.structuredContent.status;
  const diagram = async () => (await app.get(`/api/diagrams/${id}`)).body;
  const approve = (pid, body) => app.post(`/api/diagrams/${id}/proposals/${pid}/approve`, body);
  const pid = await propose();
  const loaded = await diagram();

  // No diagram, or no word on what it was built on: refused, still waiting, nothing stored.
  expect((await approve(pid, { applied: 1 })).status).toBe(400);
  expect((await approve(pid, { applied: 1, document: withCache(loaded) })).status).toBe(428);
  expect(await statusOf(pid)).toBe('pending');
  expect(await diagram()).toEqual(loaded);

  // The diagram changed after the app loaded it (another device saved): the
  // approval is refused, the other device's save is kept, the proposal waits.
  await app.put(`/api/diagrams/${id}`, { ...DIAGRAM, title: 'Renamed elsewhere' });
  const elsewhere = await diagram();
  const stale = await approve(pid, { applied: 1, document: withCache(loaded), baseModified: loaded.lastModified });
  expect(stale.status).toBe(409);
  expect(await statusOf(pid)).toBe('pending');
  expect((await app.get(`/api/diagrams/${id}/proposals`)).body.proposals.map((p) => p.id)).toEqual([pid]);
  expect(await diagram()).toEqual(elsewhere);

  // Built on the current state: stored first, then recorded.
  const done = await approve(pid, { applied: 1, document: withCache(elsewhere), baseModified: elsewhere.lastModified });
  expect(done.status).toBe(200);
  expect(done.body.proposal.status).toBe('approved');
  const saved = await diagram();
  expect(saved.title).toBe('Renamed elsewhere');
  expect(saved.items.map((item) => item.name)).toEqual(['Web', 'Cache']);
  expect(done.body.lastModified).toBe(saved.lastModified);
  expect(await statusOf(pid)).toBe('approved');

  // The answer was lost and the app asks again: the recorded approval comes back, nothing is saved twice.
  const again = await approve(pid, { applied: 1, document: withCache(elsewhere), baseModified: elsewhere.lastModified });
  expect(again.status).toBe(200);
  expect(again.body.proposal).toEqual(done.body.proposal);
  expect(await diagram()).toEqual(saved);
  // A decision is final.
  const late = await app.post(`/api/diagrams/${id}/proposals/${pid}/reject`, {});
  expect(late.status).toBe(409);
  expect(late.body.reason).toBe('already-decided');
  const rejected = await propose();
  expect((await app.post(`/api/diagrams/${id}/proposals/${rejected}/reject`, {})).body.proposal.status).toBe('rejected');
  const refused = await approve(rejected, { applied: 1, document: withCache(saved), baseModified: saved.lastModified });
  expect(refused.status).toBe(409);
  expect(await diagram()).toEqual(saved);
}, T);

test('approvals of one diagram arriving together: each proposal is approved only if its save went in', async () => {
  const { base } = await startServer();
  const { tokens, app } = await connect(base);
  const id = (await app.post('/api/diagrams', DIAGRAM)).body.id;
  const agent = mcpClient(base, tokens.access_token);
  // Six agents' proposals made at the same moment: none is lost.
  const pids = (await Promise.all(Array.from({ length: 6 }, (_, i) =>
    agent.call('propose_changes', { id, operations: [{ op: 'add_node', name: `Node ${i}` }] }))))
    .map((r) => r.body.result.structuredContent.proposal.id);
  expect(new Set(pids).size).toBe(6);
  expect((await app.get(`/api/diagrams/${id}/proposals`)).body.proposals.map((p) => p.id).sort()).toEqual([...pids].sort());

  // Six windows approve one each, all built on the same state.
  const loaded = (await app.get(`/api/diagrams/${id}`)).body;
  const answers = await Promise.all(pids.map((pid, i) => app.post(`/api/diagrams/${id}/proposals/${pid}/approve`, {
    applied: 1,
    document: { ...loaded, items: [...loaded.items, { id: `n${i}`, name: `Node ${i}` }] },
    baseModified: loaded.lastModified
  })));
  expect(answers.map((a) => a.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
  const winner = answers.findIndex((a) => a.status === 200);
  const saved = (await app.get(`/api/diagrams/${id}`)).body;
  expect(saved.items.map((item) => item.name)).toEqual(['Web', `Node ${winner}`]);
  for (const [i, pid] of pids.entries()) {
    const status = (await agent.call('get_proposal', { id, proposal: pid })).body.result.structuredContent.status;
    expect(status).toBe(i === winner ? 'approved' : 'pending');
  }
}, T);

test('never above its person: read-only consent, a Read only diagram, someone else\'s diagram', async () => {
  const { base } = await startServer();
  const bob = person(base, 'bob-2');
  const bobs = (await bob.post('/api/diagrams', DIAGRAM)).body.id;
  const shared = (await bob.post('/api/diagrams', { ...DIAGRAM, name: 'Shared' })).body.id;
  await bob.post(`/api/diagrams/${shared}/members`, { email: 'alice@example.com', role: 'viewer' });

  // Alice lets this client read only.
  const { tokens } = await connect(base, { scopes: [] });
  expect(tokens.scope).toBe('diagrams:read');
  const agent = mcpClient(base, tokens.access_token);
  const listed = (await agent.call('list_diagrams')).body.result.structuredContent.diagrams;
  expect(listed).toEqual([expect.objectContaining({ id: shared, access: 'viewer', canPropose: false, ownerEmail: 'bob@example.com' })]);
  expect((await agent.call('read_diagram', { id: shared })).body.result.structuredContent.description.nodes).toHaveLength(1);
  expect((await agent.call('read_diagram', { id: bobs })).body.result.isError).toBe(true);

  const refused = await agent.call('propose_changes', { id: shared, operations: [{ op: 'add_node', name: 'X' }] });
  expect(refused.status).toBe(403);
  expect(refused.auth).toMatch(/error="insufficient_scope", scope="diagrams:read diagrams:propose"/);

  // With propose granted, a Read only diagram still refuses.
  const full = mcpClient(base, (await connect(base)).tokens.access_token);
  const readOnly = await full.call('propose_changes', { id: shared, operations: [{ op: 'add_node', name: 'X' }] });
  expect(readOnly.body.result).toMatchObject({ isError: true });
  expect(readOnly.body.result.content[0].text).toMatch(/Read only/);
  expect((await bob.get(`/api/diagrams/${shared}/proposals`)).body.proposals).toEqual([]);
}, T);

test('tokens: PKCE, single-use codes, the resource, refresh rotation, disconnecting', async () => {
  const { base } = await startServer();
  const registered = await (await fetch(`${base}/api/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Codex', redirect_uris: [REDIRECT] })
  })).json();
  const { challenge } = pkce();
  const authorize = (params) => {
    const url = new URL(`${base}/api/oauth/authorize`);
    Object.entries({
      response_type: 'code', client_id: registered.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
      code_challenge_method: 'S256', resource: `${base}/api/mcp/workspace`, ...params
    }).forEach(([k, v]) => v !== undefined && url.searchParams.set(k, v));
    return fetch(url, { redirect: 'manual' });
  };
  // An unregistered redirect is shown an error, never redirected to.
  const evil = await authorize({ redirect_uri: 'https://evil.example/cb' });
  expect(evil.status).toBe(400);
  // A token for another resource is refused at the authorization step.
  const other = new URL((await authorize({ resource: 'https://other.example/mcp' })).headers.get('location'));
  expect(other.searchParams.get('error')).toBe('invalid_target');
  expect((await authorize({ code_challenge_method: 'plain' })).headers.get('location')).toMatch(/error=invalid_request/);

  const { tokens, registered: client, app } = await connect(base, { clientName: 'Codex' });
  // Refresh: a new pair, and the old refresh token stops working.
  const refresh = (token) => fetch(`${base}/api/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', refresh_token: token, client_id: client.client_id })
  });
  const rotated = await (await refresh(tokens.refresh_token)).json();
  expect(rotated.access_token).toBeTruthy();
  expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
  expect((await (await refresh(tokens.refresh_token)).json()).error).toBe('invalid_grant');

  // The person sees the client, narrows it, then disconnects it: every token stops.
  const grants = (await app.get('/api/oauth/grants')).body.grants;
  expect(grants).toEqual([expect.objectContaining({ clientName: 'Codex', scopes: ['diagrams:read', 'diagrams:propose'], redirectHost: '127.0.0.1:61999' })]);
  expect((await app.patch(`/api/oauth/grants/${grants[0].id}`, { scopes: [] })).body.grant.scopes).toEqual(['diagrams:read']);
  const agent = mcpClient(base, rotated.access_token);
  expect((await agent.call('propose_changes', { id: 'x', operations: [{ op: 'add_node', name: 'X' }] })).status).toBe(403);
  expect((await person(base, 'bob-2').get('/api/oauth/grants')).body.grants).toEqual([]);
  expect((await app.del(`/api/oauth/grants/${grants[0].id}`)).status).toBe(200);
  expect((await agent.call('list_diagrams')).status).toBe(401);
  expect((await (await refresh(rotated.refresh_token)).json()).error).toBe('invalid_grant');
  // A Cognito session is not an MCP token.
  expect((await mcpClient(base, 'test-user:alice-1').call('list_diagrams')).status).toBe(401);
}, T);

test('denying sends the client access_denied; off unless AI_MCP_ENABLED', async () => {
  const { base } = await startServer();
  const registered = await (await fetch(`${base}/api/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Gemini CLI', redirect_uris: [REDIRECT] })
  })).json();
  const url = new URL(`${base}/api/oauth/authorize`);
  Object.entries({
    response_type: 'code', client_id: registered.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge,
    code_challenge_method: 'S256', resource: `${base}/api/mcp/workspace`, state: 's1'
  }).forEach(([k, v]) => url.searchParams.set(k, v));
  const requestId = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')).searchParams.get('request');
  const denied = await person(base, 'alice-1').post(`/api/oauth/requests/${requestId}`, { approve: false });
  expect(new URL(denied.body.redirect).searchParams.get('error')).toBe('access_denied');
  // A request is used once.
  expect((await person(base, 'alice-1').get(`/api/oauth/requests/${requestId}`)).status).toBe(404);

  const off = await startServer({ mcp: false });
  expect((await fetch(`${off.base}/.well-known/oauth-authorization-server/api/oauth`)).status).toBe(404);
  expect((await mcpClient(off.base, 'x').rpc('tools/list')).status).toBe(404);
}, T);

test('one-time credentials cannot be reused by concurrent attempts: consent, code, refresh token', async () => {
  const { base } = await startServer();
  const app = person(base, 'alice-1');
  const registered = await (await fetch(`${base}/api/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Racer', redirect_uris: [REDIRECT] })
  })).json();
  const { verifier, challenge } = pkce();
  const url = new URL(`${base}/api/oauth/authorize`);
  Object.entries({
    response_type: 'code', client_id: registered.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: 'S256', resource: `${base}/api/mcp/workspace`, state: 's'
  }).forEach(([k, v]) => url.searchParams.set(k, v));
  const requestId = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')).searchParams.get('request');
  const together = (n, attempt) => Promise.all(Array.from({ length: n }, () => attempt()));

  // Twelve approvals of one consent request at once: one answers it, with one code.
  const approvals = await together(12, () => app.post(`/api/oauth/requests/${requestId}`, { approve: true }));
  const answered = approvals.filter((r) => r.status === 200);
  expect(answered).toHaveLength(1);
  expect(approvals.filter((r) => r.status === 404)).toHaveLength(11);
  const code = new URL(answered[0].body.redirect).searchParams.get('code');

  // Twelve exchanges of that code at once: one pair of tokens.
  const exchange = () => fetch(`${base}/api/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: registered.client_id, code_verifier: verifier })
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const exchanges = await together(12, exchange);
  const issued = exchanges.filter((r) => r.status === 200);
  expect(issued).toHaveLength(1);
  expect(exchanges.filter((r) => r.body.error === 'invalid_grant')).toHaveLength(11);

  // Twelve refreshes with that refresh token at once: one rotation.
  const refresh = () => fetch(`${base}/api/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', refresh_token: issued[0].body.refresh_token, client_id: registered.client_id })
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const refreshes = await together(12, refresh);
  const rotated = refreshes.filter((r) => r.status === 200);
  expect(rotated).toHaveLength(1);
  expect(refreshes.filter((r) => r.body.error === 'invalid_grant')).toHaveLength(11);
  // The one new pair works; the old refresh token never does again.
  expect((await mcpClient(base, rotated[0].body.access_token).call('list_diagrams')).status).toBe(200);
  expect((await refresh()).body.error).toBe('invalid_grant');
}, T);
