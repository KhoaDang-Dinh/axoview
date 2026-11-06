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

async function startServer(extraEnv = {}) {
  const port = nextPort++;
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      BACKEND_PORT: String(port),
      STORAGE_PATH: dir,
      ENABLE_SERVER_STORAGE: 'true',
      AUTH_MODE: 'none',
      SYNC_HEARTBEAT_MS: '500',
      ...extraEnv
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
  return { base, port, child, logs };
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

test('a stream resuming a few changes behind replays each of them (the queue)', async () => {
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
  await until(() => stream.text().includes('"kind":"tree"'));
  expect(stream.text()).not.toContain('resync');
  const frames = stream.text().split('\n\n').filter((f) => f.includes('event: change'));
  expect(frames.map((f) => JSON.parse(f.split('\n').find((l) => l.startsWith('data: ')).slice(6))))
    .toEqual([
      expect.objectContaining({ seq: 1, kind: 'folder', action: 'create' }),
      expect.objectContaining({ seq: 2, kind: 'tree', action: 'save' })
    ]);
  stream.stop();
}, T);

test('a stream ahead of the server (a restarted server, a rebuilt table) is told to resync', async () => {
  const { base, port } = await startServer();
  await fetch(`${base}/api/folders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'F' })
  });
  const stream = openStream(port, { 'Last-Event-ID': '99' });
  await stream.ready;
  await until(() => stream.text().includes('"kind":"resync"'));
  stream.stop();
}, T);

test('a burst of writes inside one poll arrives as each change, a delete included', async () => {
  const { base, port } = await startServer({ SYNC_POLL_MS: '1500' });
  const stream = openStream(port);
  await stream.ready;
  await until(() => stream.text().includes('event: ready'));
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const { id } = await (await fetch(`${base}/api/diagrams`, json('POST', { name: 'A', items: [] }))).json();
  await fetch(`${base}/api/diagrams/${id}`, json('PUT', { name: 'A', items: [{ id: 'n1' }] }));
  await fetch(`${base}/api/diagrams/${id}`, { method: 'DELETE' });
  await until(() => stream.text().includes('"action":"delete"'), 6000);
  const frames = stream.text().split('\n\n').filter((f) => f.includes('event: change'));
  const changes = frames.map((f) => JSON.parse(f.split('\n').find((l) => l.startsWith('data: ')).slice(6)));
  expect(changes.map((c) => [c.seq, c.action])).toEqual([[1, 'create'], [2, 'save'], [3, 'delete']]);
  expect(stream.text()).not.toContain('resync');
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

// --- The stream's contract, piece by piece --------------------------------------------

/** The change events in a stream's text, parsed. */
function changesIn(text) {
  return text
    .split('\n\n')
    .filter((f) => f.includes('event: change'))
    .map((f) => JSON.parse(f.split('\n').find((l) => l.startsWith('data: ')).slice(6)));
}

const json = (method, body, headers = {}) => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

test('a fresh stream starts with the reconnect delay, then ready at the current sequence', async () => {
  const { base, port } = await startServer();
  await fetch(`${base}/api/folders`, json('POST', { name: 'One' }));
  const stream = openStream(port);
  const res = await stream.ready;
  expect(res.headers['x-accel-buffering']).toBe('no');
  await until(() => stream.text().includes('event: ready'));
  expect(stream.text().startsWith('retry: 3000\n\n')).toBe(true);
  expect(stream.text()).toContain('id: 1\nevent: ready\ndata: {"seq":1}\n\n');
  expect(changesIn(stream.text())).toEqual([]);
  stream.stop();
}, T);

test('every kind of write reaches the stream, with what the other device needs', async () => {
  const { base, port } = await startServer();
  const stream = openStream(port);
  await stream.ready;
  await until(() => stream.text().includes('event: ready'));

  const { id } = await (await fetch(`${base}/api/diagrams`, json('POST', { name: 'A', items: [] }))).json();
  await fetch(`${base}/api/diagrams/${id}`, json('PATCH', { name: 'Renamed' }));
  await fetch(`${base}/api/diagrams/${id}`, json('PATCH', { deletedAt: new Date().toISOString() }));
  const folder = await (await fetch(`${base}/api/folders`, json('POST', { name: 'F' }))).json();
  await fetch(`${base}/api/folders/${folder.id}`, json('PUT', { name: 'G' }));
  await fetch(`${base}/api/tree-manifest`, json('PUT', { version: 1, order: {} }));
  await fetch(`${base}/api/folders/${folder.id}`, { method: 'DELETE' });

  await until(() => changesIn(stream.text()).length >= 7);
  const changes = changesIn(stream.text());
  expect(changes.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(changes).toEqual([
    expect.objectContaining({ kind: 'diagram', action: 'create', id }),
    expect.objectContaining({ kind: 'diagram', action: 'update', id, name: 'Renamed' }),
    expect.objectContaining({ kind: 'diagram', action: 'update', id, deleted: true }),
    expect.objectContaining({ kind: 'folder', action: 'create', id: folder.id }),
    expect.objectContaining({ kind: 'folder', action: 'update', id: folder.id }),
    expect.objectContaining({ kind: 'tree', action: 'save' }),
    expect.objectContaining({ kind: 'folder', action: 'delete', id: folder.id })
  ]);
  for (const c of changes) expect(Date.parse(c.at)).not.toBeNaN();
  stream.stop();
}, T);

test('reads and failed writes publish nothing', async () => {
  const { base, port } = await startServer();
  const stream = openStream(port);
  await stream.ready;
  await until(() => stream.text().includes('event: ready'));

  await fetch(`${base}/api/diagrams`);
  await fetch(`${base}/api/tree-manifest`);
  const missing = await fetch(`${base}/api/diagrams/does-not-exist`, json('PATCH', { name: 'x' }));
  expect(missing.status).toBeGreaterThanOrEqual(400);
  const bad = await fetch(`${base}/api/diagrams`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json'
  });
  expect(bad.status).toBe(400);

  // A real write is seq 1: nothing before it counted.
  const created = await fetch(`${base}/api/diagrams`, json('POST', { name: 'D', items: [] }));
  const { id } = await created.json();
  await fetch(`${base}/api/diagrams/${id}`, json('PUT', { name: 'D', items: [{ id: 'n1' }] }));
  await until(() => changesIn(stream.text()).length >= 2);
  await new Promise((r) => setTimeout(r, 300));
  expect(changesIn(stream.text())).toEqual([
    expect.objectContaining({ seq: 1, kind: 'diagram', action: 'create', id }),
    expect.objectContaining({ seq: 2, kind: 'diagram', action: 'save', id })
  ]);
  stream.stop();
}, T);

test('a save that changes nothing publishes nothing', async () => {
  const { base, port } = await startServer();
  const stream = openStream(port);
  await stream.ready;
  await until(() => stream.text().includes('event: ready'));

  const created = await fetch(`${base}/api/diagrams`, json('POST', { name: 'D', items: [] }));
  const { id } = await created.json();
  const first = await fetch(`${base}/api/diagrams/${id}`, json('PUT', { name: 'D', items: [{ id: 'n1' }] }));
  expect((await first.json()).unchanged).toBeUndefined();
  // The same content again (a second tab, an undo back): written by nobody,
  // announced to nobody.
  const again = await fetch(`${base}/api/diagrams/${id}`, json('PUT', { name: 'D', items: [{ id: 'n1' }] }));
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ success: true, id, unchanged: true });
  // Then a real change is the next sequence number.
  await fetch(`${base}/api/diagrams/${id}`, json('PUT', { name: 'D', items: [{ id: 'n2' }] }));
  await until(() => changesIn(stream.text()).length >= 3);
  await new Promise((r) => setTimeout(r, 300));
  expect(changesIn(stream.text())).toEqual([
    expect.objectContaining({ seq: 1, action: 'create', id }),
    expect.objectContaining({ seq: 2, action: 'save', id }),
    expect.objectContaining({ seq: 3, action: 'save', id })
  ]);
  stream.stop();
}, T);

test('only a well-formed device id is echoed as the change origin', async () => {
  const { base, port } = await startServer();
  const stream = openStream(port);
  await stream.ready;
  await until(() => stream.text().includes('event: ready'));
  await fetch(`${base}/api/folders`, json('POST', { name: 'A' }, { 'X-Axoview-Device': 'tab-0001-abcd' }));
  await fetch(`${base}/api/folders`, json('POST', { name: 'B' }, { 'X-Axoview-Device': 'tab","kind":"resync' }));
  await fetch(`${base}/api/folders`, json('POST', { name: 'C' }, { 'X-Axoview-Device': 'short' }));
  await until(() => changesIn(stream.text()).length >= 3);
  expect(changesIn(stream.text()).map((c) => c.origin)).toEqual(['tab-0001-abcd', undefined, undefined]);
  expect(changesIn(stream.text()).map((c) => c.kind)).toEqual(['folder', 'folder', 'folder']);
  stream.stop();
}, T);

test('resuming: at the current id it is ready; one behind it is that change; a bad id is a fresh start', async () => {
  const { base, port } = await startServer();
  await fetch(`${base}/api/folders`, json('POST', { name: 'One' }));
  await fetch(`${base}/api/folders`, json('POST', { name: 'Two' }));

  const current = openStream(port, { 'Last-Event-ID': '2' });
  await current.ready;
  await until(() => current.text().includes('event: ready'));
  expect(changesIn(current.text())).toEqual([]);
  current.stop();

  const behind = openStream(port, { 'Last-Event-ID': '1' });
  await behind.ready;
  await until(() => changesIn(behind.text()).length === 1);
  expect(changesIn(behind.text())[0]).toEqual(expect.objectContaining({ seq: 2, kind: 'folder', action: 'create' }));
  expect(behind.text()).not.toContain('event: ready');
  behind.stop();

  for (const bad of ['abc', '-1', '1e3', '9999999999999999']) {
    const stream = openStream(port, { 'Last-Event-ID': bad });
    await stream.ready;
    await until(() => stream.text().includes('event: ready'));
    expect(changesIn(stream.text())).toEqual([]);
    stream.stop();
  }
}, T);

test('a stream ends after its maximum age, so the client reconnects', async () => {
  const { port } = await startServer({ SYNC_MAX_STREAM_MS: '1200', SYNC_POLL_MS: '100' });
  const stream = openStream(port);
  const res = await stream.ready;
  const started = Date.now();
  await new Promise((resolve) => res.on('end', resolve));
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  expect(Date.now() - started).toBeLessThan(5000);
}, T);

test('silence is filled with heartbeats, never longer than the heartbeat interval', async () => {
  const { port } = await startServer({ SYNC_HEARTBEAT_MS: '300', SYNC_POLL_MS: '100' });
  const stream = openStream(port);
  await stream.ready;
  await until(() => stream.text().includes('event: ready'));
  await new Promise((r) => setTimeout(r, 1300));
  const pings = stream.text().split(': ping\n\n').length - 1;
  expect(pings).toBeGreaterThanOrEqual(3);
  stream.stop();
}, T);

test('a closed tab is forgotten: shutdown ends only the streams still open', async () => {
  const { port, child, logs } = await startServer({ SHUTDOWN_DRAIN_MS: '200', SHUTDOWN_FORCE_MS: '1500' });
  const kept = openStream(port);
  const gone = openStream(port);
  await kept.ready;
  await gone.ready;
  await until(() => kept.text().includes('event: ready') && gone.text().includes('event: ready'));
  gone.stop();
  await new Promise((r) => setTimeout(r, 300));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.kill('SIGTERM');
  await exited;
  expect(logs.join('')).toContain('ending 1 sync stream(s)');
}, T);
