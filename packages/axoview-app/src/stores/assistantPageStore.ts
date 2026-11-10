import { create } from 'zustand';
import type { AgentStepOutcome, Model } from 'axoview';

/** The diagram open in the editor and the page on screen, read on demand. */
export interface OpenPage {
  model: Model;
  viewId?: string;
}

interface AssistantPageState {
  /**
   * Registered by DiagramLifecycleProvider. The assistant lives outside the
   * editor's providers (it must also render on the sign-in screen), so it
   * reads the page through this instead of a context. Null when no editor
   * is mounted.
   */
  readPage: (() => OpenPage | null) | null;
  setReadPage: (reader: (() => OpenPage | null) | null) => void;
  /**
   * Carries out operations the person approved on the open diagram, as one
   * undoable change, and returns the steps (only `ready` ones changed
   * anything). Registered with readPage; null when no editor is mounted.
   */
  applyToPage: ((operations: unknown[], viewId?: string) => AgentStepOutcome[]) | null;
  /**
   * Whether this person may change the open diagram: the editor (not a
   * read-only viewer) on their own diagram or one shared with them as Full
   * admin. Their AI agent never goes above this (ADR 0057 addendum 3). Reads
   * no diagram content.
   */
  canChangePage: (() => boolean) | null;
  setPageAccess: (
    apply: ((operations: unknown[], viewId?: string) => AgentStepOutcome[]) | null,
    canChange: (() => boolean) | null
  ) => void;
}

export const useAssistantPageStore = create<AssistantPageState>((set) => ({
  readPage: null,
  setReadPage: (reader) => set({ readPage: reader }),
  applyToPage: null,
  canChangePage: null,
  setPageAccess: (apply, canChange) => set({ applyToPage: apply, canChangePage: canChange })
}));
