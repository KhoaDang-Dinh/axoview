/**
 * What a diagram document holds that the server, not the client, owns, and a
 * digest of what the user edited. Framework-agnostic like routes.js (the
 * Express server and the Cloudflare Worker both import it): Web Crypto only.
 */

/**
 * Fields only the server writes. A client body never sets them (routes.js
 * strips them on every write path); a save carries them over from the stored
 * diagram so a whole-document replace cannot drop a share link (S2/SHARE-01).
 */
export const SERVER_OWNED_DIAGRAM_FIELDS = ['shareUuid', 'created', 'workspaceId'];

/** Keys that change on every write without changing what the diagram shows. */
const VOLATILE_KEYS = new Set(['id', 'lastModified', ...SERVER_OWNED_DIAGRAM_FIELDS]);

/** The server-owned fields a stored diagram carries (absent ones left out). */
export function pickServerOwned(doc) {
  const owned = {};
  for (const key of SERVER_OWNED_DIAGRAM_FIELDS) {
    if (doc && doc[key] !== undefined) owned[key] = doc[key];
  }
  return owned;
}

/**
 * A digest of what the user edited: the document without its id, timestamp
 * and server-owned fields. Two saves with the same digest store the same
 * diagram, so the second one is skipped (no new object, no metadata write, no
 * sync event to the other devices).
 *
 * Key order is the client's: a reordered but equal document hashes differently
 * and is simply written, which is the safe direction.
 */
export async function contentHash(doc) {
  const content = {};
  for (const [key, value] of Object.entries(doc || {})) {
    if (!VOLATILE_KEYS.has(key)) content[key] = value;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(content));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
