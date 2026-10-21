/**
 * Realtime multi-device sync, end to end on the real server.js (fs adapter,
 * memory cursor): a write on one "device" reaches another device's open
 * /api/sync/events stream, tagged with the writer's device id, and a stream
 * resuming from an old event id is told to resync.
 */
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '../../server.js');
const T = 60000;

let nextPort = 3560;
const running = [];
let dir;

async function startServer() {
  const port = nextPort++;
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      BACKEND_PORT: String(port),
      STORAGE_PATH: dir,
      ENABLE_SERVER_STORAGE: 'true',
      AUTH_MODE: 'none',
      SYNC_HEARTBEAT_MS: '500'
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
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return { base, port };
}

/** Open a stream and collect its text until `stop()`. */
function openStream(port, headers = {}) {
  let text = '';
  let req;
  const ready = new Promise((resolve, reject) => {
    req = http.get({ host: '127.0.0.1', port, path: '/api/sync/events', headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      resolve(res);
    });
    req.on('error', reject);
  });
  return {
    ready,
    text: () => text,
    stop: () => req.destroy()
  };
}

async function until(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axoview-sync-'));
});
afterEach(async () => {
  for (const c of running.splice(0)) c.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a save on one device reaches the other device\'s stream', async () => {
  const { base, port } = await startServer();
  const stream = openStream(port);
  const res = await stream.ready;
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
  expect(res.headers['cache-control']).toContain('no-transform');
  await until(() => stream.text().includes('event: ready'));

  const created = await fetch(`${base}/api/diagrams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Axoview-Device': 'laptop-0001' },
    body: JSON.stringify({ name: 'Sync', items: [] })
  });
  const { id } = await created.json();
  await fetch(`${base}/api/diagrams/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Axoview-Device': 'phone-0002' },
    body: JSON.stringify({ name: 'Sync', items: [{ id: 'n1' }] })
  });

  await until(() => stream.text().includes('"action":"save"'));
  const changes = stream.text()
    .split('\n\n')
    .filter((f) => f.includes('event: change'))
    .map((f) => JSON.parse(f.split('\n').find((l) => l.startsWith('data: ')).slice(6)));
  expect(changes).toEqual([
    expect.objectContaining({ seq: 1, kind: 'diagram', action: 'create', id, origin: 'laptop-0001' }),
    expect.objectContaining({ seq: 2, kind: 'diagram', action: 'save', id, origin: 'phone-0002' })
  ]);

  await until(() => stream.text().includes(': ping'), 3000);
  stream.stop();
}, T);

test('a stream resuming from an old event id is told to resync', async () => {
  const { base, port } = await startServer();
  await fetch(`${base}/api/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'F' })
  });
  await fetch(`${base}/api/tree-manifest`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, order: {} })
  });
  const stream = openStream(port, { 'Last-Event-ID': '0' });
  await stream.ready;
  await until(() => stream.text().includes('"kind":"resync"'));
  stream.stop();
}, T);

test('the stream answers 503 while server storage is off', async () => {
  const port = nextPort++;
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, NODE_OPTIONS: '', BACKEND_PORT: String(port), STORAGE_PATH: dir, ENABLE_SERVER_STORAGE: 'false', AUTH_MODE: 'none' },
    stdio: 'ignore'
  });
  running.push(child);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${base}/healthz`)).status === 200) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error('no server');
    await new Promise((r) => setTimeout(r, 120));
  }
  expect((await fetch(`${base}/api/sync/events`)).status).toBe(503);
}, T);

test('SIGTERM ends open streams at once, refuses new ones, then exits', async () => {
  const port = nextPort++;
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, NODE_OPTIONS: '', BACKEND_PORT: String(port), STORAGE_PATH: dir,
      ENABLE_SERVER_STORAGE: 'true', AUTH_MODE: 'none',
      SHUTDOWN_DRAIN_MS: '800', SHUTDOWN_FORCE_MS: '2000'
    },
    stdio: 'ignore'
  });
  running.push(child);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${base}/healthz`)).status === 200) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error('no server');
    await new Promise((r) => setTimeout(r, 120));
  }
  const stream = openStream(port);
  const res = await stream.ready;
  await until(() => stream.text().includes('event: ready'));
  const ended = new Promise((resolve) => res.on('end', resolve));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  const signalled = Date.now();
  child.kill('SIGTERM');
  await ended;
  expect(Date.now() - signalled).toBeLessThan(1000);

  // Draining: ordinary requests still answered, new streams refused.
  expect((await fetch(`${base}/healthz`)).status).toBe(200);
  expect((await fetch(`${base}/api/sync/events`)).status).toBe(503);

  expect(await exited).toBe(0);
  expect(Date.now() - signalled).toBeLessThan(4000);
}, T);
