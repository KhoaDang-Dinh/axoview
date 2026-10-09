/**
 * Lowest-level blob/object storage contract.
 *
 * Implementations own opaque keys and bytes only. They do not know about
 * diagrams, folders, tenants, HTTP routes, or Axoview metadata semantics.
 *
 * Current implementation:
 *   - fs: local filesystem (Docker/local compatibility)
 *
 * Planned implementation:
 *   - s3: S3 object storage for diagram bodies/public snapshots
 */
export interface ObjectStorage {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/**
 * Axoview domain storage contract.
 *
 * The route layer depends on this interface. Generic object operations are
 * inherited from ObjectStorage, while Axoview-specific metadata queries live
 * here. This keeps future S3/DynamoDB composition behind the adapter boundary:
 *
 *   routes -> StorageAdapter
 *              |- ObjectStorage (fs today, S3 later)
 *              '- metadata query (fs today, DynamoDB later)
 *
 * The route layer never sees a filesystem path, S3 bucket, or DynamoDB table.
 */
export interface StorageAdapter extends ObjectStorage {
  listDiagramMeta(): Promise<DiagramMeta[]>;
}

export interface DiagramMeta {
  id: string;
  name: string;
  lastModified: string;
  folderId: string | null;
  deletedAt: string | null;
}

export interface FolderMeta {
  id: string;
  name: string;
  parentId: string | null;
}
