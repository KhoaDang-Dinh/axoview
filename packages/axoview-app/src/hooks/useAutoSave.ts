import { useCallback, useEffect, useRef, useState } from 'react';
import type { StorageProvider } from '../services/storage/types';
import type { DiagramData } from '../diagramUtils';

/**
 * `local`: the latest edit is saved in this browser (a persisted draft) and
 * its upload is batched (see `UseAutoSaveOptions.batch`).
 */
export type SaveStatus = 'idle' | 'saving' | 'local' | 'error';

/**
 * What a `saveNow()` flush actually did.
 *
 * Callers used to answer this by reading `saveStatus` back out of their own
 * render closure, which is a render behind the flush they just awaited — so a
 * manual save right after an edit did nothing and said nothing (A1/LIFE-03,
 * A1/LIFE-04). The flush reports its own outcome instead.
 */
export type FlushOutcome = 'nothing-pending' | 'saved' | 'error';

/**
 * Batched uploads (server storage). Without this every autosave goes to
 * storage 1 s after the user pauses. With it, that moment is
 * a CHECKPOINT (the model saved in the browser, stores/draftStore.ts), and the
 * upload follows:
 *   - at once when `uploadNow(id)` says so (another browser has the workspace
 *     open, services/sync/presence.ts, or other people have this diagram:
 *     it is shared, ADR 0057) or the checkpoint could not be
 *     persisted (no IndexedDB: nothing would survive a crash);
 *   - otherwise `maxDelayMs` after the first checkpoint not yet uploaded, as
 *     one upload of the latest one.
 * `saveNow()` always uploads at once, so every flush point (switching diagram,
 * sharing, exporting, signing out, Ctrl+S, the tab hidden) still means "on the
 * server".
 */
export interface AutoSaveBatching {
  checkpoint: (diagramId: string, model: DiagramData) => Promise<{ rev: string; persisted: boolean }>;
  uploadNow: (diagramId: string) => boolean;
  maxDelayMs: number;
  /** The upload that included checkpoint `rev` landed. */
  onUploaded?: (diagramId: string, rev: string) => void;
}

interface UseAutoSaveOptions {
  storage: StorageProvider | null;
  enabled: boolean;
  onSaved?: (diagramId: string, savedAt: Date) => void;
  onError?: (error: Error) => void;
  batch?: AutoSaveBatching | null;
}

export interface UseAutoSaveResult {
  saveStatus: SaveStatus;
  lastSaved: Date | null;
  /** Schedule a debounced save. Call on every real user edit. */
  scheduleSave: (diagramId: string, model: DiagramData) => void;
  /**
   * Flush any pending debounced save and wait for it — and for any write
   * already in flight — to land. Safe to call when nothing is pending.
   */
  saveNow: () => Promise<FlushOutcome>;
  /**
   * Live (ref-backed, never closure-stale) answer to "is there work that has
   * not reached storage?" — queued, in flight, or failed. The `beforeunload`
   * guards read this.
   */
  hasUnsavedWork: () => boolean;
  /**
   * Like hasUnsavedWork, but work whose latest checkpoint is persisted in the
   * browser does not count: closing the tab then loses nothing (the draft is
   * restored on the next open). The `beforeunload` warning reads this.
   */
  hasUnpersistedWork: () => boolean;
  /** Drop a queued upload of `diagramId`: another tab of this browser holds newer content and uploads it. */
  dropQueued: (diagramId: string) => void;
  /**
   * Reset status back to idle (e.g. after loading a new diagram). Flushes
   * queued work first — a reset must not be a silent discard of the previous
   * diagram's last edit (A1/LIFE-09).
   */
  resetStatus: () => void;
}

// Idle checkpoint delay. Live Yjs edits travel independently of this timer.
export const DEBOUNCE_MS = 2500;

interface Pending {
  diagramId: string;
  model: DiagramData;
  /** The checkpoint this model was saved as, once it has been. */
  rev?: string;
  /** That checkpoint reached IndexedDB. */
  persisted?: boolean;
}

export function useAutoSave({
  storage,
  enabled,
  onSaved,
  onError,
  batch = null,
}: UseAutoSaveOptions): UseAutoSaveResult {
  const [saveStatus, setSaveStatusState] = useState<SaveStatus>('idle');
  const [lastSaved, setLastSaved] = useState<Date | null>(null);

  // What's queued for the next flush
  const pendingRef = useRef<Pending | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The batched upload's deadline (see AutoSaveBatching), armed by the first
  // checkpoint not yet uploaded.
  const uploadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The model on the wire was a persisted checkpoint (beforeunload need not warn).
  const inFlightPersistedRef = useRef(false);
  // The last checkpoint per diagram: an upload of newer content includes it.
  const lastRevRef = useRef<Map<string, string>>(new Map());
  const batchRef = useRef(batch);
  useEffect(() => { batchRef.current = batch; }, [batch]);
  // The write currently on the wire, if any (writes are serialised — see startSave)
  const inFlightRef = useRef<Promise<void> | null>(null);
  const statusRef = useRef<SaveStatus>('idle');
  const mountedRef = useRef(true);
  const storageRef = useRef(storage);
  useEffect(() => { storageRef.current = storage; }, [storage]);

  // Callbacks in refs so they never stale inside the debounce closure
  const onSavedRef = useRef(onSaved);
  const onErrorRef = useRef(onError);
  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const setStatus = useCallback((next: SaveStatus) => {
    statusRef.current = next;
    if (mountedRef.current) setSaveStatusState(next);
  }, []);

  const clearUploadTimer = useCallback(() => {
    if (uploadTimerRef.current) {
      clearTimeout(uploadTimerRef.current);
      uploadTimerRef.current = null;
    }
  }, []);

  /** One write. Never overlaps another — see `startSave`. */
  const performSave = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending || !storageRef.current) return;
    pendingRef.current = null;
    clearUploadTimer();
    inFlightPersistedRef.current = !!pending.persisted;

    setStatus('saving');
    try {
      await storageRef.current.saveDiagram(pending.diagramId, pending.model as unknown);
      const savedAt = new Date();
      if (mountedRef.current) setLastSaved(savedAt);
      // A newer edit landed while this write was on the wire: the diagram is
      // NOT saved, so stay 'saving' until that one lands too (LIFE-08). A newer
      // one that is only a checkpoint so far is 'local'.
      const next = pendingRef.current as Pending | null;
      setStatus(next ? (next.rev && next.persisted ? 'local' : 'saving') : 'idle');
      onSavedRef.current?.(pending.diagramId, savedAt);
      // This upload carried its own checkpoint, or newer content than the
      // last one (a flush before the debounce): either way that draft is done.
      const rev = pending.rev ?? lastRevRef.current.get(pending.diagramId);
      if (rev) batchRef.current?.onUploaded?.(pending.diagramId, rev);
    } catch (e) {
      // Keep the model that could not be written so a retry has something to
      // send (LIFE-01) — unless a newer edit has already superseded it.
      if (!pendingRef.current) pendingRef.current = pending;
      setStatus('error');
      onErrorRef.current?.(e instanceof Error ? e : new Error('Auto-save failed'));
    } finally {
      inFlightPersistedRef.current = false;
    }
  }, [setStatus, clearUploadTimer]);

  /**
   * Start a write, queued behind any write already on the wire. Two overlapping
   * writes can land out of order — the older one overwriting the newer in
   * storage, and reporting "saved" over it (LIFE-08).
   */
  const startSave = useCallback((): Promise<void> => {
    const prior = inFlightRef.current;
    const run = prior ? prior.then(() => performSave(), () => performSave()) : performSave();
    inFlightRef.current = run;
    const clear = () => { if (inFlightRef.current === run) inFlightRef.current = null; };
    void run.then(clear, clear);
    return run;
  }, [performSave]);

  /** The debounce fired: upload now, or (batching) checkpoint and maybe upload later. */
  const onDebounced = useCallback(async () => {
    const policy = batchRef.current;
    const pending = pendingRef.current;
    if (!policy || !pending) {
      void startSave();
      return;
    }
    let result: { rev: string; persisted: boolean };
    try {
      result = await policy.checkpoint(pending.diagramId, pending.model);
    } catch {
      result = { rev: '', persisted: false };
    }
    if (result.rev) lastRevRef.current.set(pending.diagramId, result.rev);
    // A newer edit (or a flush) replaced this model meanwhile: its own
    // debounce or the flush takes it from here.
    if (pendingRef.current !== pending) return;
    pending.rev = result.rev || undefined;
    pending.persisted = result.persisted;
    if (!result.persisted || policy.uploadNow(pending.diagramId)) {
      void startSave();
      return;
    }
    setStatus('local');
    if (!uploadTimerRef.current) {
      uploadTimerRef.current = setTimeout(() => {
        uploadTimerRef.current = null;
        void startSave();
      }, policy.maxDelayMs);
    }
  }, [startSave, setStatus]);

  const scheduleSave = useCallback(
    (diagramId: string, model: DiagramData) => {
      if (!enabled) return;
      // One queued model at a time: opening another diagram flushes this one
      // first (resetStatus), so a queued checkpoint is never replaced by
      // another diagram's edit.
      pendingRef.current = { diagramId, model };
      // Show 'saving' immediately so the status bar responds at once
      setStatus('saving');
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        void onDebounced();
      }, DEBOUNCE_MS);
    },
    [enabled, onDebounced, setStatus]
  );

  const saveNow = useCallback(async (): Promise<FlushOutcome> => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    clearUploadTimer();
    if (pendingRef.current && storageRef.current) {
      await startSave();
    } else if (inFlightRef.current) {
      // Nothing queued, but a write is still on the wire. Callers treat this
      // resolving as "the old place is flushed" before revoking a token or
      // swapping the active provider, so it has to mean that (LIFE-06).
      await inFlightRef.current;
    } else {
      return statusRef.current === 'error' ? 'error' : 'nothing-pending';
    }
    return statusRef.current === 'error' ? 'error' : 'saved';
  }, [startSave, clearUploadTimer]);

  const hasUnsavedWork = useCallback(
    () => !!pendingRef.current || !!inFlightRef.current || statusRef.current !== 'idle',
    []
  );

  const hasUnpersistedWork = useCallback(() => {
    const pending = pendingRef.current;
    if (pending && !pending.persisted) return true;
    if (inFlightRef.current && !inFlightPersistedRef.current) return true;
    // A failed upload with nothing queued: its model went back into the queue
    // (LIFE-01), so the `pending` check above covers it.
    return false;
  }, []);

  const dropQueued = useCallback((diagramId: string) => {
    const pending = pendingRef.current;
    if (!pending || pending.diagramId !== diagramId || debounceTimerRef.current) return;
    pendingRef.current = null;
    clearUploadTimer();
    if (!inFlightRef.current) setStatus('idle');
  }, [clearUploadTimer, setStatus]);

  const resetStatus = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    clearUploadTimer();
    // Flush, don't discard: the pending model is keyed by its own diagram id,
    // so writing it out cannot collide with the diagram being loaded.
    if (pendingRef.current && storageRef.current) void startSave();
    pendingRef.current = null;
    setStatus('idle');
  }, [startSave, setStatus, clearUploadTimer]);

  // Teardown: flush, don't drop. `EditorPage` is the element of every route, so
  // an in-app navigation unmounts this hook mid-debounce (LIFE-05).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      clearUploadTimer();
      if (pendingRef.current && storageRef.current) void startSave();
    };
  }, [startSave, clearUploadTimer]);

  // Disabling autosave must disarm an already-armed timer too — only
  // `scheduleSave` consulted the flag, so a save armed a moment earlier still
  // landed after autosave was switched off (LIFE-07). The queued model is kept:
  // "no automatic writes" is not "throw the user's work away", and an explicit
  // `saveNow()` can still flush it.
  useEffect(() => {
    if (enabled) return;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    clearUploadTimer();
  }, [enabled, clearUploadTimer]);

  return {
    saveStatus, lastSaved, scheduleSave, saveNow, hasUnsavedWork, hasUnpersistedWork, dropQueued, resetStatus
  };
}
