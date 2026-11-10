import { describe, it, expect, beforeEach } from '@jest/globals';
import { createSharing, normalizeEmail, assertRole, CACHE_MS, LOOKUPS_PER_MINUTE } from '../sharing.js';
import { sharableUser } from '../cognitoDirectory.js';

/** Workspaces as in-memory key/value stores, with one diagram per owner. */
function memoryWorkspaces() {
  const stores = new Map();
  const reads = [];
  const store = (ws) => {
    if (!stores.has(ws)) stores.set(ws, new Map());
    return stores.get(ws);
  };
  return {
    reads,
    store,
    adapterFor(ws) {
      return {
        async get(key) {
          reads.push(`${ws}:${key}`);
          return store(ws).get(key) ?? null;
        },
        async put(key, value) {
          store(ws).set(key, value);
        },
        async delete(key) {
          store(ws).delete(key);
        }
      };
    },
    put(ws, key, value) {
      store(ws).set(key, new TextEncoder().encode(JSON.stringify(value)));
    },
    diagram(ws, id, fields = {}) {
      store(ws).set(`diagrams/${id}`, new TextEncoder().encode(JSON.stringify({ name: 'Plan', lastModified: '2026-11-10T00:00:00.000Z', ...fields })));
    },
    json(ws, key) {
      const bytes = store(ws).get(key);
      return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    }
  };
}

const ACCOUNTS = {
  'bob@example.com': { sub: 'bob', email: 'bob@example.com' },
  'alice@example.com': { sub: 'alice', email: 'alice@example.com' }
};

let ws;
let clock;
let sharing;
beforeEach(() => {
  ws = memoryWorkspaces();
  clock = 1_000_000;
  sharing = createSharing({
    adapterFor: ws.adapterFor,
    findUserByEmail: async (email) => ACCOUNTS[email] ?? null,
    findUserBySub: async (sub) => Object.values(ACCOUNTS).find((a) => a.sub === sub) ?? null,
    now: () => clock
  });
  ws.diagram('alice', 'd1');
});

const failure = (promise) => promise.then(() => { throw new Error('expected a failure'); }, (e) => ({ status: e.status, ...e.body }));

describe('adding a person by email', () => {
  it('an account with that verified email is added at the level chosen, and the diagram shows on their side', async () => {
    const member = await sharing.addMember('alice', 'd1', '  Bob@Example.com ', 'admin');
    expect(member).toEqual({ sub: 'bob', email: 'bob@example.com', kind: 'person', role: 'admin', addedAt: expect.any(String) });
    expect(ws.json('alice', 'sharing/members/d1').members).toHaveLength(1);
    expect(await sharing.sharedWithMe('bob')).toEqual([{
      id: 'd1',
      name: 'Plan',
      lastModified: '2026-11-10T00:00:00.000Z',
      folderId: null,
      deletedAt: null,
      shared: { role: 'admin', ownerEmail: 'alice@example.com' }
    }]);
    expect(await sharing.accessTo('bob', 'd1')).toEqual({ owner: 'alice', role: 'admin' });
  });

  it('Read only is the default level', async () => {
    expect((await sharing.addMember('alice', 'd1', 'bob@example.com')).role).toBe('viewer');
  });

  it('no account with that email: nothing is stored (red: no account)', async () => {
    expect(await failure(sharing.addMember('alice', 'd1', 'nobody@example.com')))
      .toMatchObject({ status: 404, reason: 'no-account', error: 'No Axoview account uses that email' });
    expect(ws.json('alice', 'sharing/members/d1')).toBeNull();
  });

  it('the same person twice: refused, nothing new stored (red: already shared)', async () => {
    await sharing.addMember('alice', 'd1', 'bob@example.com');
    expect(await failure(sharing.addMember('alice', 'd1', 'BOB@example.com')))
      .toMatchObject({ status: 409, reason: 'already-shared', error: 'Already shared with bob@example.com' });
    expect(ws.json('alice', 'sharing/members/d1').members).toHaveLength(1);
  });

  it('yourself: refused (red)', async () => {
    expect(await failure(sharing.addMember('alice', 'd1', 'alice@example.com')))
      .toMatchObject({ status: 422, reason: 'self' });
  });

  it('a malformed email: refused before any lookup', async () => {
    for (const email of ['', 'bob', 'bob@', 'a"b@example.com', null]) {
      expect(await failure(sharing.addMember('alice', 'd1', email))).toMatchObject({ status: 400, reason: 'invalid-email' });
    }
  });

  it('only the owner can share: someone else\'s or a missing diagram is a 404', async () => {
    expect(await failure(sharing.addMember('bob', 'd1', 'alice@example.com'))).toMatchObject({ status: 404, reason: 'not-found' });
    expect(await failure(sharing.addMember('alice', 'nope', 'bob@example.com'))).toMatchObject({ status: 404 });
  });

  it('a trashed diagram cannot be shared', async () => {
    ws.diagram('alice', 'd2', { deletedAt: '2026-11-10T00:00:00.000Z' });
    expect(await failure(sharing.addMember('alice', 'd2', 'bob@example.com'))).toMatchObject({ status: 404 });
  });

  it(`lookups are limited to ${LOOKUPS_PER_MINUTE} a minute per owner`, async () => {
    for (let i = 0; i < LOOKUPS_PER_MINUTE; i += 1) {
      await failure(sharing.addMember('alice', 'd1', `x${i}@example.com`));
    }
    expect(await failure(sharing.addMember('alice', 'd1', 'bob@example.com'))).toMatchObject({ status: 429, reason: 'rate-limited' });
    clock += 60_001;
    await expect(sharing.addMember('alice', 'd1', 'bob@example.com')).resolves.toMatchObject({ sub: 'bob' });
  });
});

describe('managing and reading access', () => {
  it('the owner lists and removes people; the removed person loses the diagram', async () => {
    await sharing.addMember('alice', 'd1', 'bob@example.com');
    expect((await sharing.listMembers('alice', 'd1')).map((m) => m.email)).toEqual(['bob@example.com']);
    await sharing.removeMember('alice', 'd1', 'bob');
    expect(await sharing.listMembers('alice', 'd1')).toEqual([]);
    expect(await sharing.sharedWithMe('bob')).toEqual([]);
    expect(await sharing.accessTo('bob', 'd1')).toBeNull();
  });

  it('only the owner sees the list', async () => {
    await sharing.addMember('alice', 'd1', 'bob@example.com');
    expect(await failure(sharing.listMembers('bob', 'd1'))).toMatchObject({ status: 404 });
  });

  it('a diagram the owner trashed leaves the shared list', async () => {
    await sharing.addMember('alice', 'd1', 'bob@example.com');
    ws.diagram('alice', 'd1', { deletedAt: '2026-11-10T01:00:00.000Z' });
    expect(await sharing.sharedWithMe('bob')).toEqual([]);
  });

  it('access answers are cached, so ordinary loads and saves cost no extra read', async () => {
    await sharing.accessTo('carol', 'd1');
    await sharing.memberSubs('alice', 'd1');
    const before = ws.reads.length;
    await sharing.accessTo('carol', 'd1');
    await sharing.memberSubs('alice', 'd1');
    expect(ws.reads.length).toBe(before);
    clock += CACHE_MS;
    await sharing.accessTo('carol', 'd1');
    expect(ws.reads.length).toBe(before + 1);
  });

  it('memberSubs names everyone to tell about a change', async () => {
    await sharing.addMember('alice', 'd1', 'bob@example.com');
    expect(await sharing.memberSubs('alice', 'd1')).toEqual(['bob']);
  });
});

describe('who can be found', () => {
  const user = (attrs, extra = {}) => ({ Enabled: true, Attributes: Object.entries(attrs).map(([Name, Value]) => ({ Name, Value })), ...extra });

  it('a verified, enabled account', () => {
    expect(sharableUser(user({ sub: 's1', email: 'Bob@Example.com', email_verified: 'true' })))
      .toEqual({ sub: 's1', email: 'bob@example.com' });
  });

  it('never an unverified or disabled one', () => {
    expect(sharableUser(user({ sub: 's1', email: 'bob@example.com', email_verified: 'false' }))).toBeNull();
    expect(sharableUser(user({ sub: 's1', email: 'bob@example.com' }))).toBeNull();
    expect(sharableUser(user({ sub: 's1', email: 'bob@example.com', email_verified: 'true' }, { Enabled: false }))).toBeNull();
  });

  it('emails are compared lower-case', () => {
    expect(normalizeEmail(' Bob@Example.COM ')).toBe('bob@example.com');
  });
});

describe('permission levels', () => {
  it('people may hold any level; agents never Full admin', () => {
    for (const role of ['viewer', 'proposer', 'admin']) expect(assertRole(role, 'person')).toBe(role);
    expect(assertRole('viewer', 'agent')).toBe('viewer');
    expect(assertRole('proposer', 'agent')).toBe('proposer');
    expect(() => assertRole('admin', 'agent')).toThrow(expect.objectContaining({ status: 400, body: expect.objectContaining({ reason: 'agent-not-admin' }) }));
    expect(() => assertRole('owner', 'person')).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('an unknown level is refused when adding', async () => {
    expect(await failure(sharing.addMember('alice', 'd1', 'bob@example.com', 'superuser'))).toMatchObject({ status: 400, reason: 'invalid-role' });
  });

  it('changing a level updates both sides', async () => {
    await sharing.addMember('alice', 'd1', 'bob@example.com', 'viewer');
    await sharing.setRole('alice', 'd1', 'bob', 'admin');
    expect((await sharing.listMembers('alice', 'd1'))[0].role).toBe('admin');
    expect(await sharing.accessTo('bob', 'd1')).toEqual({ owner: 'alice', role: 'admin' });
  });

  it('an agent member cannot be raised to Full admin', async () => {
    ws.put('alice', 'sharing/members/d1', { members: [{ sub: 'agent-7', email: null, kind: 'agent', role: 'proposer', addedAt: 'x' }] });
    expect(await failure(sharing.setRole('alice', 'd1', 'agent-7', 'admin'))).toMatchObject({ status: 400, reason: 'agent-not-admin' });
    await expect(sharing.setRole('alice', 'd1', 'agent-7', 'viewer')).resolves.toMatchObject({ role: 'viewer' });
  });

  it('a Full admin manages the diagram for its owner; others cannot', async () => {
    await sharing.addMember('alice', 'd1', 'bob@example.com', 'admin');
    expect(await sharing.managedBy('alice', 'd1')).toBe('alice');
    expect(await sharing.managedBy('bob', 'd1')).toBe('alice');
    await sharing.setRole('alice', 'd1', 'bob', 'viewer');
    expect(await failure(sharing.managedBy('bob', 'd1'))).toMatchObject({ status: 404 });
    expect(await failure(sharing.managedBy('carol', 'd1'))).toMatchObject({ status: 404 });
  });

  it("an admin cannot add the diagram's owner", async () => {
    await sharing.addMember('alice', 'd1', 'bob@example.com', 'admin');
    expect(await failure(sharing.addMember('alice', 'd1', 'alice@example.com', 'viewer', 'bob'))).toMatchObject({ status: 422, reason: 'self' });
  });
});

describe('proposals (Change needs approval)', () => {
  const PROPOSED = { title: 'Plan', items: [{ id: 'a' }, { id: 'b' }], views: [{ id: 'p', connectors: [{ id: 'c' }] }] };

  it('a proposal is stored with its summary and waits', async () => {
    const proposal = await sharing.propose('alice', 'd1', { sub: 'agent-7', kind: 'agent' }, PROPOSED);
    expect(proposal).toMatchObject({ status: 'pending', by: { sub: 'agent-7', kind: 'agent', email: null }, summary: { items: 2, pages: 1, connectors: 1 } });
    expect(await sharing.pendingProposals('alice', 'd1')).toEqual([expect.objectContaining({ id: proposal.id, stale: false })]);
    expect((await sharing.proposalToApply('alice', 'd1', proposal.id)).document).toEqual(PROPOSED);
  });

  it('the diagram changing since makes it stale: approval needs force', async () => {
    const proposal = await sharing.propose('alice', 'd1', { sub: 'agent-7', kind: 'agent' }, PROPOSED);
    ws.diagram('alice', 'd1', { lastModified: '2026-11-10T09:00:00.000Z' });
    expect((await sharing.pendingProposals('alice', 'd1'))[0].stale).toBe(true);
    expect(await failure(sharing.proposalToApply('alice', 'd1', proposal.id))).toMatchObject({ status: 409, reason: 'stale' });
    await expect(sharing.proposalToApply('alice', 'd1', proposal.id, { force: true })).resolves.toMatchObject({ document: PROPOSED });
  });

  it('resolving takes it off the waiting list and drops its document', async () => {
    const proposal = await sharing.propose('alice', 'd1', { sub: 'agent-7', kind: 'agent' }, PROPOSED);
    const resolved = await sharing.resolveProposal('alice', 'd1', proposal.id, 'rejected', 'alice');
    expect(resolved).toMatchObject({ status: 'rejected', resolvedBy: 'alice' });
    expect(await sharing.pendingProposals('alice', 'd1')).toEqual([]);
    expect(ws.json('alice', `sharing/proposal-docs/d1/${proposal.id}`)).toBeNull();
    expect(await failure(sharing.resolveProposal('alice', 'd1', proposal.id, 'approved', 'alice'))).toMatchObject({ status: 404 });
  });
});

