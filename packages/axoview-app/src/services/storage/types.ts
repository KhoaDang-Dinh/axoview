import type { Icon, Colors, ModelItem, View } from 'axoview';

/**
 * The loose blob shape persisted to storage. Includes legacy fields produced
 * by older exports (`name`, `t` compact-format alias) and storage-only fields
 * (`folderId`, `created`, `lastModified`) that aren't part of the strict
 * in-memory model (see `DiagramData` in `diagramUtils.ts`).
 *
 * Use `isPersistedDiagramBlob()` to narrow from `unknown` at storage and
 * import boundaries before reading individual fields.
 */
export interface PersistedDiagramBlob {
  title?: string;
  /** Legacy alias for title (some imports use this). */
  name?: string;
  /** Compact-format title field. */
  t?: string;
  version?: string;
  description?: string;
  icons?: Icon[];
  colors?: Colors;
  items?: ModelItem[];
  views?: View[];
  fitToScreen?: boolean;
  requiredPacks?: string[];
  folderId?: string | null;
  created?: string;
  lastModified?: string;
  sharedAt?: string;
}

/**
 * Narrow an opaque JSON-parsed value to a diagram blob. Returns true for any
 * plain object — field validation is the consumer's responsibility (each
 * field is optional in `PersistedDiagramBlob`).
 */
export function isPersistedDiagramBlob(x: unknown): x is PersistedDiagramBlob {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export interface DiagramMeta {
  id: string;
  name: string;
  lastModified: string;    // ISO 8601
  folderId: string | null; // null = root
  isDirty?: boolean;       // client-side only
  thumbnail?: string;      // base64 PNG, generated on save
  lockedBy?: string;       // reserved for P3 collaboration — leave undefined for now
  deletedAt?: string;      // ISO 8601 — soft delete, null = not deleted
  // Someone else's diagram shared with this account (ADR 0057): this
  // account's permission level, and the owner's email when known.
  shared?: { role: MemberRole; ownerEmail: string | null };
}

/**
 * Permission levels on someone else's diagram (owner decisions 2026-11-10):
 * viewer "Read only" (opens in the read-only viewer), admin "Full admin" (the
 * owner's powers). Only people are members: an AI agent works on its
 * person's account (AgentLevel).
 */
export type MemberRole = 'viewer' | 'admin';

/**
 * What a person lets their AI agent do, set once for the account: viewer
 * "Read only" (it suggests, never changes), proposer "Changes need my
 * approval". Never above the person on any diagram.
 */
export type AgentLevel = 'viewer' | 'proposer';

/** This account's role on a diagram it has open: its own, or a member's. */
export type DiagramRole = 'owner' | MemberRole;

/** A person a diagram is shared with, as its managers see them. */
export interface DiagramMember {
  sub: string;
  email: string | null;
  role: MemberRole;
  addedAt: string;
}

/**
 * Changes an outside agent proposed through the workspace MCP server
 * (ADR 0059), waiting for its person (the account that lists it). They are
 * operations in the diagramAgent vocabulary: the app checks them against the
 * page as it is now and carries out the ones the person approves.
 */
export interface Proposal {
  id: string;
  /** The person the agent works for (this account), and which agent (its app's name). */
  by: { sub: string; agent: string | null };
  /** The page they are for; null for the first page. */
  viewId: string | null;
  operations: unknown[];
  /** What the agent said about them. */
  note: string | null;
  createdAt: string;
}

/**
 * Adding a person by email, or changing a level. reason codes from the
 * server: no-account, already-shared, self, invalid-email, invalid-role,
 * rate-limited, not-found, no-proposal; 'error' for a
 * network or server failure.
 */
export type AddMemberResult =
  | { ok: true; member: DiagramMember }
  | { ok: false; reason: string; message: string };

export type ProposalDecision =
  | { ok: true }
  | { ok: false; reason: string; message: string };

/** by-you: you own it and shared it; with-you: someone shared it with you. */
export type SharedState = 'by-you' | 'with-you';

export interface FolderMeta {
  id: string;
  name: string;
  parentId: string | null;
  isExpanded?: boolean;    // tree UI state
  deletedAt?: string;      // ISO 8601 — soft delete
}

export interface TreeManifest {
  folders: FolderMeta[];
  // diagram folderId is stored on DiagramMeta, not here
}

export interface StorageProvider {
  id: 'local' | 'google-drive';
  displayName: string;
  requiresAuth: boolean;

  isAvailable(): Promise<boolean>;

  // Diagrams
  listDiagrams(folderId?: string | null): Promise<DiagramMeta[]>;
  loadDiagram(id: string): Promise<unknown>;
  saveDiagram(id: string, data: unknown): Promise<void>;
  /**
   * Server version tracking, for providers whose backend versions diagrams
   * (LocalStorageProvider in server mode). Optional: Drive and session
   * storage have none. See realtime sync and stores/draftStore.ts.
   */
  knownVersion?(id: string): number | undefined;
  noteVersion?(id: string, version: number): void;
  serverStamp?(id: string): string | undefined;
  noteStamp?(id: string, stamp: string): void;
  createDiagram(data: unknown, folderId?: string | null): Promise<string>;
  deleteDiagram(id: string, soft?: boolean): Promise<void>;
  restoreDiagram(id: string): Promise<void>;   // clears deletedAt
  renameDiagram(id: string, name: string): Promise<void>;

  // Folders
  listFolders(parentId?: string | null): Promise<FolderMeta[]>;
  createFolder(name: string, parentId?: string | null): Promise<string>;
  deleteFolder(id: string, recursive: boolean): Promise<void>;
  renameFolder(id: string, name: string): Promise<void>;
  moveItem(
    id: string,
    type: 'diagram' | 'folder',
    targetFolderId: string | null
  ): Promise<void>;

  // Tree manifest (open/close state, ordering)
  getTreeManifest(): Promise<TreeManifest>;
  saveTreeManifest(manifest: TreeManifest): Promise<void>;

  // Sharing — publish/unpublish a public snapshot. Returns the shareable URL.
  // Throws if the provider does not support shares (e.g. session-only).
  shareDiagram?(id: string): Promise<{ uuid: string; url: string; sharedAt: string }>;
  unshareDiagram?(id: string): Promise<void>;

  // People a server diagram is shared with (ADR 0057; server storage with
  // accounts). sharedState: what the server last said about `id` (the
  // X-Axoview-Shared header); a shared diagram uploads its saves at once.
  sharedState?(id: string): SharedState | undefined;
  /** This account's role on `id`, from its last load or save (X-Axoview-Role). */
  sharedRole?(id: string): DiagramRole | undefined;
  listMembers?(id: string): Promise<DiagramMember[]>;
  addMember?(id: string, email: string, role?: MemberRole): Promise<AddMemberResult>;
  setMemberRole?(id: string, sub: string, role: MemberRole): Promise<AddMemberResult>;
  removeMember?(id: string, sub: string): Promise<void>;
  // What this person lets their AI agent do, set once for the account
  // (ADR 0057 addendum 3). Read only when unknown or unreachable.
  agentLevel?(): Promise<AgentLevel>;
  /** Saves the level; false when the server refused or could not be reached. */
  setAgentLevel?(level: AgentLevel): Promise<boolean>;
  // Proposals ("Change needs approval"), for the owner and Full admins.
  listProposals?(id: string): Promise<Proposal[]>;
  /**
   * Approves by saving: `document` is the diagram with the proposal's steps
   * made (`applied` of them), built on the state this tab last loaded or
   * saved. The server stores it only if the diagram is still in that state
   * and records the approval only once it is stored; `reason: 'conflict'`
   * means the diagram changed elsewhere and nothing was stored.
   */
  approveProposal?(id: string, proposalId: string, change: { applied: number; document: unknown }): Promise<ProposalDecision>;
  /** Records that the person turned the proposal down; nothing changes. */
  rejectProposal?(id: string, proposalId: string): Promise<ProposalDecision>;

  // Reserved for P3 — no-op stubs for now
  subscribe?(diagramId: string, callback: () => void): () => void;
}
