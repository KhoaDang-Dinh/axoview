import { describe, it, expect, beforeEach } from '@jest/globals';
import { createSharing, normalizeEmail, CACHE_MS, LOOKUPS_PER_MINUTE } from '../sharing.js';
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
        }
      };
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
  it('an account with that verified email becomes an editor, and the diagram shows on their side', async () => {
    const member = await sharing.addMember('alice', 'd1', '  Bob@Example.com ');
    expect(member).toEqual({ sub: 'bob', email: 'bob@example.com', role: 'editor', addedAt: expect.any(String) });
    expect(ws.json('alice', 'sharing/members/d1').members).toHaveLength(1);
    expect(await sharing.sharedWithMe('bob')).toEqual([{
      id: 'd1',
      name: 'Plan',
      lastModified: '2026-11-10T00:00:00.000Z',
      folderId: null,
      deletedAt: null,
      shared: { role: 'editor', ownerEmail: 'alice@example.com' }
    }]);
    expect(await sharing.accessTo('bob', 'd1')).toEqual({ owner: 'alice', role: 'editor' });
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
