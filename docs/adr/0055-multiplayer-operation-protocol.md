# ADR 0055 — Multiplayer Operation Protocol and Consistency Model

**Status:** Proposed
**Date:** 2026-11-09
**Supersedes:** none
**Superseded by:** none

## Context

Server storage saves a diagram as a whole document. A client sends a full `PUT`, and a `409` is
resolved by "latest save wins" (`LocalStorageProvider.serverSaveDiagram`). With one writer that
is fine. With several people and AI agents editing one diagram live, it silently loses work: two
fast writers overwrite each other, and every copy re-downloads the whole document on every change.

The owner decided on 2026-11-09 to support multiplayer and to change backend and frontend for it.
This ADR fixes **what travels**, from client to server and back, and how copies stay identical.
[ADR 0056](0056-realtime-service-on-eks.md) decides where the authority runs.
[ADR 0057](0057-diagram-sharing-and-permissions.md) decides who may join.
[ADR 0058](0058-multiplayer-presence-ui.md) decides what people see of each other.

Facts this builds on:
- **Diagram content** is `model.items` plus, per page, `views[].items | rectangles | connectors |
  textBoxes | labels`, all arrays of id'd entities
  ([`schemas/views.ts`](../../packages/axoview-lib/src/schemas/views.ts)).
- **Every edit already produces Immer patches** for undo (`modelStore`, `sceneStore`,
  [`historySequence.ts`](../../packages/axoview-lib/src/stores/historySequence.ts)). Their paths
  are array indices, which shift under concurrent edits.
- **`sceneStore` holds derived state** (connector paths, text box sizes) recomputed from the model.
- **Agent ops are eight coarse intents** (`add_node`, `connect`, …) in
  [`agent/operations.ts`](../../packages/axoview-lib/src/agent/operations.ts), validated by
  `planOperations` against the live page.

Approach chosen over the alternatives (owner, 2026-11-09): a server-authoritative sequencer,
Figma-style. Rejected:
- **A CRDT (Yjs):** structural edits by agents could not be checked against one current state.
- **A hosted service:** data leaves AWS, and adds cost and lock-in.

## Decision

1. **Only operations travel. Each one addresses an entity by id, never by array position:**
   ```ts
   type EntityKind = 'item' | 'viewItem' | 'rectangle' | 'connector' | 'textBox' | 'label' | 'view' | 'icon' | 'color' | 'diagram';
   type Op =
     | { t: 'set';    kind: EntityKind; view?: string; id: string; path: string[]; value: Json }  // one property
     | { t: 'create'; kind: EntityKind; view?: string; id: string; value: Json }                  // whole entity
     | { t: 'delete'; kind: EntityKind; view?: string; id: string };
   interface OpBatch {
     opId: string;            // idempotency key, unique per actor
     actor: string;           // participant id (person tab or agent), ADR 0057
     base: number;            // last sequence number the sender had applied
     ops: Op[];               // applied atomically, in order
     intent?: AgentIntent[];  // optional: the agent intents these ops implement (audit, review)
   }
   ```
   The editor derives ops from its Immer patches through a translation layer that maps index paths
   to entity ids. Derived `sceneStore` state never travels; every copy recomputes it.
2. **Merge rules:**
   - **`set`:** last writer wins per property path, in the server's order. No timestamps.
   - **`create` and `delete`:** checked on the server against the current state. A `create` that
     references a missing entity is refused, as is a `set` on a deleted entity, or a `connect`
     whose end has gone.
   - **Atomic batches:** a batch with any refused op is refused whole, with the reasons and the
     current sequence number. The sender re-plans against it. Agents always submit batches, so one
     agent's plan never interleaves with another's halfway through.
3. **The sender creates ids** (`crypto.randomUUID()`, already `generateId`). Creating something
   needs no round trip, and the id travels with the op, so every copy holds the same ids.
4. **Order among siblings** (pages, and z-order of rectangles, text boxes and items) is a
   fractional index property `order` on the entity (a string between its neighbours). Moving is one
   `set`, so concurrent reorders converge. Arrays are sorted by `order` when materialised, and
   stored documents and `.zip` exports keep plain arrays in that order
   ([ADR 0001](0001-project-zip-format.md) unchanged).
5. **Clients apply their own batches at once.** They keep each batch until the server accepts it.
   An incoming `set` on a path covered by one of the client's unaccepted batches is held back until
   that batch is accepted or refused, so values never flicker back. A refused batch is rolled back
   by its inverse.
6. **Undo is per participant.** Undo re-sends the inverse of the participant's own last batch as a
   new batch. A property someone else has changed since is skipped: undo never overwrites another
   participant's later edit. The existing dual-stack history keeps working for local-only modes
   (session and Drive storage).
7. **Agent intents compile to ops.** `planOperations` and `applyOperations` run on the client (or
   in the server-side agent runner), produce an `OpBatch`, and the sequencer checks it like any
   other. The intent vocabulary can grow without changing the wire.
8. **Scope:** server storage only. Session storage and Google Drive
   ([ADR 0042](0042-drive-native-sharing-and-readonly-preview.md)) keep single-writer saves.

## Consequences

**Positive:**
- **Copies are byte-identical at every sequence number,** and nothing is lost to "latest save wins".
- **Messages are small:** a property edit is tens of bytes, not a whole document.
- **People and agents share one protocol,** and agent plans arrive whole or not at all.

**Negative / risks:**
- **The patch-to-op translation is the riskiest piece.** Every editor mutation must map to id'd
  ops, and anything missed desyncs copies. Convergence simulation tests are mandatory (see below).
- **Schema change:** `order` on ordered entities. Old documents are read in array order, and orders
  are assigned on first write.
- **Last-writer-wins is per property, not per intent:** two people dragging one node end with the
  later position. Acceptable for a diagram editor, and Figma has made the same call.
- **The per-participant undo differs from today's global undo** in multiplayer sessions.

> TODO: how long may a client stay offline with unaccepted batches before it must reload? (A
> limit on queue age or size.)

## Implementation notes (non-binding)

- **Location:** `packages/axoview-lib/src/sync/` would hold the op types, the patch translator,
  and a pure `applyBatch(state, batch)` shared with the backend sequencer (same JavaScript).
- **Fractional indexes:** a small, well-tested implementation such as the published "fractional
  indexing" algorithm, string keys.
- **Offline queue:** the [ADR 0054](0054-local-drafts-and-batched-uploads.md) draft store becomes
  the offline queue of unaccepted batches (IndexedDB, per user).

## Acceptance criteria

- **Convergence test:**
  - **Workload:** N simulated participants (people and agents) submit random valid and conflicting
    batches with a fixed seed.
  - **Pass condition:** after every sequence number, every copy's state hash equals the sequencer's.
- **Translator test:** every editor mutation, driven by the existing interaction tests, yields ops
  that rebuild the same model on a second copy.
- **Undo test:** undoing a batch whose property was changed later by someone else leaves that
  change in place.
- **Agent test:** a batch referencing a node deleted concurrently is refused whole, with the reason
  and the current sequence number.
