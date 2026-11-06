/**
 * Messages between this app's tabs in the same browser: sign-out and sign-in
 * must reach every tab at once, and a deleted diagram must close everywhere
 * immediately (the server's sync stream also says so, a second or two later,
 * and only for server storage).
 *
 * BroadcastChannel, with a `storage`-event fallback for browsers without it.
 * A tab never receives its own messages.
 */
export type TabMessage =
  | { type: 'account-signed-out' }
  | { type: 'account-signed-in' }
  | { type: 'drive-signed-out' }
  | { type: 'diagram-deleted'; id: string }
  /**
   * An autosave checkpoint (stores/draftStore.ts), so this browser's other
   * tabs show the edit at once, without the server. `parents`: the checkpoints
   * it was built on, newest last: a tab whose own queued checkpoint is among
   * them can take this one instead (it contains that tab's edits).
   */
  | {
      type: 'diagram-checkpoint';
      userKey: string;
      id: string;
      /** The sending tab's device id: its upload echoes back on the sync stream with it. */
      device: string;
      rev: string;
      parents: string[];
      baseVersion?: number;
      baseStamp?: string;
      model: unknown;
    }
  /** Checkpoint `rev` reached the server as `version`. */
  | { type: 'diagram-uploaded'; userKey: string; id: string; rev: string; version?: number; stamp?: string };

const NAME = 'axoview-tabs';
const FALLBACK_KEY = 'axoview-tabs-message';

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const isRev = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 64;
const isStamp = (value: unknown) => value === undefined || (typeof value === 'string' && value.length <= 64);
const isVersion = (value: unknown) =>
  value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0);

function isTabMessage(value: unknown): value is TabMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as {
    type?: unknown; id?: unknown; userKey?: unknown; rev?: unknown; parents?: unknown; device?: unknown;
    baseVersion?: unknown; version?: unknown; model?: unknown; baseStamp?: unknown; stamp?: unknown;
  };
  switch (m.type) {
    case 'account-signed-out':
    case 'account-signed-in':
    case 'drive-signed-out':
      return true;
    case 'diagram-deleted':
      return typeof m.id === 'string' && ID_RE.test(m.id);
    case 'diagram-checkpoint':
      return typeof m.id === 'string' && ID_RE.test(m.id) && typeof m.userKey === 'string' &&
        typeof m.device === 'string' && ID_RE.test(m.device) &&
        isRev(m.rev) && Array.isArray(m.parents) && m.parents.length <= 64 && m.parents.every(isRev) &&
        isVersion(m.baseVersion) && isStamp(m.baseStamp) && !!m.model && typeof m.model === 'object';
    case 'diagram-uploaded':
      return typeof m.id === 'string' && ID_RE.test(m.id) && typeof m.userKey === 'string' &&
        isRev(m.rev) && isVersion(m.version) && isStamp(m.stamp);
    default:
      return false;
  }
}

let channel: BroadcastChannel | null | undefined;
function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(NAME) : null;
  } catch {
    channel = null;
  }
  return channel;
}

/**
 * `fallback: false`: BroadcastChannel only. For messages carrying a diagram,
 * which may not fit in localStorage; without the channel those tabs learn
 * from the server's sync stream instead.
 */
export function postToTabs(message: TabMessage, { fallback = true }: { fallback?: boolean } = {}): void {
  const bc = getChannel();
  if (bc) {
    try { bc.postMessage(message); } catch { /* a closed channel: nothing to tell */ }
    return;
  }
  if (!fallback) return;
  try {
    // A unique value, so the same message twice still fires `storage`.
    localStorage.setItem(FALLBACK_KEY, JSON.stringify({ message, nonce: Math.random() }));
    localStorage.removeItem(FALLBACK_KEY);
  } catch { /* storage blocked: other tabs learn on their next request */ }
}

/** Calls `handler` for each message from another tab; returns the unsubscribe. */
export function onTabMessage(handler: (message: TabMessage) => void): () => void {
  const bc = getChannel();
  if (bc) {
    const listener = (event: MessageEvent) => { if (isTabMessage(event.data)) handler(event.data); };
    bc.addEventListener('message', listener);
    return () => bc.removeEventListener('message', listener);
  }
  const listener = (event: StorageEvent) => {
    if (event.key !== FALLBACK_KEY || !event.newValue) return;
    try {
      const { message } = JSON.parse(event.newValue) as { message: unknown };
      if (isTabMessage(message)) handler(message);
    } catch { /* not ours */ }
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}
