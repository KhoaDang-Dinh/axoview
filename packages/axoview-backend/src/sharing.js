/**
 * Sharing a server diagram with other accounts (ADR 0057 §5, owner decisions
 * 2026-11-09/10).
 *
 * The diagram stays in its owner's workspace. Small JSON objects, kept through
 * the storage adapter (S3 objects on AWS, files on fs), record who has it:
 *   - owner's workspace:
 *       sharing/members/<diagramId>              { members: [{ sub, email, role, addedAt }] }
 *       sharing/proposed/<diagramId>/<pid>       { id, by, viewId, operations, note, createdAt }
 *       sharing/decided/<diagramId>/<pid>        { status, resolvedBy, resolvedAt, applied?, version? }
 *   - each member's workspace:
 *       sharing/inbox                            { diagrams: [{ id, owner, ownerEmail, role, addedAt }] }
 *
 * Permission levels for people (owner decisions 2026-11-10):
 *   viewer   "Read only": opens the diagram in the read-only viewer (the same
 *            one a public link uses); every write is refused.
 *   admin    "Full admin": everything the owner can do, including adding
 *            people and trashing or deleting the diagram.
 *
 * AI agents are not members. An agent works on its person's account, and that
 * person is its one admin (ADR 0057 addendum 3): it can never do more than
 * its person can on a diagram (agentLevelOn), and the changes it proposes wait
 * for that person alone. Proposals are stored here for agents that act
 * through the workspace MCP server (ADR 0059); the in-app assistant's changes
 * are approved in the chat and need no storage. A proposal holds the agent's
 * operations (the diagramAgent vocabulary), not a document: the person's app
 * checks them against the page as it is when they look, carries out the ones
 * they approve and saves the result against the version it was checked on
 * (server.js, the approve route). So approving never overwrites changes made
 * since.
 *
 * Proposals do not share an object, so no writer can lose another's: each is
 * its own object, created once (the adapter's putIfAbsent) and never changed,
 * and its decision is a second object, also created once. A proposal is
 * waiting while it has no decision; the first decision stands, on every API
 * pod, however many arrive together.
 *
 * The members list and the inbox are each one object that is read, changed
 * and written back. Two writers in the same instant could lose one entry;
 * repeating the action repairs it. Acceptable for this project; the
 * conditional-write version is ADR 0057's DynamoDB layout.
 */
import { randomBytes } from 'crypto';


export const ROLES = Object.freeze(['viewer', 'admin']);
/** What a person lets their agent do: "Read only" or "Changes need my approval". */
export const AGENT_LEVELS = Object.freeze(['viewer', 'proposer']);
// Lookups a manager may make per minute (ADR 0057: "no account" reveals
// whether an address has one, so it is rate-limited).
export const LOOKUPS_PER_MINUTE = 20;
// Membership answers are cached this long per API process, so ordinary loads
// and saves cost no extra read. A change takes effect within this window.
export const CACHE_MS = 10_000;
// Decided proposals kept per diagram for the agents that ask after them; older ones are removed.
export const RESOLVED_KEPT = 50;

const EMAIL_RE = /^[^\s@"\\]{1,64}@[^\s@"\\]{1,255}\.[^\s@"\\]{1,63}$/;
const MEMBERS_KEY = (id) => `sharing/members/${id}`;
const PROPOSAL_PREFIX = (id) => `sharing/proposed/${id}/`;
const DECISION_PREFIX = (id) => `sharing/decided/${id}/`;
const PROPOSAL_ID_RE = /^p_[a-z0-9]{1,12}_[a-f0-9]{16}$/;
// Waiting proposals per diagram and person: an agent cannot bury its person in
// them. Checked before the write, so agents proposing in the same instant can
// pass it together and end a few above it.
export const MAX_WAITING_PROPOSALS = 20;
const INBOX_KEY = 'sharing/inbox';

export class SharingError extends Error {
  /** reason: a stable code the app maps to its message. */
  constructor(status, reason, message) {
    super(message);
    this.status = status;
    this.body = { error: message, reason };
  }
}

export function normalizeEmail(email) {
  const value = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return EMAIL_RE.test(value) ? value : null;
}

/** A permission level a person may hold; throws a 400 otherwise. */
export function assertRole(role) {
  if (!ROLES.includes(role)) throw new SharingError(400, 'invalid-role', 'Unknown permission level');
  return role;
}

/**
 * What an agent may do on a diagram: its person's setting, never above the
 * person. `personRole` is 'owner', 'admin', 'viewer', or null (no access).
 * Returns 'proposer' (changes wait for the person), 'viewer', or null.
 */
export function agentLevelOn(personRole, setting) {
  if (personRole !== 'owner' && personRole !== 'admin') return personRole === 'viewer' ? 'viewer' : null;
  return setting === 'proposer' ? 'proposer' : 'viewer';
}

async function readJson(adapter, key, fallback) {
  const bytes = await adapter.get(key);
  if (!bytes) return fallback;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return fallback;
  }
}

async function writeJson(adapter, key, value) {
  await adapter.put(key, new TextEncoder().encode(JSON.stringify(value)));
}

/** A diagram's name and state from its owner's workspace, or null when gone. */
async function diagramMeta(adapter, id) {
  if (adapter.getDiagramState) {
    const state = await adapter.getDiagramState(id);
    if (!state?.item) return null;
    const { item } = state;
    return {
      name: item.name || 'Untitled Diagram',
      lastModified: item.lastModified || new Date(0).toISOString(),
      deletedAt: item.deletedAt ?? null
    };
  }
  const data = await readJson(adapter, `diagrams/${id}`, null);
  if (!data) return null;
  return {
    name: data.name || data.title || 'Untitled Diagram',
    lastModified: data.lastModified || new Date(0).toISOString(),
    deletedAt: data.deletedAt ?? null
  };
}

/**
 * Create `key` holding `value` unless it exists: true for exactly one of any
 * number of concurrent callers (the adapter's putIfAbsent).
 */
const createJson = (adapter, key, value) =>
  adapter.putIfAbsent(key, new TextEncoder().encode(JSON.stringify(value)));

/** A proposal id: its creation time, so ids sort by age, then 64 random bits. */
function proposalId(at) {
  return `p_${at.toString(36).padStart(9, '0')}_${randomBytes(8).toString('hex')}`;
}

/**
 * @param {object} deps
 * @param {(workspaceId: string) => object} deps.adapterFor  a workspace's storage adapter
 * @param {(email: string) => Promise<{sub: string, email: string} | null>} deps.findUserByEmail
 *        the account with that VERIFIED email, or null
 * @param {(sub: string) => Promise<{sub: string, email: string} | null>} [deps.findUserBySub]
 * @param {() => number} [deps.now]
 */
export function createSharing({ adapterFor, findUserByEmail, findUserBySub = async () => null, now = Date.now }) {
  const inboxCache = new Map(); // sub -> { at, diagrams }
  const membersCache = new Map(); // `${owner}/${id}` -> { at, members }
  const lookups = new Map(); // manager sub -> [timestamps]

  const fresh = (entry) => entry && now() - entry.at < CACHE_MS;
  const iso = () => new Date(now()).toISOString();

  async function inbox(sub) {
    const cached = inboxCache.get(sub);
    if (fresh(cached)) return cached.diagrams;
    const { diagrams = [] } = await readJson(adapterFor(sub), INBOX_KEY, {});
    inboxCache.set(sub, { at: now(), diagrams });
    return diagrams;
  }

  async function members(owner, id) {
    const key = `${owner}/${id}`;
    const cached = membersCache.get(key);
    if (fresh(cached)) return cached.members;
    const list = await readMembers(owner, id);
    membersCache.set(key, { at: now(), members: list });
    return list;
  }

  async function readMembers(owner, id) {
    const { members: list = [] } = await readJson(adapterFor(owner), MEMBERS_KEY(id), {});
    return list;
  }

  async function writeMembers(owner, id, list) {
    await writeJson(adapterFor(owner), MEMBERS_KEY(id), { members: list });
    membersCache.set(`${owner}/${id}`, { at: now(), members: list });
  }

  async function updateInbox(sub, change) {
    const { diagrams = [] } = await readJson(adapterFor(sub), INBOX_KEY, {});
    const next = change(diagrams);
    await writeJson(adapterFor(sub), INBOX_KEY, { diagrams: next });
    inboxCache.set(sub, { at: now(), diagrams: next });
  }

  function countLookup(manager) {
    const minuteAgo = now() - 60_000;
    const recent = (lookups.get(manager) || []).filter((at) => at > minuteAgo);
    if (recent.length >= LOOKUPS_PER_MINUTE) {
      throw new SharingError(429, 'rate-limited', 'Too many sharing attempts: try again in a minute');
    }
    recent.push(now());
    lookups.set(manager, recent);
  }

  /** The live diagram in the owner's workspace, or a 404 (no one learns of others' ids). */
  async function liveDiagram(owner, id) {
    const meta = await diagramMeta(adapterFor(owner), id);
    if (!meta || meta.deletedAt) throw new SharingError(404, 'not-found', 'Diagram not found');
    return meta;
  }

  // Adapters differ in how much of a key list() returns (the fs one adds the
  // workspace's root); the last segment is the proposal id either way. The
  // prefixes end in a slash, so a prefix-matching store (S3) stays inside
  // this diagram.
  async function idsUnder(adapter, prefix) {
    const keys = await adapter.list(prefix);
    return keys.map((key) => key.split('/').pop()).filter((pid) => PROPOSAL_ID_RE.test(pid));
  }

  /** A proposal with its decision folded in, as callers see it. */
  function proposalView(proposal, decision) {
    if (!decision) return { ...proposal, status: 'pending' };
    return {
      ...proposal,
      status: decision.status,
      resolvedBy: decision.resolvedBy,
      resolvedAt: decision.resolvedAt,
      ...(Number.isInteger(decision.applied) ? { applied: decision.applied } : {}),
      ...(Number.isInteger(decision.version) ? { version: decision.version } : {})
    };
  }

  /** Proposal `pid` when `sub`'s agent made it, with its decision if it has one; else a 404. */
  async function ownProposal(owner, id, pid, sub) {
    const adapter = adapterFor(owner);
    const proposal = PROPOSAL_ID_RE.test(pid) ? await readJson(adapter, `${PROPOSAL_PREFIX(id)}${pid}`, null) : null;
    if (!proposal || proposal.by?.sub !== sub) throw new SharingError(404, 'no-proposal', 'No such proposal');
    return { proposal, decision: await readJson(adapter, `${DECISION_PREFIX(id)}${pid}`, null) };
  }

  /** The proposals nobody has decided, newest first. */
  async function waitingProposals(owner, id) {
    const adapter = adapterFor(owner);
    const [made, decided] = await Promise.all([
      idsUnder(adapter, PROPOSAL_PREFIX(id)),
      idsUnder(adapter, DECISION_PREFIX(id))
    ]);
    const done = new Set(decided);
    const waiting = made.filter((pid) => !done.has(pid)).sort().reverse();
    const records = await Promise.all(waiting.map((pid) => readJson(adapter, `${PROPOSAL_PREFIX(id)}${pid}`, null)));
    return records.filter(Boolean);
  }

  /**
   * Remove decided proposals beyond the newest RESOLVED_KEPT. The proposal
   * goes first and its decision second: a proposal is never left without the
   * decision it was given, so it cannot come back as waiting. Best effort:
   * what one pass misses the next removes.
   */
  async function pruneDecided(owner, id) {
    const adapter = adapterFor(owner);
    try {
      const old = (await idsUnder(adapter, DECISION_PREFIX(id))).sort().reverse().slice(RESOLVED_KEPT);
      for (const pid of old) {
        await adapter.delete(`${PROPOSAL_PREFIX(id)}${pid}`);
        await adapter.delete(`${DECISION_PREFIX(id)}${pid}`);
      }
    } catch {
      /* the next decision tries again */
    }
  }

  return {
    /**
     * A person's access to someone else's diagram `id`: { owner, role }, or
     * null (their own diagram, or none of theirs).
     */
    async accessTo(sub, id) {
      const entry = (await inbox(sub)).find((d) => d.id === id);
      return entry ? { owner: entry.owner, role: entry.role } : null;
    },

    /**
     * Who manages diagram `id` for this person: its owner, or an admin it is
     * shared with. Returns the owner's workspace id; 404 for anyone else.
     */
    async managedBy(sub, id) {
      const own = await diagramMeta(adapterFor(sub), id);
      if (own && !own.deletedAt) return sub;
      const access = await this.accessTo(sub, id);
      if (access?.role === 'admin') {
        await liveDiagram(access.owner, id);
        return access.owner;
      }
      throw new SharingError(404, 'not-found', 'Diagram not found');
    },

    /** The people a diagram is shared with. */
    async listMembers(owner, id) {
      await liveDiagram(owner, id);
      return (await readMembers(owner, id)).map(({ sub, email, role, addedAt }) => ({ sub, email, role, addedAt }));
    },

    /** Members to tell about a change, with their roles (for fan-out and notices). */
    async memberRoles(owner, id) {
      return (await members(owner, id)).map((m) => ({ sub: m.sub, role: m.role }));
    },

    /** Subs of everyone the diagram is shared with. */
    async memberSubs(owner, id) {
      return (await members(owner, id)).map((m) => m.sub);
    },

    /** Add the person with this verified email, at `role`. */
    async addMember(owner, id, rawEmail, role = 'viewer', manager = owner) {
      const email = normalizeEmail(rawEmail);
      if (!email) throw new SharingError(400, 'invalid-email', 'Enter a valid email address');
      assertRole(role);
      await liveDiagram(owner, id);
      countLookup(manager);
      const user = await findUserByEmail(email);
      if (!user) throw new SharingError(404, 'no-account', 'No Axoview account uses that email');
      if (user.sub === owner) throw new SharingError(422, 'self', "That's the diagram's owner");
      if (user.sub === manager) throw new SharingError(422, 'self', "You can't share a diagram with yourself");
      const list = await readMembers(owner, id);
      if (list.some((m) => m.sub === user.sub)) {
        throw new SharingError(409, 'already-shared', `Already shared with ${email}`);
      }
      const member = { sub: user.sub, email, role, addedAt: iso() };
      await writeMembers(owner, id, [...list, member]);
      const ownerUser = await findUserBySub(owner).catch(() => null);
      await updateInbox(user.sub, (theirs) => [
        ...theirs.filter((d) => d.id !== id),
        { id, owner, ownerEmail: ownerUser?.email || null, role, addedAt: member.addedAt }
      ]);
      return member;
    },

    /** Change a member's permission level. */
    async setRole(owner, id, sub, role) {
      await liveDiagram(owner, id);
      const list = await readMembers(owner, id);
      const member = list.find((m) => m.sub === sub);
      if (!member) throw new SharingError(404, 'not-a-member', 'Not shared with that person');
      assertRole(role);
      const updated = { ...member, role };
      await writeMembers(owner, id, list.map((m) => (m.sub === sub ? updated : m)));
      await updateInbox(sub, (theirs) => theirs.map((d) => (d.id === id && d.owner === owner ? { ...d, role } : d)));
      return updated;
    },

    /** Take a person off a diagram. */
    async removeMember(owner, id, sub) {
      await liveDiagram(owner, id);
      const list = await readMembers(owner, id);
      if (!list.some((m) => m.sub === sub)) throw new SharingError(404, 'not-a-member', 'Not shared with that person');
      await writeMembers(owner, id, list.filter((m) => m.sub !== sub));
      await updateInbox(sub, (theirs) => theirs.filter((d) => !(d.id === id && d.owner === owner)));
    },

    /**
     * Diagrams shared with this person, as listing rows (the owner's name and
     * time, and this person's role). Ones the owner deleted or trashed are left out.
     */
    async sharedWithMe(sub) {
      const rows = await Promise.all((await inbox(sub)).map(async (entry) => {
        const meta = await diagramMeta(adapterFor(entry.owner), entry.id).catch(() => null);
        if (!meta || meta.deletedAt) return null;
        return {
          id: entry.id,
          name: meta.name,
          lastModified: meta.lastModified,
          folderId: null,
          deletedAt: null,
          shared: { role: entry.role, ownerEmail: entry.ownerEmail || null }
        };
      }));
      return rows.filter(Boolean);
    },

    // -------------------------------------------------------------------------
    // Proposals: changes an agent made under "Changes need my approval"
    // -------------------------------------------------------------------------

    /**
     * Store an agent's proposed operations. `by`: the person the agent works
     * for (`sub`) and which agent (`agent`, the client's name). `operations`
     * are already validated (ai/suggestions.js). Returns the proposal record.
     */
    async propose(owner, id, by, { viewId = null, operations, note = null }) {
      await liveDiagram(owner, id);
      const waiting = (await waitingProposals(owner, id)).filter((p) => p.by?.sub === by.sub);
      if (waiting.length >= MAX_WAITING_PROPOSALS) {
        throw new SharingError(429, 'too-many-proposals', `${MAX_WAITING_PROPOSALS} changes are already waiting for approval on this diagram`);
      }
      // Its own object, created only if no object has that id: proposals made
      // in the same instant, here or on another API pod, are all kept.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const proposal = {
          id: proposalId(now()),
          by: { sub: by.sub, agent: by.agent || null },
          viewId,
          operations,
          note,
          createdAt: iso()
        };
        if (await createJson(adapterFor(owner), `${PROPOSAL_PREFIX(id)}${proposal.id}`, proposal)) {
          return proposalView(proposal, null);
        }
      }
      throw new SharingError(503, 'try-again', 'Could not store the proposal: try again');
    },

    /** Proposals waiting for this person (their own agents' only), newest first. */
    async pendingProposals(owner, id, sub) {
      await liveDiagram(owner, id);
      return (await waitingProposals(owner, id)).filter((p) => p.by?.sub === sub).map((p) => proposalView(p, null));
    },

    /** One of this person's proposals on a diagram, in any state (for the agent asking after it). */
    async proposalFor(owner, id, pid, sub) {
      const { proposal, decision } = await ownProposal(owner, id, pid, sub);
      return proposalView(proposal, decision);
    },

    /**
     * `by` (the agent's person) approves or rejects a proposal. The first
     * decision stands: it is created once, so of any number arriving together
     * exactly one is recorded. Repeating the decision already recorded returns
     * it (a retry after a lost answer); the other one is refused with a 409.
     *
     * When approved, `applied` is how many of its steps were made and
     * `version` the diagram version that holds them. Call this for an
     * approval only after the diagram is saved: the agent reads the decision.
     */
    async resolveProposal(owner, id, pid, status, by, { applied = null, version = null } = {}) {
      const { proposal } = await ownProposal(owner, id, pid, by);
      const decision = {
        status,
        resolvedBy: by,
        resolvedAt: iso(),
        ...(status === 'approved' && Number.isInteger(applied) ? { applied } : {}),
        ...(status === 'approved' && Number.isInteger(version) ? { version } : {})
      };
      const adapter = adapterFor(owner);
      const key = `${DECISION_PREFIX(id)}${pid}`;
      if (await createJson(adapter, key, decision)) {
        await pruneDecided(owner, id);
        return proposalView(proposal, decision);
      }
      const recorded = await readJson(adapter, key, null);
      if (recorded?.status === status) return proposalView(proposal, recorded);
      throw new SharingError(409, 'already-decided', recorded?.status === 'approved'
        ? 'That proposal was already approved'
        : 'That proposal was already rejected');
    }
  };
}
