/**
 * The live (Yjs) sessions open in this tab, by diagram id.
 *
 * Kept apart from collaboration.ts so the code that only asks "is this
 * diagram live?" (storage, the sync stream, the lifecycle provider) does not
 * pull Yjs into the app's first chunk: collaboration.ts is loaded on demand,
 * when a server diagram opens with collaboration on.
 */
import type { SyncChange } from './realtimeSync';

export interface LiveSession {
  readonly id: string;
  serverVersion?: number;
  serverModified?: string;
  readonly history: { undo: () => void; redo: () => void; canUndo: () => boolean; canRedo: () => boolean };
  change(before: unknown, after: unknown): void;
  sync(): Promise<void>;
  flush(): Promise<unknown>;
  receive(change: SyncChange): void;
  noteAgentChange(agent: string): void;
  close(): void;
}

export const liveSessions = new Map<string, LiveSession>();

export const activeCollaboration = (id: string): LiveSession | undefined => liveSessions.get(id);

/** Hands a collaboration or signal event to the diagram's session; false when it has none here. */
export function receiveCollaboration(change: SyncChange): boolean {
  const session = change.id ? liveSessions.get(change.id) : undefined;
  session?.receive(change);
  return !!session;
}
