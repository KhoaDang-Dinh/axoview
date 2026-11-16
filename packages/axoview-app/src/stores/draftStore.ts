import { create } from 'zustand';
import type { DiagramData } from '../diagramUtils';
import { draftDbDelete, draftDbDeletePrefix, draftDbGet, draftDbPut } from '../services/storage/draftDb';

/**
 * Edits that are saved in this browser but not yet on the server.
 *
 * With server storage, each autosave (2 s after the user pauses) is a
 * CHECKPOINT: the model lands here, in memory and in IndexedDB, at once. When
 * no other browser has the workspace open, the upload to the server is batched
 * (hooks/useAutoSave.ts): one upload of the latest checkpoint at most every
 * UPLOAD_BATCH_MS, and at once whenever it matters (another browser appears,
 * the user switches diagram, shares, exports, signs out, saves explicitly, or
 * the tab is hidden). A draft is removed once its upload lands.
 *
 * A draft that is still here when the diagram is opened again (the tab
 * crashed, or closed before the upload got out) is restored from it
 * (providers/DiagramLifecycleProvider.tsx).
 *
 * Drafts belong to one user (`userKey`) and are wiped on sign-out, so a shared
 * computer never keeps one person's unsaved diagram for the next.
 */
export interface Draft {
  userKey: string;
  id: string;
  model: DiagramData;
  /** The server version this draft was edited from, when the backend versions diagrams. */
  baseVersion?: number;
  /**
   * The server state it was edited from: the version, or lastModified where
   * there are no versions (LocalStorageProvider.serverStamp).
   */
  baseStamp?: string;
  /** Identifies this checkpoint: an upload clears the draft only if it was this one. */
  rev: string;
  savedAt: number;
}

const PREFIX = 'draft:';
const keyOf = (userKey: string, id: string) => `${PREFIX}${userKey}:${id}`;

interface DraftState {
  drafts: Record<string, Draft>;
  /**
   * Keep a checkpoint. Resolves to whether it reached IndexedDB: only a
   * persisted draft may hold back an upload (a crash must not lose it).
   */
  checkpoint: (draft: Omit<Draft, 'rev' | 'savedAt'>) => Promise<{ rev: string; persisted: boolean }>;
  /** Another tab of this browser checkpointed (it wrote IndexedDB itself). */
  adopt: (draft: Draft) => void;
  /** The upload of checkpoint `rev` landed: drop the draft unless a newer one replaced it. */
  uploaded: (userKey: string, id: string, rev: string) => Promise<void>;
  /** Drop the draft whatever its checkpoint (restored or declined by the user). */
  discard: (userKey: string, id: string) => Promise<void>;
  /** The persisted draft, if any (IndexedDB is shared by the tabs; memory is not). */
  find: (userKey: string, id: string) => Promise<Draft | null>;
  /** Sign-out: every draft of this user, in memory and on disk. */
  wipeUser: (userKey: string) => Promise<void>;
}

function newRev(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const useDraftStore = create<DraftState>((set, get) => ({
  drafts: {},
  checkpoint: async (input) => {
    const draft: Draft = { ...input, rev: newRev(), savedAt: Date.now() };
    const key = keyOf(draft.userKey, draft.id);
    set((state) => ({ drafts: { ...state.drafts, [key]: draft } }));
    const persisted = await draftDbPut(key, draft);
    return { rev: draft.rev, persisted };
  },
  adopt: (draft) => {
    const key = keyOf(draft.userKey, draft.id);
    set((state) => ({ drafts: { ...state.drafts, [key]: draft } }));
  },
  uploaded: async (userKey, id, rev) => {
    const key = keyOf(userKey, id);
    if (get().drafts[key]?.rev !== rev) return;
    set((state) => {
      const drafts = { ...state.drafts };
      delete drafts[key];
      return { drafts };
    });
    // Another tab may have checkpointed this diagram since: only delete our own.
    const stored = await draftDbGet<Draft>(key);
    if (!stored || stored.rev === rev) await draftDbDelete(key);
  },
  discard: async (userKey, id) => {
    const key = keyOf(userKey, id);
    set((state) => {
      const drafts = { ...state.drafts };
      delete drafts[key];
      return { drafts };
    });
    await draftDbDelete(key);
  },
  find: async (userKey, id) => {
    const stored = await draftDbGet<Draft>(keyOf(userKey, id));
    return stored ?? get().drafts[keyOf(userKey, id)] ?? null;
  },
  wipeUser: async (userKey) => {
    const prefix = `${PREFIX}${userKey}:`;
    set((state) => ({
      drafts: Object.fromEntries(Object.entries(state.drafts).filter(([key]) => !key.startsWith(prefix)))
    }));
    await draftDbDeletePrefix(prefix);
  }
}));

/** Every user's drafts, for a sign-out where the user is no longer known. */
export async function wipeAllDrafts(): Promise<void> {
  useDraftStore.setState({ drafts: {} });
  await draftDbDeletePrefix(PREFIX);
}
