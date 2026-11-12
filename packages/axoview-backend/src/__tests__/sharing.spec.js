import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createSharing, normalizeEmail, assertRole, agentLevelOn, CACHE_MS, LOOKUPS_PER_MINUTE, MAX_WAITING_PROPOSALS, RESOLVED_KEPT
} from '../sharing.js';
import { createFsObjectStorage } from '../adapters/fs.js';
import { createAwsWorkspaceAdapter } from '../adapters/aws.js';
import { addWorkspaceScope } from '../adapters/workspace.js';
import { makeAwsDoubles } from './helpers/awsDoubles.js';
import { createAgentSettings } from '../agentSettings.js';
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
      // Every call takes a turn of the event loop, as real storage does, so
      // callers that run together really interleave.
      const turn = () => new Promise((resolve) => setImmediate(resolve));
      return {
        async get(key) {
          reads.push(`${ws}:${key}`);
          await turn();
          return store(ws).get(key) ?? null;
        },
        async put(key, value) {
          await turn();
          store(ws).set(key, value);
        },
        async putIfAbsent(key, value) {
          await turn();
          if (store(ws).has(key)) return false;
          store(ws).set(key, value);
          return true;
        },
        async list(prefix) {
          await turn();
          return [...store(ws).keys()].filter((key) => key.startsWith(prefix));
        },
        async delete(key) {
          await turn();
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
    expect(member).toEqual({ sub: 'bob', email: 'bob@example.com', role: 'admin', addedAt: expect.any(String) });
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
  it('people are Read only or Full admin; nothing else', () => {
    for (const role of ['viewer', 'admin']) expect(assertRole(role)).toBe(role);
    for (const role of ['proposer', 'owner']) {
      expect(() => assertRole(role)).toThrow(expect.objectContaining({ status: 400, body: expect.objectContaining({ reason: 'invalid-role' }) }));
    }
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

describe('agents: on their person\'s account, never above them', () => {
  it('the person\'s setting applies where they may change the diagram; Read only where they may not', () => {
    expect(agentLevelOn('owner', 'proposer')).toBe('proposer');
    expect(agentLevelOn('admin', 'proposer')).toBe('proposer');
    expect(agentLevelOn('owner', 'viewer')).toBe('viewer');
    expect(agentLevelOn('viewer', 'proposer')).toBe('viewer');
    expect(agentLevelOn(null, 'proposer')).toBeNull();
  });

  it('the setting: Read only by default, kept in the person\'s workspace, and nothing above approval', async () => {
    const settings = createAgentSettings({ adapterFor: ws.adapterFor });
    expect(await settings.get('alice')).toEqual({ level: 'viewer' });
    expect(await settings.set('alice', 'proposer')).toEqual({ level: 'proposer' });
    expect(await settings.get('alice')).toEqual({ level: 'proposer' });
    expect(await settings.get('bob')).toEqual({ level: 'viewer' });
    expect(await failure(settings.set('alice', 'admin'))).toMatchObject({ status: 400, reason: 'invalid-level' });
    ws.put('alice', 'agents/settings', { level: 'admin' });
    expect(await settings.get('alice')).toEqual({ level: 'viewer' });
  });
});

describe('proposals (Changes need my approval): only the agent\'s person sees and decides them', () => {
  const OPS = [{ op: 'add_node', name: 'Cache' }, { op: 'connect', from: { name: 'Web' }, to: { name: 'Cache' } }];
  const BOBS_AGENT = { sub: 'bob', agent: 'Claude Code' };

  it('a proposal holds the operations, waits for its person alone, and is found again by them', async () => {
    const proposal = await sharing.propose('alice', 'd1', BOBS_AGENT, { viewId: 'p1', operations: OPS, note: 'Add a cache' });
    expect(proposal).toMatchObject({ status: 'pending', by: BOBS_AGENT, viewId: 'p1', operations: OPS, note: 'Add a cache' });
    expect(await sharing.pendingProposals('alice', 'd1', 'bob')).toEqual([proposal]);
    // The owner does not review someone else's agent.
    expect(await sharing.pendingProposals('alice', 'd1', 'alice')).toEqual([]);
    expect(await failure(sharing.resolveProposal('alice', 'd1', proposal.id, 'rejected', 'alice'))).toMatchObject({ status: 404 });
    expect(await failure(sharing.proposalFor('alice', 'd1', proposal.id, 'alice'))).toMatchObject({ status: 404 });
    expect(await sharing.proposalFor('alice', 'd1', proposal.id, 'bob')).toEqual(proposal);
  });

  it('approving records how many steps were made and the version that holds them; then it is no longer waiting', async () => {
    const proposal = await sharing.propose('alice', 'd1', BOBS_AGENT, { operations: OPS });
    const resolved = await sharing.resolveProposal('alice', 'd1', proposal.id, 'approved', 'bob', { applied: 1, version: 7 });
    expect(resolved).toMatchObject({ id: proposal.id, status: 'approved', resolvedBy: 'bob', applied: 1, version: 7, operations: OPS });
    expect(await sharing.pendingProposals('alice', 'd1', 'bob')).toEqual([]);
    expect(await sharing.proposalFor('alice', 'd1', proposal.id, 'bob')).toEqual(resolved);
  });

  it('the first decision stands: the other one is refused, the same one again is returned as recorded', async () => {
    const proposal = await sharing.propose('alice', 'd1', BOBS_AGENT, { operations: OPS });
    const first = await sharing.resolveProposal('alice', 'd1', proposal.id, 'approved', 'bob', { applied: 2 });
    expect(await failure(sharing.resolveProposal('alice', 'd1', proposal.id, 'rejected', 'bob')))
      .toMatchObject({ status: 409, reason: 'already-decided' });
    clock += 5000;
    // A retry (the first answer was lost on the way) changes nothing.
    expect(await sharing.resolveProposal('alice', 'd1', proposal.id, 'approved', 'bob', { applied: 0 })).toEqual(first);
    expect(await sharing.proposalFor('alice', 'd1', proposal.id, 'bob')).toEqual(first);
  });

  it('a proposal id that is not one, or names nothing, is a 404', async () => {
    for (const pid of ['nope', '../members/d1', 'p_000000000_0000000000000000']) {
      expect(await failure(sharing.proposalFor('alice', 'd1', pid, 'bob'))).toMatchObject({ status: 404, reason: 'no-proposal' });
      expect(await failure(sharing.resolveProposal('alice', 'd1', pid, 'approved', 'bob'))).toMatchObject({ status: 404 });
    }
  });

  it(`an agent cannot bury its person: at most ${MAX_WAITING_PROPOSALS} waiting per diagram`, async () => {
    for (let i = 0; i < MAX_WAITING_PROPOSALS; i++) await sharing.propose('alice', 'd1', BOBS_AGENT, { operations: OPS });
    expect(await failure(sharing.propose('alice', 'd1', BOBS_AGENT, { operations: OPS }))).toMatchObject({ status: 429, reason: 'too-many-proposals' });
    // Someone else's agent is not held up by it.
    await expect(sharing.propose('alice', 'd1', { sub: 'alice', agent: 'Codex' }, { operations: OPS })).resolves.toMatchObject({ status: 'pending' });
  });
});

// The same behaviour on each kind of storage the API runs on. They differ in
// what list() returns (the fs scope adds its root and lists one level; S3
// matches any key that starts with the prefix), and in how "create only if
// absent" is done (a hard link; If-None-Match).
describe.each([
  ['in memory', () => memoryWorkspaces().adapterFor],
  ['files, through the workspace scope', (dir) => {
    const scoped = addWorkspaceScope(createFsObjectStorage(dir));
    return (workspace) => scoped.forWorkspace(workspace);
  }],
  ['AWS (S3 doubles)', () => {
    const doubles = makeAwsDoubles();
    return (workspace) => createAwsWorkspaceAdapter({ workspaceId: workspace, bucketName: 'data', tableName: 'app', ...doubles });
  }]
])('proposals are stored one by one, so none is lost: %s', (_name, makeAdapterFor) => {
  const OPS = [{ op: 'add_node', name: 'Cache' }];
  const DIAGRAM = new TextEncoder().encode(JSON.stringify({ name: 'Plan', lastModified: '2026-11-10T00:00:00.000Z' }));
  let dir;
  let store;
  let time;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axoview-proposals-'));
    const adapterFor = makeAdapterFor(dir);
    time = Date.UTC(2026, 10, 12);
    store = createSharing({
      // The diagrams d1 and d10 exist in every workspace; everything else is the real adapter.
      adapterFor: (workspace) => {
        const adapter = adapterFor(workspace);
        return {
          get: (key) => (key === 'diagrams/d1' || key === 'diagrams/d10' ? Promise.resolve(DIAGRAM) : adapter.get(key)),
          put: (...args) => adapter.put(...args),
          putIfAbsent: (...args) => adapter.putIfAbsent(...args),
          list: (...args) => adapter.list(...args),
          delete: (...args) => adapter.delete(...args)
        };
      },
      findUserByEmail: async () => null,
      now: () => time
    });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('proposals made at the same moment by several agents are all kept', async () => {
    const people = ['ann', 'bob', 'cy', 'di'];
    const made = await Promise.all(people.flatMap((sub) => Array.from({ length: 10 }, (_, i) =>
      store.propose('alice', 'd1', { sub, agent: `agent-${i}` }, { operations: OPS, note: `${sub} ${i}` }))));
    expect(new Set(made.map((p) => p.id)).size).toBe(40);
    for (const sub of people) {
      const waiting = await store.pendingProposals('alice', 'd1', sub);
      expect(waiting.map((p) => p.note).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `${sub} ${i}`));
      expect(waiting.every((p) => p.status === 'pending' && p.by.sub === sub)).toBe(true);
    }
  });

  it('a diagram whose id begins with another\'s keeps its own proposals', async () => {
    const one = await store.propose('alice', 'd1', { sub: 'bob' }, { operations: OPS });
    const ten = await store.propose('alice', 'd10', { sub: 'bob' }, { operations: OPS });
    expect((await store.pendingProposals('alice', 'd1', 'bob')).map((p) => p.id)).toEqual([one.id]);
    expect((await store.pendingProposals('alice', 'd10', 'bob')).map((p) => p.id)).toEqual([ten.id]);
    expect(await failure(store.proposalFor('alice', 'd1', ten.id, 'bob'))).toMatchObject({ status: 404 });
  });

  it('waiting proposals come newest first', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      time += 1000;
      ids.push((await store.propose('alice', 'd1', { sub: 'bob' }, { operations: OPS })).id);
    }
    expect((await store.pendingProposals('alice', 'd1', 'bob')).map((p) => p.id)).toEqual(ids.reverse());
  });

  it('of decisions arriving together exactly one is recorded, and everyone who is answered hears that one', async () => {
    const proposal = await store.propose('alice', 'd1', { sub: 'bob' }, { operations: OPS });
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
      store.resolveProposal('alice', 'd1', proposal.id, i % 2 ? 'approved' : 'rejected', 'bob', { applied: 1 })));
    const answered = attempts.filter((a) => a.status === 'fulfilled').map((a) => a.value);
    const refused = attempts.filter((a) => a.status === 'rejected').map((a) => a.reason);
    const recorded = await store.proposalFor('alice', 'd1', proposal.id, 'bob');
    expect(['approved', 'rejected']).toContain(recorded.status);
    // The ten that asked for the recorded decision get it, identical; the other ten are refused.
    expect(answered).toHaveLength(10);
    for (const answer of answered) expect(answer).toEqual(recorded);
    expect(refused).toHaveLength(10);
    for (const error of refused) expect(error).toMatchObject({ status: 409, body: { reason: 'already-decided' } });
    expect(await store.pendingProposals('alice', 'd1', 'bob')).toEqual([]);
  });

  it(`keeps the newest ${RESOLVED_KEPT} decided proposals and every waiting one`, async () => {
    const decided = [];
    time += 1000;
    const waiting = await store.propose('alice', 'd1', { sub: 'bob' }, { operations: OPS });
    for (let i = 0; i < RESOLVED_KEPT + 3; i++) {
      time += 1000;
      const proposal = await store.propose('alice', 'd1', { sub: 'bob' }, { operations: OPS });
      await store.resolveProposal('alice', 'd1', proposal.id, i % 2 ? 'approved' : 'rejected', 'bob');
      decided.push(proposal.id);
    }
    for (const pid of decided.slice(0, 3)) {
      expect(await failure(store.proposalFor('alice', 'd1', pid, 'bob'))).toMatchObject({ status: 404 });
    }
    for (const pid of decided.slice(3)) {
      expect((await store.proposalFor('alice', 'd1', pid, 'bob')).status).not.toBe('pending');
    }
    // The oldest of all is still waiting: only decided ones are removed.
    expect((await store.pendingProposals('alice', 'd1', 'bob')).map((p) => p.id)).toEqual([waiting.id]);
  });
});
