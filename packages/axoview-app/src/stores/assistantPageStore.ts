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
  /**
   * Carries out operations that must be stored before they show (approving
   * an outside agent's proposal: ADR 0059 addendum 2026-11-12). The diagram
   * with the steps made is worked out without changing the editor and handed
   * to `store`; only when `store` says it is stored does the change appear,
   * as one undoable change. Registered with applyToPage.
   */
  storeThenApplyToPage: StoreThenApply | null;
  setStoreThenApply: (run: StoreThenApply | null) => void;
  /**
   * The person chose Review on a "proposes changes" notice: the diagram whose
   * waiting proposals components/ProposalPrompt.tsx opens once it shows them.
   */
  reviewProposalsOf: string | null;
  setReviewProposalsOf: (id: string | null) => void;
}

/**
 * `made`: stored and now on screen. `nothing`: no step fits the diagram as it
 * is. `not-stored`: `store` refused, the diagram is as it was. `unsaved`:
 * earlier edits could not be saved first, so nothing was tried.
 */
export interface StoreThenApplyResult {
  status: 'made' | 'nothing' | 'not-stored' | 'unsaved';
  steps: AgentStepOutcome[];
}

export type StoreThenApply = (
  operations: unknown[],
  viewId: string | undefined,
  store: (document: unknown, made: number) => Promise<boolean>
) => Promise<StoreThenApplyResult>;

export const useAssistantPageStore = create<AssistantPageState>((set) => ({
  readPage: null,
  setReadPage: (reader) => set({ readPage: reader }),
  applyToPage: null,
  canChangePage: null,
  setPageAccess: (apply, canChange) => set({ applyToPage: apply, canChangePage: canChange }),
  storeThenApplyToPage: null,
  setStoreThenApply: (run) => set({ storeThenApplyToPage: run }),
  reviewProposalsOf: null,
  setReviewProposalsOf: (id) => set({ reviewProposalsOf: id })
}));
