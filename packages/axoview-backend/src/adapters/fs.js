import fs from 'fs/promises';
import path from 'path';

const KEY_PATTERN = /^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*$/;

/**
 * Maps object-storage keys to filesystem paths.
 *
 *   diagrams/<id>  -> <STORAGE_PATH>/<id>.json    (flat; preserves legacy layout)
 *   public/<uuid>  -> <STORAGE_PATH>/public/<uuid>.json
 *   folders        -> <STORAGE_PATH>/folders.json
 *   tree-manifest  -> <STORAGE_PATH>/tree-manifest.json
 *
 * All keys must match KEY_PATTERN. This is an implementation-level invariant,
 * not part of the generic ObjectStorage contract; an S3 implementation can
 * choose its own safe key policy while exposing the same get/put/delete/list
 * semantics.
 */
function keyToPath(storagePath, key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new Error('Invalid storage key');
  }
  if (key.startsWith('diagrams/')) {
    const id = key.slice('diagrams/'.length);
    return path.join(storagePath, `${id}.json`);
  }
  const segments = key.split('/');
  return path.join(storagePath, ...segments) + '.json';
}

/**
 * Filesystem implementation of the generic ObjectStorage contract.
 *
 * It intentionally knows nothing about Axoview metadata. This is the seam that
 * a future createS3ObjectStorage() can replace without changing route handlers.
 */
export function createFsObjectStorage(storagePath) {
  return {
    async get(key) {
      try {
        const filePath = keyToPath(storagePath, key);
        const content = await fs.readFile(filePath);
        return new Uint8Array(content);
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },

    async put(key, value) {
      const filePath = keyToPath(storagePath, key);
      const dir = path.dirname(filePath);
      const name = path.basename(filePath);
      await fs.mkdir(dir, { recursive: true });

      // Atomicity contract (ADR 0010 Decision 3): tmp-file + rename so a crash
      // mid-write cannot leave a truncated target. Per-pid tmp name avoids
      // collisions between concurrent processes touching the same key.
      const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
      try {
        await fs.writeFile(tmp, Buffer.from(value));
        await fs.rename(tmp, filePath);
      } catch (e) {
        await fs.unlink(tmp).catch(() => {});
        throw e;
      }
    },

    async delete(key) {
      try {
        const filePath = keyToPath(storagePath, key);
        await fs.unlink(filePath);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    },

    async list(prefix) {
      const dir =
        prefix === ''
          ? storagePath
          : path.join(storagePath, ...prefix.split('/').filter(Boolean));
      try {
        const files = await fs.readdir(dir);
        return files
          .filter((f) => f.endsWith('.json'))
          .map((f) => `${prefix ? prefix + '/' : ''}${f.replace(/\.json$/, '')}`);
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
    }
  };
}

/**
 * Filesystem implementation of the Axoview StorageAdapter.
 *
 * The generic object operations come from createFsObjectStorage(). Only the
 * Axoview-specific listDiagramMeta query stays at this layer.
 */
export function createFsAdapter(storagePath) {
  const objects = createFsObjectStorage(storagePath);

  return {
    ...objects,

    async listDiagramMeta() {
      try {
        const entries = await fs.readdir(storagePath, { withFileTypes: true });
        const out = [];
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
          if (
            entry.name === 'folders.json' ||
            entry.name === 'tree-manifest.json' ||
            entry.name === 'metadata.json' ||
            entry.name === 'diagrams-index.json'
          ) {
            continue;
          }
          const filePath = path.join(storagePath, entry.name);
          try {
            const stats = await fs.stat(filePath);
            const content = await fs.readFile(filePath, 'utf-8');
            const data = JSON.parse(content);
            out.push({
              id: entry.name.replace(/\.json$/, ''),
              name: data.name || data.title || 'Untitled Diagram',
              lastModified: data.lastModified || stats.mtime.toISOString(),
              folderId: data.folderId ?? null,
              deletedAt: data.deletedAt ?? null
            });
          } catch {
            continue;
          }
        }
        return out;
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
    }
  };
}
