/**
 * What an agent working as a person may read of their workspace: their own
 * diagrams and the ones shared with them, never more (ADR 0057 addendum 3).
 * Shared by the workspace MCP server (workspaceMcp.js, outside agents) and the
 * in-app assistant's agent loop (novaAgent.js), so both see the same thing.
 */
import { describeDiagram } from './describeDiagram.js';

/**
 * @param {object} deps
 * @param {object} deps.sharing  src/sharing.js
 * @param {(workspaceId: string) => object} deps.adapterFor
 * @param {(adapter: object, id: string) => Promise<object|null>} deps.loadDiagram
 */
export function createWorkspaceReader({ sharing, adapterFor, loadDiagram }) {
  /** This person's access to diagram `id`: { owner, access, document } or null. */
  async function open(sub, id) {
    const own = await loadDiagram(adapterFor(sub), id);
    if (own && !own.deletedAt) return { owner: sub, access: 'owner', document: own };
    const shared = sharing ? await sharing.accessTo(sub, id) : null;
    if (!shared) return null;
    const document = await loadDiagram(adapterFor(shared.owner), id);
    if (!document || document.deletedAt) return null;
    return { owner: shared.owner, access: shared.role, document };
  }

  return {
    open,

    /** The person's diagrams, then the ones shared with them: id, name, lastModified, access. */
    async list(sub) {
      const own = (await adapterFor(sub).listDiagramMeta())
        .filter((row) => !row.deletedAt)
        .map((row) => ({ id: row.id, name: row.name, lastModified: row.lastModified, access: 'owner' }));
      const shared = sharing
        ? (await sharing.sharedWithMe(sub)).map((row) => ({
            id: row.id, name: row.name, lastModified: row.lastModified, access: row.shared.role,
            ownerEmail: row.shared.ownerEmail
          }))
        : [];
      return [...own, ...shared];
    },

    /** One page of a diagram this person can open, described; null when they cannot. */
    async read(sub, id, page) {
      const found = await open(sub, id);
      return found ? { id, access: found.access, description: describeDiagram(found.document, { viewId: page }) } : null;
    },

    /** Describe a page of a diagram already opened with open(). */
    describe: (found, page) => describeDiagram(found.document, { viewId: page })
  };
}
