/**
 * Sharing a server diagram with another account by email (ADR 0057 §5, owner
 * decisions 2026-11-09/10).
 *
 * The diagram stays in its owner's workspace. Two small JSON objects, kept in
 * each side's own workspace through the storage adapter (S3 objects on AWS,
 * files on the fs adapter), record who has it:
 *   - owner:  sharing/members/<diagramId>  { members: [{ sub, email, role, addedAt }] }
 *   - member: sharing/inbox                { diagrams: [{ id, owner, ownerEmail, role, addedAt }] }
 * Every member is an editor. Only the owner adds or removes people; emails
 * are shown only to the owner who typed them.
 *
 * Each object is read, changed and written back. Two owners sharing with the
 * same person in the same instant could lose one inbox entry; the owner's
 * member list still has it, and sharing again repairs it. Acceptable for this
 * project; the conditional-write version is ADR 0057's DynamoDB layout.
 */

export const ROLE_EDITOR = 'editor';
// Lookups an owner may make per minute (ADR 0057: "no account" reveals whether
// an address has one, so it is rate-limited).
export const LOOKUPS_PER_MINUTE = 20;
// Membership answers are cached this long per API process, so ordinary loads
// and saves cost no extra read. A removal takes effect within this window.
export const CACHE_MS = 10_000;

const EMAIL_RE = /^[^\s@"\\]{1,64}@[^\s@"\\]{1,255}\.[^\s@"\\]{1,63}$/;
const MEMBERS_KEY = (id) => `sharing/members/${id}`;
const INBOX_KEY = 'sharing/inbox';

export class SharingError extends Error {
  /** reason: a stable code the app maps to its red message. */
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
  const lookups = new Map(); // owner sub -> [timestamps]

  const fresh = (entry) => entry && now() - entry.at < CACHE_MS;

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
    const { members: list = [] } = await readJson(adapterFor(owner), MEMBERS_KEY(id), {});
    membersCache.set(key, { at: now(), members: list });
    return list;
  }

  async function writeMembers(owner, id, list) {
    await writeJson(adapterFor(owner), MEMBERS_KEY(id), { members: list });
    membersCache.set(`${owner}/${id}`, { at: now(), members: list });
  }

  async function writeInbox(sub, diagrams) {
    await writeJson(adapterFor(sub), INBOX_KEY, { diagrams });
    inboxCache.set(sub, { at: now(), diagrams });
  }

  function countLookup(owner) {
    const minuteAgo = now() - 60_000;
    const recent = (lookups.get(owner) || []).filter((at) => at > minuteAgo);
    if (recent.length >= LOOKUPS_PER_MINUTE) {
      throw new SharingError(429, 'rate-limited', 'Too many sharing attempts: try again in a minute');
    }
    recent.push(now());
    lookups.set(owner, recent);
  }

  /** The owner's own, live diagram, or a 404 (no one learns of others' ids). */
  async function ownedDiagram(owner, id) {
    const meta = await diagramMeta(adapterFor(owner), id);
    if (!meta || meta.deletedAt) throw new SharingError(404, 'not-found', 'Diagram not found');
    return meta;
  }

  return {
    /**
     * Where a signed-in person reaches diagram `id`: their own workspace, or
     * the owner's when it was shared with them. { owner, role } or null.
     */
    async accessTo(sub, id) {
      const entry = (await inbox(sub)).find((d) => d.id === id);
      return entry ? { owner: entry.owner, role: entry.role || ROLE_EDITOR } : null;
    },

    /** The people a diagram is shared with (owner only). */
    async listMembers(owner, id) {
      await ownedDiagram(owner, id);
      return (await members(owner, id)).map(({ sub, email, role, addedAt }) => ({ sub, email, role, addedAt }));
    },

    /** Subs of everyone the diagram is shared with (for change fan-out). */
    async memberSubs(owner, id) {
      return (await members(owner, id)).map((m) => m.sub);
    },

    /** Add the account with this verified email as an editor. */
    async addMember(owner, id, rawEmail) {
      const email = normalizeEmail(rawEmail);
      if (!email) throw new SharingError(400, 'invalid-email', 'Enter a valid email address');
      await ownedDiagram(owner, id);
      countLookup(owner);
      const user = await findUserByEmail(email);
      if (!user) throw new SharingError(404, 'no-account', 'No Axoview account uses that email');
      if (user.sub === owner) throw new SharingError(422, 'self', "You can't share a diagram with yourself");
      const list = await readJson(adapterFor(owner), MEMBERS_KEY(id), {}).then((v) => v.members || []);
      if (list.some((m) => m.sub === user.sub)) {
        throw new SharingError(409, 'already-shared', `Already shared with ${email}`);
      }
      const addedAt = new Date(now()).toISOString();
      const member = { sub: user.sub, email, role: ROLE_EDITOR, addedAt };
      await writeMembers(owner, id, [...list, member]);
      const ownerUser = await findUserBySub(owner).catch(() => null);
      const theirs = await readJson(adapterFor(user.sub), INBOX_KEY, {}).then((v) => v.diagrams || []);
      await writeInbox(user.sub, [
        ...theirs.filter((d) => d.id !== id),
        { id, owner, ownerEmail: ownerUser?.email || null, role: ROLE_EDITOR, addedAt }
      ]);
      return member;
    },

    /** Take a person off a diagram (owner only). */
    async removeMember(owner, id, sub) {
      await ownedDiagram(owner, id);
      const list = await readJson(adapterFor(owner), MEMBERS_KEY(id), {}).then((v) => v.members || []);
      if (!list.some((m) => m.sub === sub)) throw new SharingError(404, 'not-a-member', 'Not shared with that person');
      await writeMembers(owner, id, list.filter((m) => m.sub !== sub));
      const theirs = await readJson(adapterFor(sub), INBOX_KEY, {}).then((v) => v.diagrams || []);
      await writeInbox(sub, theirs.filter((d) => !(d.id === id && d.owner === owner)));
    },

    /**
     * Diagrams shared with this person, as listing rows (the owner's name and
     * time). Ones the owner deleted or trashed are left out.
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
          shared: { role: entry.role || ROLE_EDITOR, ownerEmail: entry.ownerEmail || null }
        };
      }));
      return rows.filter(Boolean);
    }
  };
}
