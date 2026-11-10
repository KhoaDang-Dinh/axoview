/**
 * Server storage and sharing by email (ADR 0057): the provider learns whether
 * a diagram is shared from the server's X-Axoview-Shared header (the app then
 * uploads its saves at once), lists shared diagrams with their owner, and
 * turns the members API's answers into results the share field shows.
 */
import { LocalStorageProvider } from '../providers/LocalStorageProvider';

const BASE = 'http://localhost:3001';

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null }
  } as unknown as Response;
}

function script(responses: Response[]): Array<{ url: string; method: string; body: unknown }> {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let index = 0;
  (global as any).fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: (init.method || 'GET').toUpperCase(), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses[index++];
    if (!next) throw new TypeError('Failed to fetch');
    return next;
  };
  return calls;
}

function serverProvider(): LocalStorageProvider {
  const p = new LocalStorageProvider(BASE);
  p.usingServer = true;
  return p;
}

beforeEach(() => {
  sessionStorage.clear();
  (global as any).fetch = undefined;
});

it('remembers from the load and each save whether others have the diagram', async () => {
  const p = serverProvider();
  script([
    response(200, { title: 'A' }, { ETag: '"2"', 'X-Axoview-Shared': 'with-you' }),
    response(200, { success: true }, { ETag: '"3"' })
  ]);
  await p.loadDiagram('d1');
  expect(p.sharedState('d1')).toBe('with-you');
  // The save answered without the header: no longer shared.
  await p.saveDiagram('d1', { title: 'A2' });
  expect(p.sharedState('d1')).toBeUndefined();
});

it('lists a diagram shared with this account with its owner', async () => {
  const p = serverProvider();
  script([response(200, [
    { id: 'mine', name: 'Mine', lastModified: '2026-11-10T00:00:00Z', folderId: null },
    { id: 'theirs', name: 'Theirs', lastModified: '2026-11-10T00:00:00Z', folderId: null, shared: { role: 'editor', ownerEmail: 'alice@example.com' } }
  ])]);
  const list = await p.listDiagrams();
  expect(list.find((d) => d.id === 'mine')?.shared).toBeUndefined();
  expect(list.find((d) => d.id === 'theirs')?.shared).toEqual({ role: 'editor', ownerEmail: 'alice@example.com' });
});

it('adding a person: success marks the diagram shared; a refusal carries the reason', async () => {
  const p = serverProvider();
  const member = { sub: 'bob', email: 'bob@example.com', role: 'editor', addedAt: '2026-11-10T00:00:00Z' };
  const calls = script([
    response(201, { member }),
    response(404, { error: 'No Axoview account uses that email', reason: 'no-account' })
  ]);
  expect(await p.addMember('d1', 'bob@example.com')).toEqual({ ok: true, member });
  expect(calls[0]).toMatchObject({ url: `${BASE}/api/diagrams/d1/members`, method: 'POST', body: { email: 'bob@example.com' } });
  expect(p.sharedState('d1')).toBe('by-you');
  expect(await p.addMember('d1', 'nobody@example.com')).toEqual({
    ok: false, reason: 'no-account', message: 'No Axoview account uses that email'
  });
});

it('adding a person with the network down: reason "error"', async () => {
  const p = serverProvider();
  script([]);
  expect(await p.addMember('d1', 'bob@example.com')).toEqual({ ok: false, reason: 'error', message: 'Network error' });
});

it('lists and removes people', async () => {
  const p = serverProvider();
  const member = { sub: 'bob', email: 'bob@example.com', role: 'editor', addedAt: '2026-11-10T00:00:00Z' };
  const calls = script([response(200, { members: [member] }), response(200, { removed: 'bob' })]);
  expect(await p.listMembers('d1')).toEqual([member]);
  await p.removeMember('d1', 'bob');
  expect(calls[1]).toMatchObject({ url: `${BASE}/api/diagrams/d1/members/bob`, method: 'DELETE' });
});
