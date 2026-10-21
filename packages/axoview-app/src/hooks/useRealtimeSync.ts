import { useEffect, useRef } from 'react';
import { connectRealtimeSync, type SyncChange } from '../services/sync/realtimeSync';

/**
 * Realtime multi-device sync for server storage (one user, many devices).
 *
 * A change saved on another device reaches this tab through the backend's
 * sync stream within about a second of that device's autosave:
 *   - the open diagram, saved elsewhere → reloaded in place (viewport kept),
 *     unless this tab has unsaved edits: then this tab's next save replaces
 *     it (latest save wins) and the user is told once;
 *   - the open diagram, renamed or deleted elsewhere → the same as doing it
 *     from this tab's file tree;
 *   - anything else (new diagrams, folders, tree layout) → the file tree
 *     refreshes.
 * The stream closes while the tab is hidden and resumes when it is shown;
 * changes made meanwhile arrive as one `resync`.
 */

export type SyncReaction =
  | { type: 'ignore' }
  | { type: 'refreshTree' }
  | { type: 'reloadOpen'; refreshTree: boolean }
  | { type: 'keepLocal' }
  | { type: 'openDeleted' }
  | { type: 'openRenamed'; name: string };

export interface SyncState {
  openDiagramId: string | null;
  hasUnsavedWork: boolean;
  /** Version this tab has for the open diagram, if the backend versions it. */
  knownVersion: number | undefined;
}

/** What this tab does about one change from another device. Pure. */
export function planSyncReaction(change: SyncChange, state: SyncState): SyncReaction {
  if (change.kind === 'resync') {
    if (!state.openDiagramId) return { type: 'refreshTree' };
    return state.hasUnsavedWork ? { type: 'refreshTree' } : { type: 'reloadOpen', refreshTree: true };
  }
  if (change.kind !== 'diagram') return { type: 'refreshTree' };

  const isOpen = !!change.id && change.id === state.openDiagramId;
  if (!isOpen) {
    // Content saves of other diagrams change nothing the tree shows.
    return change.action === 'save' ? { type: 'ignore' } : { type: 'refreshTree' };
  }
  if (change.action === 'delete' || change.deleted === true) return { type: 'openDeleted' };
  if (change.action === 'update' && typeof change.name === 'string') {
    return { type: 'openRenamed', name: change.name };
  }
  if (change.action === 'save' || change.action === 'update') {
    // Already have this version (or a newer one): nothing to do.
    if (
      change.version !== undefined &&
      state.knownVersion !== undefined &&
      change.version <= state.knownVersion
    ) {
      return { type: 'ignore' };
    }
    return state.hasUnsavedWork ? { type: 'keepLocal' } : { type: 'reloadOpen', refreshTree: false };
  }
  return { type: 'refreshTree' };
}

export interface UseRealtimeSyncOptions {
  enabled: boolean;
  baseUrl: string;
  getState: () => SyncState;
  reloadOpenDiagram: () => Promise<void>;
  refreshTree: () => void;
  onOpenDeleted: (id: string) => void;
  onOpenRenamed: (id: string, name: string) => void;
  /** User-facing notice (existing toast system); called at most once per conflict. */
  notify: (severity: 'info' | 'warning', message: string) => void;
  t: (key: string, fallback: string) => string;
}

/** Hidden this long, the stream closes (resumed on show). */
const HIDDEN_CLOSE_MS = 60_000;

export function useRealtimeSync(options: UseRealtimeSyncOptions): void {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const { enabled, baseUrl } = options;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    let connection: ReturnType<typeof connectRealtimeSync> | null = null;
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
    // One "kept your edits" notice per diagram until it reloads or saves clean.
    let warnedFor: string | null = null;
    // Reloads run one at a time; a change arriving mid-reload queues one more.
    let reloading: Promise<void> | null = null;
    let reloadAgain = false;

    const reload = () => {
      if (reloading) {
        reloadAgain = true;
        return;
      }
      reloading = optionsRef.current
        .reloadOpenDiagram()
        .catch(() => {
          /* the next change or focus resync retries */
        })
        .finally(() => {
          reloading = null;
          if (reloadAgain) {
            reloadAgain = false;
            reload();
          }
        });
    };

    const handle = (change: SyncChange) => {
      const current = optionsRef.current;
      const state = current.getState();
      const reaction = planSyncReaction(change, state);
      switch (reaction.type) {
        case 'ignore':
          return;
        case 'refreshTree':
          current.refreshTree();
          return;
        case 'reloadOpen':
          warnedFor = null;
          if (reaction.refreshTree) current.refreshTree();
          reload();
          return;
        case 'keepLocal':
          if (state.openDiagramId && warnedFor !== state.openDiagramId) {
            warnedFor = state.openDiagramId;
            current.notify(
              'info',
              current.t(
                'sync.keptLocalEdits',
                'This diagram was also changed on another device. Your edits here are saved over it.'
              )
            );
          }
          return;
        case 'openDeleted':
          if (state.openDiagramId) current.onOpenDeleted(state.openDiagramId);
          current.refreshTree();
          current.notify(
            'warning',
            current.t('sync.deletedElsewhere', 'This diagram was deleted on another device.')
          );
          return;
        case 'openRenamed':
          if (state.openDiagramId) current.onOpenRenamed(state.openDiagramId, reaction.name);
          current.refreshTree();
          return;
      }
    };

    const open = () => {
      if (connection) return;
      // A backend without the stream (404) is retried by the client itself
      // every few minutes, so a rolling deploy never switches sync off.
      connection = connectRealtimeSync({ baseUrl, onChange: handle });
    };
    const close = () => {
      connection?.close();
      connection = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (hiddenTimer) clearTimeout(hiddenTimer);
        hiddenTimer = setTimeout(close, HIDDEN_CLOSE_MS);
        return;
      }
      if (hiddenTimer) {
        clearTimeout(hiddenTimer);
        hiddenTimer = null;
      }
      if (!connection) {
        // Changes made while closed arrive as `resync` only on a resumed
        // stream; a fresh one starts at "now", so catch up explicitly.
        handle({ seq: 0, kind: 'resync' });
        open();
      }
    };

    open();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (hiddenTimer) clearTimeout(hiddenTimer);
      close();
    };
  }, [enabled, baseUrl]);
}
