import { create } from 'zustand';
import type { Model } from 'axoview';

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
}

export const useAssistantPageStore = create<AssistantPageState>((set) => ({
  readPage: null,
  setReadPage: (reader) => set({ readPage: reader })
}));
