/**
 * IndexedDB mirror for the diagram drafts (stores/draftStore.ts): one record
 * per user and diagram, so tabs of one browser never overwrite each other's
 * drafts (a single persisted blob would: each tab writes its whole state).
 *
 * IndexedDB, not localStorage: a diagram with imported icons can be several
 * megabytes, past localStorage's quota, and IndexedDB writes do not block the
 * page. Every call resolves (never rejects): with IndexedDB unavailable or
 * failing (private modes, a full disk, tests) a write reports `false` and the
 * app uploads at once instead of relying on the draft.
 */
const DB_NAME = 'axoview-drafts';
const STORE = 'drafts';

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then((db) => new Promise((resolve) => {
    if (!db) return resolve(undefined);
    try {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  }));
}

export async function draftDbPut(key: string, value: unknown): Promise<boolean> {
  const db = await open();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function draftDbGet<T>(key: string): Promise<T | null> {
  return ((await run('readonly', (store) => store.get(key) as IDBRequest<T>)) ?? null) as T | null;
}

export async function draftDbDelete(key: string): Promise<void> {
  await run('readwrite', (store) => store.delete(key));
}

/** Delete every record whose key starts with `prefix`. */
export async function draftDbDeletePrefix(prefix: string): Promise<void> {
  const keys = (await run('readonly', (store) => store.getAllKeys())) ?? [];
  await Promise.all(
    keys.filter((key) => typeof key === 'string' && key.startsWith(prefix)).map((key) => draftDbDelete(key as string))
  );
}
