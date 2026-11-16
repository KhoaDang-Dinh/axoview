import { create } from 'zustand';
import type { SyncChange } from './realtimeSync';
import { getBrowserId } from './browserId';

/**
 * Who else has this workspace open, from the presence events on the sync
 * stream (backend server.js): a tab announces itself when its stream opens
 * ('join', or 'renew' on the reconnect every few minutes), the browsers
 * already there answer a new tab ('here'), and a tab that closes its stream
 * leaves ('leave').
 *
 * Tabs of THIS browser are not company: they share edits over the tab channel
 * (no server round trip), so only another browser or device counts. While
 * there is none, edits are uploaded in batches (hooks/useAutoSave.ts); with
 * one, every save goes up at once so it sees the edit live.
 */

/**
 * A tab not heard from for this long is gone (it closed without a 'leave':
 * a crash, a lost network). Streams renew every 5 minutes (SYNC_MAX_STREAM_MS).
 */
export const PRESENCE_TTL_MS = 6 * 60_000;

interface PresenceState {
  /** Other browsers' tabs, by device id: their browser and when last heard. */
  tabs: Record<string, { browser: string; seen: number }>;
  /** Apply one presence event; anything else is ignored. */
  apply: (change: SyncChange, now?: number) => void;
  /** Forget everyone (signed out, sync off). */
  clear: () => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  tabs: {},
  apply: (change, now = Date.now()) => {
    if (change.kind !== 'presence' || !change.origin || !change.browser) return;
    if (change.browser === getBrowserId()) return; // this browser's own tabs
    const origin = change.origin;
    const browser = change.browser;
    set((state) => {
      const tabs = { ...state.tabs };
      if (change.action === 'leave') delete tabs[origin];
      else tabs[origin] = { browser, seen: now };
      return { tabs };
    });
  },
  clear: () => set({ tabs: {} })
}));

/** Whether another browser has the workspace open now. */
export function othersPresent(now = Date.now()): boolean {
  const { tabs } = usePresenceStore.getState();
  return Object.values(tabs).some((tab) => now - tab.seen < PRESENCE_TTL_MS);
}
