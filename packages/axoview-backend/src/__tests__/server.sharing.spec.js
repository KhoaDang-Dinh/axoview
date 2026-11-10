/**
 * Sharing a diagram by email, through the REAL server.js (child process, fs
 * storage) with two signed-in people. Cognito is faked by module hooks
 * (helpers/fakeCognito.hooks.mjs): the token "test-user:<sub>" is that person,
 * and the accounts come from FAKE_COGNITO_ACCOUNTS.
 *
 * Covers what the unit tests (sharing.spec.js) cannot: the shared diagram is
 * listed on the other side, loads and saves through the owner's workspace,
 * owner-only actions are refused, both people's sync streams hear the save,
 * and the X-Axoview-Shared header tells the app to upload at once.
 */
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createFsAdapter } from '../adapters/fs.js';
import { addWorkspaceScope } from '../adapters/workspace.js';
import { createSharing } from '../sharing.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '../../server.js');
const HOOKS = path.resolve(HERE, 'helpers/fakeCognito.register.mjs');
const T = 60000;

const ACCOUNTS = [
  { sub: 'alice-1', email: 'alice@example.com', email_verified: true },
  { sub: 'bob-2', email: 'bob@example.com', email_verified: true },
  { sub: 'carol-4', email: 'carol@example.com', email_verified: true },
  { sub: 'mallory-3', email: 'unverified@example.com', email_verified: false }
];

let nextPort = 3610;
const running = [];
let dir;

async function startServer() {
  const port = nextPort++;
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
      FAKE_COGNITO_ACCOUNTS: JSON.stringify(ACCOUNTS)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  running.push(child);
  const base = `http://127.0.0.1:${port}`;
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axoview-sharing-'));
});
afterEach(async () => {
  for (const c of running.splice(0)) c.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

/** A client acting as one person. */
function as(base, sub) {
  const call = async (method, pathname, body) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { authorization: `Bearer test-user:${sub}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
    /** The change events this person's sync stream delivers within `ms`. */
    async listen(ms) {
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
              const event = /^event: (.*)$/m.exec(frame)?.[1];
              const data = /^data: (.*)$/m.exec(frame)?.[1];
              if (event === 'change' && data) events.push(JSON.parse(data));
            }
          }
        } catch { /* aborted */ }
      })();
      return {
        events,
        async stop() {
          await new Promise((r) => setTimeout(r, ms));
          controller.abort();
          await done;
          return events;
        }
      };
    }
  };
}

const DIAGRAM = { name: 'Network', title: 'Network', items: [], views: [{ id: 'p1', name: 'Page 1', items: [] }], icons: [], colors: [] };

async function aliceWithADiagram(base) {
  const alice = as(base, 'alice-1');
  const created = await alice.post('/api/diagrams', DIAGRAM);
  expect(created.status).toBe(201);
  return { alice, id: created.body.id };
}

test('Full admin: alice shares with bob by email; bob sees it, opens it, saves it; alice gets the change', async () => {
  const { base } = await startServer();
  const { alice, id } = await aliceWithADiagram(base);
  const bob = as(base, 'bob-2');

  expect((await bob.get(`/api/diagrams/${id}`)).status).toBe(404);
  const bobHears = await bob.listen(600);
  const added = await alice.post(`/api/diagrams/${id}/members`, { email: 'Bob@Example.com', role: 'admin' });
  expect(added.status).toBe(201);
  expect(added.body.member).toEqual({ sub: 'bob-2', email: 'bob@example.com', role: 'admin', addedAt: expect.any(String) });
  // bob's explorer hears about it at once.
  expect((await bobHears.stop()).map((e) => [e.kind, e.action, e.id])).toContainEqual(['diagram', 'create', id]);

  const listed = (await bob.get('/api/diagrams')).body;
  expect(listed).toEqual([expect.objectContaining({ id, name: 'Network', shared: { role: 'admin', ownerEmail: 'alice@example.com' } })]);

  const opened = await bob.get(`/api/diagrams/${id}`);
  expect(opened.status).toBe(200);
  expect(opened.body.name).toBe('Network');
  expect(opened.headers.get('x-axoview-shared')).toBe('with-you');
  expect(opened.headers.get('x-axoview-role')).toBe('admin');
  expect((await alice.get(`/api/diagrams/${id}`)).headers.get('x-axoview-shared')).toBe('by-you');

  const aliceHears = await alice.listen(800);
  const saved = await bob.put(`/api/diagrams/${id}`, { ...opened.body, items: [{ id: 'n1' }] });
  expect(saved.status).toBe(200);
  const heard = await aliceHears.stop();
  expect(heard.map((e) => [e.kind, e.action, e.id])).toContainEqual(['diagram', 'save', id]);
  expect((await alice.get(`/api/diagrams/${id}`)).body.items).toEqual([{ id: 'n1' }]);
  // Saved into alice's workspace, not a copy in bob's.
  expect((await bob.get('/api/diagrams')).body).toHaveLength(1);
}, T);

test('Read only: bob can open it and nothing else', async () => {
  const { base } = await startServer();
  const { alice, id } = await aliceWithADiagram(base);
  const bob = as(base, 'bob-2');
  await alice.post(`/api/diagrams/${id}/members`, { email: 'bob@example.com' });

  const opened = await bob.get(`/api/diagrams/${id}`);
  expect(opened.status).toBe(200);
  expect(opened.headers.get('x-axoview-role')).toBe('viewer');
  expect((await bob.put(`/api/diagrams/${id}`, { ...opened.body, items: [{ id: 'x' }] })).body).toMatchObject({ reason: 'view-only' });
  expect((await bob.patch(`/api/diagrams/${id}`, { name: 'Mine now' })).status).toBe(403);
  expect((await bob.del(`/api/diagrams/${id}`)).status).toBe(403);
  expect((await bob.post(`/api/diagrams/${id}/share`)).status).toBe(403);
  expect((await bob.get(`/api/diagrams/${id}/members`)).status).toBe(404);
  expect((await bob.post(`/api/diagrams/${id}/members`, { email: 'carol@example.com' })).status).toBe(404);
  expect((await alice.get(`/api/diagrams/${id}`)).body).toMatchObject({ name: 'Network', items: [] });
}, T);

test('Full admin has the owner\'s powers: manage people, rename, publish, delete; not the owner\'s folders', async () => {
  const { base } = await startServer();
  const { alice, id } = await aliceWithADiagram(base);
  const bob = as(base, 'bob-2');
  const carol = as(base, 'carol-4');
  await alice.post(`/api/diagrams/${id}/members`, { email: 'bob@example.com', role: 'admin' });

  expect((await bob.post(`/api/diagrams/${id}/members`, { email: 'carol@example.com' })).status).toBe(201);
  expect((await bob.get(`/api/diagrams/${id}/members`)).body.members.map((m) => [m.email, m.role]))
    .toEqual([['bob@example.com', 'admin'], ['carol@example.com', 'viewer']]);
  expect((await bob.patch(`/api/diagrams/${id}/members/carol-4`, { role: 'admin' })).body.member.role).toBe('admin');
  expect((await carol.get(`/api/diagrams/${id}`)).headers.get('x-axoview-role')).toBe('admin');
  expect((await bob.post(`/api/diagrams/${id}/members`, { email: 'alice@example.com' })).body).toMatchObject({ reason: 'self' });

  expect((await bob.patch(`/api/diagrams/${id}`, { name: 'Renamed by bob' })).status).toBe(200);
  expect((await alice.get('/api/diagrams')).body[0].name).toBe('Renamed by bob');
  expect((await bob.post(`/api/diagrams/${id}/share`)).status).toBe(200);
  expect((await bob.patch(`/api/diagrams/${id}/move`, { targetFolderId: null })).body).toMatchObject({ reason: 'owner-folders' });

  expect((await bob.del(`/api/diagrams/${id}`)).status).toBe(200);
  expect((await alice.get(`/api/diagrams/${id}`)).status).toBe(404);
  expect((await carol.get('/api/diagrams')).body).toEqual([]);
}, T);

test('an agent works on its person\'s account: the person sets its level once, never above approval', async () => {
  const { base } = await startServer();
  const alice = as(base, 'alice-1');
  expect((await alice.get('/api/agent')).body).toEqual({ level: 'viewer' });
  expect((await alice.put('/api/agent', { level: 'proposer' })).body).toEqual({ level: 'proposer' });
  expect((await alice.get('/api/agent')).body).toEqual({ level: 'proposer' });
  expect((await alice.put('/api/agent', { level: 'admin' })).body).toMatchObject({ reason: 'invalid-level' });
  expect((await as(base, 'bob-2').get('/api/agent')).body).toEqual({ level: 'viewer' });
  expect((await fetch(`${base}/api/agent`)).status).toBe(401);
}, T);

test('an agent\'s proposal waits for its own person, not the owner; approving saves it for everyone', async () => {
  const { base } = await startServer();
  const { alice, id } = await aliceWithADiagram(base);
  const bob = as(base, 'bob-2');
  await alice.post(`/api/diagrams/${id}/members`, { email: 'bob@example.com', role: 'admin' });
  // Made the way an agent signed in through the API will (ADR 0052 MCP sign-in).
  const store = createSharing({ adapterFor: (ws) => addWorkspaceScope(createFsAdapter(dir)).forWorkspace(ws), findUserByEmail: async () => null });
  const first = await store.propose('alice-1', id, { sub: 'bob-2', agent: 'claude-code' }, { ...DIAGRAM, items: [{ id: 'from-agent' }] });
  const second = await store.propose('alice-1', id, { sub: 'bob-2', agent: 'claude-code' }, { ...DIAGRAM, items: [] });

  expect((await alice.get(`/api/diagrams/${id}/proposals`)).body.proposals).toEqual([]);
  expect((await alice.post(`/api/diagrams/${id}/proposals/${first.id}/approve`, {})).status).toBe(404);
  expect((await bob.get(`/api/diagrams/${id}/proposals`)).body.proposals.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());

  const aliceHears = await alice.listen(700);
  const approved = await bob.post(`/api/diagrams/${id}/proposals/${first.id}/approve`, {});
  expect(approved.body.proposal).toMatchObject({ status: 'approved', resolvedBy: 'bob-2', by: { sub: 'bob-2', agent: 'claude-code' } });
  expect((await aliceHears.stop()).map((e) => [e.kind, e.action, e.id])).toContainEqual(['diagram', 'save', id]);
  expect((await alice.get(`/api/diagrams/${id}`)).body.items).toEqual([{ id: 'from-agent' }]);

  // The second was made before that save: stale, so bob must insist. Rejecting needs no insisting.
  expect((await bob.post(`/api/diagrams/${id}/proposals/${second.id}/approve`, {})).body).toMatchObject({ reason: 'stale' });
  expect((await bob.post(`/api/diagrams/${id}/proposals/${second.id}/reject`, {})).body.proposal.status).toBe('rejected');
  expect((await bob.get(`/api/diagrams/${id}/proposals`)).body.proposals).toEqual([]);

  // Read only on the diagram: bob (and so his agent) may no longer change it.
  const third = await store.propose('alice-1', id, { sub: 'bob-2', agent: 'claude-code' }, DIAGRAM);
  await alice.patch(`/api/diagrams/${id}/members/bob-2`, { role: 'viewer' });
  expect((await bob.get(`/api/diagrams/${id}/proposals`)).status).toBe(404);
  expect((await bob.post(`/api/diagrams/${id}/proposals/${third.id}/approve`, { force: true })).status).toBe(404);
}, T);

test('the red cases: no account, unverified, already shared, yourself', async () => {
  const { base } = await startServer();
  const { alice, id } = await aliceWithADiagram(base);
  const add = (email) => alice.post(`/api/diagrams/${id}/members`, { email });

  expect((await add('nobody@example.com')).body).toMatchObject({ reason: 'no-account', error: 'No Axoview account uses that email' });
  expect((await add('unverified@example.com')).body).toMatchObject({ reason: 'no-account' });
  expect((await add('bob@example.com')).status).toBe(201);
  expect((await add('bob@example.com')).body).toMatchObject({ reason: 'already-shared', error: 'Already shared with bob@example.com' });
  expect((await add('alice@example.com')).body).toMatchObject({ reason: 'self' });
  expect((await alice.post(`/api/diagrams/${id}/members`, { email: 'carol@example.com', role: 'owner' })).body).toMatchObject({ reason: 'invalid-role' });
  expect((await alice.post(`/api/diagrams/${id}/members`, { email: 'carol@example.com', role: 'proposer' })).body).toMatchObject({ reason: 'invalid-role' });
  expect((await alice.get(`/api/diagrams/${id}/members`)).body.members.map((m) => m.email)).toEqual(['bob@example.com']);
}, T);

test('removing bob takes the diagram away from him', async () => {
  const { base } = await startServer();
  const { alice, id } = await aliceWithADiagram(base);
  const bob = as(base, 'bob-2');
  await alice.post(`/api/diagrams/${id}/members`, { email: 'bob@example.com' });
  expect((await bob.get(`/api/diagrams/${id}`)).status).toBe(200);

  const bobHears = await bob.listen(600);
  expect((await alice.del(`/api/diagrams/${id}/members/bob-2`)).status).toBe(200);
  expect((await bobHears.stop()).map((e) => [e.action, e.id])).toContainEqual(['delete', id]);
  expect((await bob.get('/api/diagrams')).body).toEqual([]);
  // At once on the API process that removed him (it updates its cache);
  // other API processes within their 10 s cache (src/sharing.js CACHE_MS).
  expect((await bob.get(`/api/diagrams/${id}`)).status).toBe(404);
}, T);

test('an unshared diagram gets no X-Axoview-Shared header', async () => {
  const { base } = await startServer();
  const { alice, id } = await aliceWithADiagram(base);
  expect((await alice.get(`/api/diagrams/${id}`)).headers.get('x-axoview-shared')).toBeNull();
}, T);
