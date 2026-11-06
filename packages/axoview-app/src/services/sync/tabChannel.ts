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
  | { type: 'diagram-deleted'; id: string };

const NAME = 'axoview-tabs';
const FALLBACK_KEY = 'axoview-tabs-message';

function isTabMessage(value: unknown): value is TabMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as { type?: unknown; id?: unknown };
  switch (m.type) {
    case 'account-signed-out':
    case 'account-signed-in':
    case 'drive-signed-out':
      return true;
    case 'diagram-deleted':
      return typeof m.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(m.id);
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

export function postToTabs(message: TabMessage): void {
  const bc = getChannel();
  if (bc) {
    try { bc.postMessage(message); } catch { /* a closed channel: nothing to tell */ }
    return;
  }
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
