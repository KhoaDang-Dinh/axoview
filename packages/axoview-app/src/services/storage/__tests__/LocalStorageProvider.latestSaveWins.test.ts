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
  agent: string | null;
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
      device: headers.get('X-Axoview-Device'),
      agent: headers.get('X-Axoview-Agent')
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

it('on a 409 that names the current version, saves again against it without re-reading the diagram', async () => {
  const p = await serverProvider();
  const calls = script([
    response(200, { title: 'A' }, '"3"'),
    response(409, { code: 'VERSION_CONFLICT', currentVersion: 4 }),
    response(200, { ok: true }, '"5"')
  ]);
  await p.loadDiagram('d1');
  await p.saveDiagram('d1', { title: 'mine' });
  expect(calls.map((c) => `${c.method} ${c.ifMatch ?? '-'}`)).toEqual(['GET -', 'PUT "3"', 'PUT "4"']);
  expect(p.knownVersion('d1')).toBe(5);
});

it('a rename, trash or restore records the version it produced, so the next save is not stale', async () => {
  const p = await serverProvider();
  const calls = script([
    response(200, { title: 'A' }, '"3"'),   // load
    response(200, { success: true }, '"4"'), // rename
    response(200, { ok: true }, '"5"'),      // save: goes out against 4, first time
    response(200, { success: true }, '"6"'), // trash
    response(200, { success: true }, '"7"')  // restore
  ]);
  await p.loadDiagram('d1');
  await p.renameDiagram('d1', 'Renamed');
  await p.saveDiagram('d1', { title: 'Renamed' });
  expect(calls.map((c) => `${c.method} ${c.ifMatch ?? '-'}`)).toEqual(['GET -', 'PATCH -', 'PUT "4"']);
  await p.deleteDiagram('d1', true);
  expect(p.knownVersion('d1')).toBe(6);
  await p.restoreDiagram('d1');
  expect(p.knownVersion('d1')).toBe(7);
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

// CloudFront compresses answers of 1,000 bytes or more and weakens their
// ETag. Reading only "7" left a tab whose diagram is not tiny without a
// version: every save went out without If-Match and failed (2026-11-13).
it('behind CloudFront: a weak ETag (W/"7") is a version like "7"', async () => {
  const p = await serverProvider();
  const calls = script([
    response(200, { title: 'big' }, 'W/"6"'),
    response(200, { ok: true }, '"7"'),
    response(428, { code: 'IF_MATCH_REQUIRED' }),
    response(200, {}, 'W/"9"'),
    response(200, { ok: true }, '"10"')
  ]);
  await p.loadDiagram('d4');
  expect(p.knownVersion('d4')).toBe(6);
  await p.saveDiagram('d4', { title: 'x' });
  // And when the version must be re-read, the weak answer is enough.
  await p.saveDiagram('d5', { title: 'y' });
  expect(calls.map((c) => `${c.method} ${c.ifMatch ?? '-'}`)).toEqual(['GET -', 'PUT "6"', 'PUT -', 'GET -', 'PUT "9"']);
  expect(p.knownVersion('d4')).toBe(7);
  expect(p.knownVersion('d5')).toBe(10);
});

it('the save after an assistant change is approved names the assistant, once, retries included', async () => {
  const p = await serverProvider();
  const calls = script([
    response(200, { ok: true }, '"2"'),
    response(409, { currentVersion: 5 }),
    response(200, { ok: true }, '"6"'),
    response(200, { ok: true }, '"7"'),
    response(500, {}),
    response(200, { ok: true }, '"8"')
  ]);
  await p.saveDiagram('d6', { title: 'mine' });
  p.noteAgentChange('d6', 'Nova');
  await p.saveDiagram('d6', { title: 'with Nova' });
  await p.saveDiagram('d6', { title: 'mine again' });
  // A failed save keeps the note for the save that gets through.
  p.noteAgentChange('d6', 'Nova');
  await expect(p.saveDiagram('d6', { title: 'fails' })).rejects.toThrow('500');
  await p.saveDiagram('d6', { title: 'gets through' });
  expect(calls.map((c) => c.agent)).toEqual([null, 'Nova', 'Nova', null, 'Nova', 'Nova']);
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
