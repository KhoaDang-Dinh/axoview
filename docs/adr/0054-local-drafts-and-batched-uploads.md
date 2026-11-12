# ADR 0054 — Local Drafts and Batched Uploads

**Status:** Accepted
**Date:** 2026-11-06
**Supersedes:** none
**Superseded by:** none

## Context

With server storage the editor saved the whole diagram 2 s after every pause
([`useAutoSave.ts`](../../packages/axoview-app/src/hooks/useAutoSave.ts)). A one-minute scripted
editing session made 11 uploads. On AWS each was an S3 object (versioned and kept), a DynamoDB
write, a change-log write, and a re-download by every other open tab. Most of those uploads had
no reader: the same person in one browser was the only one looking.

Making each save cheaper (one metadata read, nothing for an unchanged save) is a separate change
in the backend routes. This ADR decides **how often** a browser uploads. It depends on
[ADR 0053](0053-presence-on-the-sync-stream.md) to know when another browser is watching.

## Decision

1. **Each 2 s autosave is a checkpoint, not an upload.** The model goes into a Zustand store
   ([`draftStore.ts`](../../packages/axoview-app/src/stores/draftStore.ts)) and to IndexedDB
   ([`draftDb.ts`](../../packages/axoview-app/src/services/storage/draftDb.ts)). Each checkpoint
   is one record per user and diagram (`draft:<userKey>:<id>`), with the server stamp it was
   edited from and a checkpoint id (`rev`).
2. **Upload policy while no other browser is present:** one upload of the latest checkpoint, at
   most `UPLOAD_BATCH_MS` (30 s) after the first checkpoint not yet uploaded.

   It uploads **at once** when:
   - another browser appears (presence);
   - the tab is hidden, or the page goes away (`pagehide`; a `keepalive` request under 48 KB);
   - the user saves explicitly (Ctrl+S), switches diagram, shares, exports or signs out (every
     existing `saveNow()` flush point);
   - the checkpoint could not be persisted (no IndexedDB): nothing would survive a crash.

   With another browser present, every checkpoint uploads at once, as before.
3. **Status and leaving:**
   - **Status:** while an upload is queued the status reads **"Saved in this browser"**.
   - **Leaving the page:** the `beforeunload` warning covers only work not yet persisted in the
     browser.
4. **Tabs of one browser share checkpoints** over the tab channel (BroadcastChannel only: a
   diagram may not fit the `localStorage` fallback).

   Each checkpoint names the checkpoints it descends from (`parents`). A tab takes another tab's
   checkpoint only when both hold:
   - it has no edit of its own that isn't checkpointed yet;
   - if it has one queued for upload, that one is among the `parents`.

   When it takes the checkpoint, it drops its own queued upload. Otherwise both upload and the
   later save wins, as between devices. A tab skips the server's echo of a sibling upload it
   already shows.
5. **Recovery on open.** A diagram opened with a draft is handled one of three ways:
   - **Restored and uploaded** when the server is still at the draft's stamp: its version, or
     `lastModified` on a store without versions (write responses now carry it).
   - **Dropped silently** when the server already has its items, pages and colours (an upload
     that was delivered late).
   - **Offered** with a **Restore my edits** action when the diagram changed elsewhere since.
     The draft never overwrites another device's save unasked.
6. **Drafts belong to the signed-in user and are wiped on sign-out,** in the signing-out tab and
   in every other tab (after each flushes what it can). The next person at a shared computer
   finds none.
7. **Scope:** server storage with the local provider only. Drive and session storage keep the
   2 s upload.

**Rejected:**
- **Batching many users' writes into one request:** DynamoDB bills per item, so it saves no
  capacity, and it risks tenant isolation.
- **A DynamoDB transaction for the metadata and the sync event:** twice the write capacity.
- **`persist` middleware over one blob:** tabs overwrite each other's drafts.
- **`localStorage`:** the quota is smaller than diagrams with imported icons.

## Consequences

**Positive:**
- The measured session went from 11 uploads (22 KB) to 1 (about 2 KB). The last edits upload when the
  tab is hidden or closed.
- A crash or a dropped connection no longer loses the last 2 s of work: it is in the browser.
- Same-browser tabs see each other's edits at once and no longer re-download the diagram.

**Negative / risks:**
- **The server copy can trail a lone editor by up to 30 s.** It can trail longer if the browser
  dies and is never reopened (the draft stays on that device).
- **External readers of the server see that staleness:** a share link, an MCP agent. See the TODO
  in [ADR 0053](0053-presence-on-the-sync-stream.md).
- **Two tabs of one browser editing the same diagram within 2 s of each other diverge;** the later
  upload wins, as between devices.
- **A browser wiped of site data loses unuploaded drafts.**

## Implementation notes (non-binding)

- The policy is `AutoSaveBatching`, an option of `useAutoSave`; without it the hook behaves as
  before. The `useAutoSave` result adds `hasUnpersistedWork` and `dropQueued`.
- Wiring, recovery and flush triggers live in
  [`DiagramLifecycleProvider.tsx`](../../packages/axoview-app/src/providers/DiagramLifecycleProvider.tsx):
  `batch`, `takeCheckpoint`, `recoverDraft`.
- `StorageManager` now forwards `knownVersion`, `noteVersion`, `serverStamp` and `noteStamp` to
  the active provider. Before, the app never saw a version, and realtime sync reloaded on every
  change.
- Opening a server diagram no longer writes it back (a pre-lean migration write the server always
  found unchanged).

## Acceptance criteria

- **Unit tests:**
  - [`useAutoSave.batching.test.ts`](../../packages/axoview-app/src/hooks/__tests__/useAutoSave.batching.test.ts):
    one upload per window; immediate with company or when not persisted; `saveNow`; the unload
    predicate; `dropQueued`.
  - [`draftStore.test.ts`](../../packages/axoview-app/src/stores/__tests__/draftStore.test.ts):
    an upload clears only its own checkpoint; sign-out wipes.
- **Browser tests:** `tests-docker/batched-upload.spec.ts` covers:
  - three checkpoints become one upload;
  - hiding the tab, closing the tab, or another browser appearing uploads at once;
  - a second tab shows the edit without a download;
  - after a lost upload, the draft is restored on the next open, or offered when the diagram
    changed elsewhere.

## Addendum 2026-11-10

- **Timing:** the checkpoint now follows 1 s after the last edit instead of 2 s (owner decision).
- **Shared diagrams:** a diagram other people have ([ADR 0057](0057-diagram-sharing-and-permissions.md)
  addendum; the server's `X-Axoview-Shared` header) uploads every checkpoint at once, like a
  workspace another browser has open.

