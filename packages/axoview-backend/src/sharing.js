/**
 * Sharing a server diagram with other accounts (ADR 0057 §5, owner decisions
 * 2026-11-09/10).
 *
 * The diagram stays in its owner's workspace. Small JSON objects, kept through
 * the storage adapter (S3 objects on AWS, files on fs), record who has it:
 *   - owner's workspace:
 *       sharing/members/<diagramId>              { members: [{ sub, email, kind, role, addedAt }] }
 *       sharing/proposals/<diagramId>            { proposals: [{ id, by, baseStamp, createdAt, status, ... }] }
 *       sharing/proposal-docs/<diagramId>/<pid>  the proposed document
 *   - each member's workspace:
 *       sharing/inbox                            { diagrams: [{ id, owner, ownerEmail, role, addedAt }] }
 *
 * Permission levels (owner decision 2026-11-10):
 *   viewer   "Read only": opens the diagram in the read-only viewer (the same
 *            one a public link uses); every write is refused.
 *   proposer "Change needs approval": for AI agents. A save becomes a
 *            proposal that the owner or an admin approves or rejects.
 *   admin    "Full admin": everything the owner can do, including adding
 *            people and trashing or deleting the diagram.
 * An agent may hold viewer or proposer, never admin. People may hold any level
 * (the app offers them viewer and admin only, for now).
 *
 * Each object is read, changed and written back. Two writers in the same
 * instant could lose one entry; repeating the action repairs it. Acceptable
 * for this project; the conditional-write version is ADR 0057's DynamoDB layout.
 */

export const ROLES = Object.freeze(['viewer', 'proposer', 'admin']);
export const KINDS = Object.freeze(['person', 'agent']);
// Lookups a manager may make per minute (ADR 0057: "no account" reveals
// whether an address has one, so it is rate-limited).
export const LOOKUPS_PER_MINUTE = 20;
// Membership answers are cached this long per API process, so ordinary loads
// and saves cost no extra read. A change takes effect within this window.
export const CACHE_MS = 10_000;
// Resolved proposals kept for the record, newest first.
const RESOLVED_KEPT = 50;

const EMAIL_RE = /^[^\s@"\\]{1,64}@[^\s@"\\]{1,255}\.[^\s@"\\]{1,63}$/;
const MEMBERS_KEY = (id) => `sharing/members/${id}`;
const PROPOSALS_KEY = (id) => `sharing/proposals/${id}`;
const PROPOSAL_DOC_KEY = (id, pid) => `sharing/proposal-docs/${id}/${pid}`;
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

/** A role this kind of member may hold; throws a 400 otherwise. */
export function assertRole(role, kind = 'person') {
  if (!ROLES.includes(role)) throw new SharingError(400, 'invalid-role', 'Unknown permission level');
  if (!KINDS.includes(kind)) throw new SharingError(400, 'invalid-kind', 'Unknown kind of member');
  if (kind === 'agent' && role === 'admin') {
    throw new SharingError(400, 'agent-not-admin', 'An AI agent can be Read only or Change needs approval, never Full admin');
  }
  return role;
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
      deletedAt: item.deletedAt ?? null,
      stamp: state.version != null ? `v${state.version}` : `t${item.lastModified || ''}`
    };
  }
  const data = await readJson(adapter, `diagrams/${id}`, null);
  if (!data) return null;
  return {
    name: data.name || data.title || 'Untitled Diagram',
    lastModified: data.lastModified || new Date(0).toISOString(),
    deletedAt: data.deletedAt ?? null,
    stamp: `t${data.lastModified || ''}`
  };
}

function randomId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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

  async function readProposals(owner, id) {
    const { proposals = [] } = await readJson(adapterFor(owner), PROPOSALS_KEY(id), {});
    return proposals;
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

    /** The people and agents a diagram is shared with. */
    async listMembers(owner, id) {
      await liveDiagram(owner, id);
      return (await readMembers(owner, id)).map(({ sub, email, kind, role, addedAt }) => ({
        sub, email, kind: kind || 'person', role, addedAt
      }));
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
      assertRole(role, 'person');
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
      const member = { sub: user.sub, email, kind: 'person', role, addedAt: iso() };
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
      assertRole(role, member.kind || 'person');
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
    // Proposals: saves made under "Change needs approval"
    // -------------------------------------------------------------------------

    /**
     * Store a proposed document. `baseStamp`: the version the proposer edited
     * (`v<n>`), else the diagram's state now. Returns the proposal record.
     */
    async propose(owner, id, by, document, baseStamp) {
      const meta = await liveDiagram(owner, id);
      const proposal = {
        id: randomId(),
        by: { sub: by.sub, email: by.email || null, kind: by.kind || 'person' },
        baseStamp: baseStamp || meta.stamp,
        createdAt: iso(),
        status: 'pending',
        summary: summarize(document)
      };
      await writeJson(adapterFor(owner), PROPOSAL_DOC_KEY(id, proposal.id), document);
      const list = await readProposals(owner, id);
      await writeJson(adapterFor(owner), PROPOSALS_KEY(id), { proposals: [proposal, ...list] });
      return proposal;
    },

    /** Proposals waiting for a decision, newest first, each marked stale or not. */
    async pendingProposals(owner, id) {
      const meta = await liveDiagram(owner, id);
      return (await readProposals(owner, id))
        .filter((p) => p.status === 'pending')
        .map((p) => ({ ...p, stale: p.baseStamp !== meta.stamp }));
    },

    /**
     * Take a pending proposal for approval: its record and document. Refused
     * when the diagram changed since it was proposed, unless `force`.
     */
    async proposalToApply(owner, id, pid, { force = false } = {}) {
      const meta = await liveDiagram(owner, id);
      const proposal = (await readProposals(owner, id)).find((p) => p.id === pid);
      if (!proposal || proposal.status !== 'pending') {
        throw new SharingError(404, 'no-proposal', 'That proposal is no longer waiting');
      }
      if (!force && proposal.baseStamp !== meta.stamp) {
        throw new SharingError(409, 'stale', 'The diagram changed since this was proposed');
      }
      const document = await readJson(adapterFor(owner), PROPOSAL_DOC_KEY(id, pid), null);
      if (!document) throw new SharingError(404, 'no-proposal', 'That proposal is no longer waiting');
      return { proposal, document };
    },

    /** Mark a proposal approved or rejected, and drop its document. */
    async resolveProposal(owner, id, pid, status, by) {
      const list = await readProposals(owner, id);
      const proposal = list.find((p) => p.id === pid);
      if (!proposal || proposal.status !== 'pending') {
        throw new SharingError(404, 'no-proposal', 'That proposal is no longer waiting');
      }
      const resolved = { ...proposal, status, resolvedBy: by, resolvedAt: iso() };
      const pending = list.filter((p) => p.status === 'pending' && p.id !== pid);
      const done = [resolved, ...list.filter((p) => p.status !== 'pending')].slice(0, RESOLVED_KEPT);
      await writeJson(adapterFor(owner), PROPOSALS_KEY(id), { proposals: [...pending, ...done] });
      try {
        await adapterFor(owner).delete(PROPOSAL_DOC_KEY(id, pid));
      } catch {
        /* a left-behind document is harmless: nothing lists it */
      }
      return resolved;
    }
  };
}

/** Counts a reviewer can read at a glance: items and pages in the proposal. */
function summarize(document) {
  const views = Array.isArray(document?.views) ? document.views : [];
  return {
    items: Array.isArray(document?.items) ? document.items.length : 0,
    pages: views.length,
    connectors: views.reduce((n, v) => n + (Array.isArray(v?.connectors) ? v.connectors.length : 0), 0)
  };
}
