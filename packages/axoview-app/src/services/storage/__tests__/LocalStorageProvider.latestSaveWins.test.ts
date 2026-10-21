/**
 * Multi-device sync, "latest save wins": a save whose If-Match is stale (another
 * device saved since this tab loaded the diagram) learns the current version
 * and saves again, instead of failing every autosave until a reload discarded
 * the edits.
 */
import { LocalStorageProvider } from '../providers/LocalStorageProvider';

const BASE = 'http://localhost:3001';

interface Call {
  url: string;
  method: string;
  ifMatch: string | null;
  device: string | null;
}

function response(status: number, body: unknown, etag?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag ?? null : null) }
  } as unknown as Response;
}

function script(responses: Response[]): Call[] {
  const calls: Call[] = [];
  let index = 0;
  (global as any).fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({
      url: String(input),
      method: (init.method || 'GET').toUpperCase(),
      ifMatch: headers.get('If-Match'),
      device: headers.get('X-Axoview-Device')
    });
    return responses[index++] ?? response(500, { error: 'no more mocks' });
  };
  return calls;
}

async function serverProvider(): Promise<LocalStorageProvider> {
  const p = new LocalStorageProvider(BASE);
  p.usingServer = true;
  return p;
}

beforeEach(() => {
  sessionStorage.clear();
  (global as any).fetch = undefined;
});

it('on 409, re-reads the version and saves again with it', async () => {
  const p = await serverProvider();
  const calls = script([
    response(200, { title: 'A' }, '"3"'),        // load: version 3
    response(409, { code: 'VERSION_CONFLICT' }), // another device saved v4
    response(200, { title: 'B' }, '"4"'),        // re-read: version 4
    response(200, { ok: true }, '"5"')           // retry wins
  ]);
  await p.loadDiagram('d1');
  await p.saveDiagram('d1', { title: 'mine' });

  expect(calls.map((c) => `${c.method} ${c.ifMatch ?? '-'}`)).toEqual([
    'GET -', 'PUT "3"', 'GET -', 'PUT "4"'
  ]);
  expect(p.knownVersion('d1')).toBe(5);
});

it('on 428 (version never learned), learns it and saves', async () => {
  const p = await serverProvider();
  const calls = script([
    response(428, { code: 'IF_MATCH_REQUIRED' }),
    response(200, {}, '"7"'),
    response(200, { ok: true }, '"8"')
  ]);
  await p.saveDiagram('d2', { title: 'x' });
  expect(calls.map((c) => `${c.method} ${c.ifMatch ?? '-'}`)).toEqual(['PUT -', 'GET -', 'PUT "7"']);
  expect(p.knownVersion('d2')).toBe(8);
});

it('retries once only: a second conflict is an error the autosave reports', async () => {
  const p = await serverProvider();
  script([
    response(409, {}),
    response(200, {}, '"2"'),
    response(409, {})
  ]);
  await expect(p.saveDiagram('d3', { title: 'x' })).rejects.toThrow('409');
});

it('sends this tab\'s device id on writes, not on reads', async () => {
  const p = await serverProvider();
  const calls = script([response(200, {}, '"1"'), response(200, {}, '"2"')]);
  await p.loadDiagram('d4');
  await p.saveDiagram('d4', { title: 'x' });
  expect(calls[0].device).toBeNull();
  expect(calls[1].device).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
});

it('a listing does not change the version of the content this tab holds', async () => {
  const p = await serverProvider();
  script([
    response(200, { title: 'A' }, '"3"'),
    response(200, [{ id: 'd5', name: 'A', lastModified: '2026-10-21T00:00:00Z', version: 9 }])
  ]);
  await p.loadDiagram('d5');
  await p.listDiagrams();
  expect(p.knownVersion('d5')).toBe(3);
});
