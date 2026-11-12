/**
 * Server storage and sharing by email (ADR 0057): the provider learns whether
 * a diagram is shared from the server's X-Axoview-Shared header (the app then
 * uploads its saves at once), lists shared diagrams with their owner, and
 * turns the members API's answers into results the share field shows.
 */
import { LocalStorageProvider } from '../providers/LocalStorageProvider';
import { leanIfModel } from '../leanModel';

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

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
function script(responses: Response[]): Call[] {
  const calls: Call[] = [];
  let index = 0;
  (global as any).fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: (init.method || 'GET').toUpperCase(), body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(new Headers(init.headers).entries()) });
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

it('remembers from the load and each save whether others have the diagram, and this account\'s level', async () => {
  const p = serverProvider();
  script([
    response(200, { title: 'A' }, { ETag: '"2"', 'X-Axoview-Shared': 'with-you', 'X-Axoview-Role': 'viewer' }),
    response(200, { success: true }, { ETag: '"3"' })
  ]);
  await p.loadDiagram('d1');
  expect(p.sharedState('d1')).toBe('with-you');
  expect(p.sharedRole('d1')).toBe('viewer');
  // The save answered without the header: no longer shared.
  await p.saveDiagram('d1', { title: 'A2' });
  expect(p.sharedState('d1')).toBeUndefined();
  expect(p.sharedRole('d1')).toBeUndefined();
});

it('lists a diagram shared with this account with its owner', async () => {
  const p = serverProvider();
  script([response(200, [
    { id: 'mine', name: 'Mine', lastModified: '2026-11-10T00:00:00Z', folderId: null },
    { id: 'theirs', name: 'Theirs', lastModified: '2026-11-10T00:00:00Z', folderId: null, shared: { role: 'admin', ownerEmail: 'alice@example.com' } }
  ])]);
  const list = await p.listDiagrams();
  expect(list.find((d) => d.id === 'mine')?.shared).toBeUndefined();
  expect(list.find((d) => d.id === 'theirs')?.shared).toEqual({ role: 'admin', ownerEmail: 'alice@example.com' });
});

it('adding a person: success marks the diagram shared; a refusal carries the reason', async () => {
  const p = serverProvider();
  const member = { sub: 'bob', email: 'bob@example.com', role: 'admin', addedAt: '2026-11-10T00:00:00Z' };
  const calls = script([
    response(201, { member }),
    response(404, { error: 'No Axoview account uses that email', reason: 'no-account' })
  ]);
  expect(await p.addMember('d1', 'bob@example.com', 'admin')).toEqual({ ok: true, member });
  expect(calls[0]).toMatchObject({ url: `${BASE}/api/diagrams/d1/members`, method: 'POST', body: { email: 'bob@example.com', role: 'admin' } });
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
  const member = { sub: 'bob', email: 'bob@example.com', role: 'viewer', addedAt: '2026-11-10T00:00:00Z' };
  const calls = script([response(200, { members: [member] }), response(200, { removed: 'bob' })]);
  expect(await p.listMembers('d1')).toEqual([member]);
  await p.removeMember('d1', 'bob');
  expect(calls[1]).toMatchObject({ url: `${BASE}/api/diagrams/d1/members/bob`, method: 'DELETE' });
});

it('changes a level; an unknown level is refused with its reason', async () => {
  const p = serverProvider();
  const member = { sub: 'bob', email: 'bob@example.com', role: 'admin', addedAt: '2026-11-10T00:00:00Z' };
  const calls = script([
    response(200, { member }),
    response(400, { error: 'Unknown permission level', reason: 'invalid-role' })
  ]);
  expect(await p.setMemberRole('d1', 'bob', 'admin')).toEqual({ ok: true, member });
  expect(calls[0]).toMatchObject({ url: `${BASE}/api/diagrams/d1/members/bob`, method: 'PATCH', body: { role: 'admin' } });
  expect(await p.setMemberRole('d1', 'bob', 'owner' as never)).toMatchObject({ ok: false, reason: 'invalid-role' });
});

it('lists proposals; rejecting records the decision or says why not', async () => {
  const p = serverProvider();
  const waiting = [{ id: 'p1', by: { sub: 'me', agent: 'Claude Code' }, viewId: 'v1', operations: [{ op: 'add_node', name: 'X' }], note: null, createdAt: 'x' }];
  const calls = script([
    response(200, { proposals: waiting }),
    response(200, { proposal: { id: 'p1', status: 'rejected' } }),
    response(409, { error: 'That proposal was already approved', reason: 'already-decided' })
  ]);
  expect(await p.listProposals('d1')).toEqual(waiting);
  expect(await p.rejectProposal('d1', 'p1')).toEqual({ ok: true });
  expect(calls[1]).toMatchObject({ url: `${BASE}/api/diagrams/d1/proposals/p1/reject`, method: 'POST' });
  expect(await p.rejectProposal('d1', 'p1')).toEqual({ ok: false, reason: 'already-decided', message: 'That proposal was already approved' });
});

describe('approving a proposal is a save that names the state it was built on', () => {
  const DOC = {
    title: 'Net', icons: [], colors: [], fitToScreen: true,
    items: [{ id: 'a', name: 'Cache' }],
    views: [{ id: 'v1', name: 'Page 1', items: [{ id: 'a', tile: { x: 0, y: 0 } }] }]
  };
  // Sent the way every save is (ADR 0003: pack icons stripped, packs recorded).
  const SENT = JSON.parse(JSON.stringify(leanIfModel(DOC)));

  it('the document goes out lean, with its content intact', () => {
    expect(SENT).toMatchObject({ title: 'Net', items: DOC.items, views: DOC.views });
  });

  it('a versioned backend: If-Match with the version this tab holds, then the new one is remembered', async () => {
    const p = serverProvider();
    const calls = script([
      response(200, { title: 'Net', lastModified: 't0' }, { ETag: '"4"' }),
      response(200, { proposal: { id: 'p1', status: 'approved' }, lastModified: 't1' }, { ETag: '"5"' }),
      response(200, { success: true }, { ETag: '"6"' })
    ]);
    await p.loadDiagram('d1');
    expect(await p.approveProposal('d1', 'p1', { applied: 2, document: DOC })).toEqual({ ok: true });
    expect(calls[1]).toMatchObject({ url: `${BASE}/api/diagrams/d1/proposals/p1/approve`, method: 'POST' });
    expect(calls[1].headers['if-match']).toBe('"4"');
    expect(calls[1].body).toEqual({ applied: 2, document: SENT });
    // This tab now holds version 5: it is what the sync hook compares and the next save goes out against.
    expect(p.knownVersion('d1')).toBe(5);
    await p.saveDiagram('d1', DOC);
    expect(calls[2].headers['if-match']).toBe('"5"');
  });

  it('a backend without versions: the lastModified this tab loaded, then the new one is remembered', async () => {
    const p = serverProvider();
    const calls = script([
      response(200, { title: 'Net', lastModified: '2026-11-12T01:00:00.000Z' }),
      response(200, { proposal: { id: 'p1', status: 'approved' }, lastModified: '2026-11-12T02:00:00.000Z' })
    ]);
    await p.loadDiagram('d1');
    expect(await p.approveProposal('d1', 'p1', { applied: 1, document: DOC })).toEqual({ ok: true });
    expect(calls[1].headers['if-match']).toBeUndefined();
    expect(calls[1].body).toEqual({ applied: 1, document: SENT, baseModified: '2026-11-12T01:00:00.000Z' });
    expect(p.serverStamp('d1')).toBe('t2026-11-12T02:00:00.000Z');
  });

  it('the version a LISTING reported is not what this tab holds: it is never sent', async () => {
    const p = serverProvider();
    const calls = script([
      response(200, { title: 'Net', lastModified: 't0' }, { ETag: '"4"' }),
      response(200, [{ id: 'd1', name: 'Net', lastModified: 't9', version: 9 }]),
      response(409, { error: 'Version conflict', currentVersion: 9 })
    ]);
    await p.loadDiagram('d1');
    await p.listDiagrams();
    expect(await p.approveProposal('d1', 'p1', { applied: 1, document: DOC })).toMatchObject({ ok: false });
    expect(calls[2].headers['if-match']).toBe('"4"');
    // Refused: one request, no retry against the newer version, nothing remembered.
    expect(calls).toHaveLength(3);
    expect(p.knownVersion('d1')).toBe(4);
  });

  it('changed elsewhere (409): the reason comes back and nothing is remembered', async () => {
    const p = serverProvider();
    script([
      response(200, { title: 'Net', lastModified: 't0' }),
      response(409, { error: 'Diagram was changed since it was loaded', reason: 'conflict' })
    ]);
    await p.loadDiagram('d1');
    expect(await p.approveProposal('d1', 'p1', { applied: 1, document: DOC }))
      .toEqual({ ok: false, reason: 'conflict', message: 'Diagram was changed since it was loaded' });
    expect(p.serverStamp('d1')).toBe('tt0');
  });

  it('the network fails: an error, not an exception', async () => {
    const p = serverProvider();
    script([]);
    expect(await p.approveProposal('d1', 'p1', { applied: 1, document: DOC })).toEqual({ ok: false, reason: 'error', message: 'Network error' });
  });
});

it("reads and sets what this person's agent may do; Read only when unknown or unreachable", async () => {
  const p = serverProvider();
  const calls = script([
    response(200, { level: 'proposer' }),
    response(200, { level: 'viewer' }),
    response(400, { reason: 'invalid-level' }),
    response(500, {})
  ]);
  expect(await p.agentLevel()).toBe('proposer');
  expect(await p.setAgentLevel('viewer')).toBe(true);
  expect(calls[1]).toMatchObject({ url: `${BASE}/api/agent`, method: 'PUT', body: { level: 'viewer' } });
  expect(await p.setAgentLevel('admin' as never)).toBe(false);
  expect(await p.agentLevel()).toBe('viewer');
  expect(await p.agentLevel()).toBe('viewer'); // network down
});
