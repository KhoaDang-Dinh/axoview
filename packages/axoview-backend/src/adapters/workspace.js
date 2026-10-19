const WORKSPACE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Bind the existing storage contract to one workspace namespace. The workspace
 * id must come from trusted server context (for now Cognito `sub` is the
 * default personal workspace id), never from request data. Public snapshots
 * stay in a global namespace so their links remain readable without a session.
 */
export function createWorkspaceAdapter(base, workspaceId) {
  if (typeof workspaceId !== 'string' || !WORKSPACE_PATTERN.test(workspaceId)) {
    throw new Error('Invalid trusted workspace id');
  }
  const root = `workspaces/${workspaceId}`;
  const scopedKey = (key) =>
    key.startsWith('public/') ? key : `${root}/${key}`;

  const adapter = {
    workspaceId,
    async get(key) {
      return base.get(scopedKey(key));
    },
    async put(key, value) {
      return base.put(scopedKey(key), value);
    },
    async delete(key) {
      return base.delete(scopedKey(key));
    },
    async list(prefix) {
      if (prefix === 'public' || prefix.startsWith('public/')) {
        return base.list(prefix);
      }
      return base.list(`${root}/${prefix}`);
    },
    async listDiagramMeta() {
      const keys = await base.list(`${root}/diagrams`);
      const rows = await Promise.all(
        keys.map(async (key) => {
          const id = key.slice(`${root}/diagrams/`.length);
          const bytes = await base.get(key);
          if (!bytes) return null;
          try {
            const data = JSON.parse(new TextDecoder().decode(bytes));
            return {
              id,
              name: data.name || data.title || 'Untitled Diagram',
              lastModified: data.lastModified || new Date(0).toISOString(),
              folderId: data.folderId ?? null,
              deletedAt: data.deletedAt ?? null
            };
          } catch {
            return null;
          }
        })
      );
      return rows.filter(Boolean);
    },
    forWorkspace(nextWorkspaceId) {
      return createWorkspaceAdapter(base, nextWorkspaceId);
    }
  };
  return adapter;
}

/** Keep public reads on the unscoped adapter while retaining tenant writes. */
export function addWorkspaceScope(base) {
  return {
    ...base,
    forWorkspace(workspaceId) {
      return createWorkspaceAdapter(base, workspaceId);
    }
  };
}
