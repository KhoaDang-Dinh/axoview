# Tactical — Multiplayer and Agent Collaboration

> **Read first:**
> - [docs/workflow.md](../workflow.md)
> - [ADR 0055 — Multiplayer Operation Protocol](../adr/0055-multiplayer-operation-protocol.md)
> - [ADR 0056 — Realtime Service on EKS](../adr/0056-realtime-service-on-eks.md)
> - [ADR 0057 — Diagram Sharing and Permissions](../adr/0057-diagram-sharing-and-permissions.md)
> - [ADR 0058 — Multiplayer Presence UI](../adr/0058-multiplayer-presence-ui.md)
> - Context: [ADR 0052](../adr/0052-ai-assistant-boundaries.md) (agent boundaries), [ADR 0053](../adr/0053-presence-on-the-sync-stream.md) and [ADR 0054](../adr/0054-local-drafts-and-batched-uploads.md) (interim presence and batching)
>
> **Status:** Not started · **Owner:** KhoaDang-Dinh · **Last updated:** 2026-11-09
>
> This is a **short-lived working doc.** Delete it after the work merges; ADRs are the durable record. PLAN.md gets a one-line entry referencing the ADRs once shipped — see "Wrap-up" below.

## Session startup checklist

1. Read this file fully.
2. Read each linked ADR.
3. Skim `PLAN.md` Phase Status Dashboard **for context only** — do not modify it during this work.
4. Mark `[x]` as work completes.
5. On completion, follow the "Wrap-up" section to update PLAN.md with a single line.

## Goal

Several people and their AI agents edit one server-stored diagram live, with low latency and one
consistent copy. Edits travel as id-addressed operations, ordered by one in-memory sequencer per
diagram on EKS.

**Not goals:**
- multi-region;
- multiplayer for session storage or Drive;
- the Worker deployment target;
- offline editing beyond a short reconnect.

## Scope

### In scope
- **Lib:** op types, a patch-to-op translator, a pure `applyBatch`, fractional order, per-participant
  undo, the remote participants layer.
- **Backend:** the realtime service (lease, forwarding, journal, checkpoints, sockets), membership and
  `canAccess`, invites, the "shared with me" listing.
- **App:**
  - a sync client (optimistic apply, held-back sets, re-send);
  - the participants bar and follow mode;
  - the People section in the share dialog;
  - the "Shared with me" explorer root;
  - the live status line.
- **Agents:** a server-side runner as a protocol participant, and the in-browser harness submitting
  batches.
- **Infra:**
  - the `realtime` Deployment and its ALB target group;
  - CloudFront: the WebSocket path and a `realtime/*` checkpoint behaviour with signed URLs;
  - the signing key in Secrets Manager;
  - CloudWatch latency metrics.

### Out of scope
CRDTs, multi-region, team workspaces, ownership transfer, binary encoding (after the MVP).

## Locked decisions (from design discussion 2026-11-09)

| # | Decision |
|---|---|
| 1 | Own server-authoritative sequencer, Figma-style. Not Yjs, not a hosted service. |
| 2 | The authority runs on AWS EKS behind CloudFront and the ALB, not Cloudflare. |
| 3 | Ops address entities by id. `set` is last-writer-wins per property; structural ops are checked; batches are atomic. |
| 4 | Ids are created by the sender. Order among siblings is a fractional `order`. |
| 5 | Acknowledge on ordering. Journal to DynamoDB about every 500 ms; S3 checkpoints are cached at CloudFront. Clients keep batches until the durability watermark passes them. |
| 6 | Sharing is a membership list on the diagram: owner, editor, viewer. No data migration. People are added through an email field under Share: an existing verified account is added at once, with no pending invites and no emails (owner, 2026-11-09). |
| 7 | Agents act for a person, with a role no higher than that person's. |
| 8 | PR #51 (batched uploads) merges as an interim step. Its batching is retired in server mode by phase C. |
| 9 | Four ADRs (0055–0058). It lands in PLAN.md as a new phase **MP** at wrap. |

## Sub-tasks

### A. Protocol foundation (lib, no network)
- [ ] Op types and `OpBatch` (ADR 0055 §1)
- [ ] Patch-to-op translator for every editor mutation, including multi-page paste
- [ ] Pure `applyBatch` plus checks for structural ops, shared with the backend
- [ ] Fractional `order` on ordered entities, with reading and assigning for old documents
- [ ] Convergence simulation (seeded; N participants; state hash per sequence number)

### B. Realtime service (backend, single region, one replica)
- [ ] WebSocket endpoint, `hello`/`since` join, broadcast, refusals
- [ ] Lease, takeover, drain on shutdown; forwarding by a pod that isn't the owner (tested at N=2)
- [ ] Journal batching, durability watermark, re-send with `opId` idempotency
- [ ] Checkpoints to S3, signed URLs, keeping the REST document in step
- [ ] Self-host: in-process with file journal and checkpoints
- [ ] Failure tests and the latency bench (ADR 0056 acceptance)

### C. Client sync (app)
- [ ] Sync client: optimistic apply, held-back sets, rollback on refusal, offline queue
- [ ] Per-participant undo in multiplayer sessions
- [ ] Retire whole-document autosave and the #51 batching in server mode; the live status line
- [ ] Agent runner (server-side) and the in-browser harness submit batches

### D. Sharing and permissions
- [ ] Membership items, the "shared with me" index, `canAccess` on every route and socket
- [ ] Email field under Share: an existing verified account becomes an editor at once. A green pop-up on success; red for no account, already shared, yourself, or an error. A people list with remove; the "Shared with me" explorer root
- [ ] Live downgrade and removal of open sockets

### E. Presence UI
- [ ] Awareness messages, the participants store, the participants bar, follow mode
- [ ] `RemoteParticipantsLayer` (cursors, selections, agent intent), under the perf gate

### F. Infra (infra repo)
- [ ] `realtime` Deployment and its target group; CloudFront WebSocket path; the `realtime/*`
  behaviour with signed URLs
- [ ] Signing key in Secrets Manager; latency and durability metrics, with alarms

## Wrap-up

When all sub-tasks are complete and the smoke checklist passes:

1. Add a single line under a new `PLAN.md` phase **MP — Multiplayer & agent collaboration**:
   ```
   - Multiplayer and agent collaboration shipped — see docs/adr/0055..0058 and (this file's git history).
   ```
2. Delete this file. The ADRs are the durable record; this checklist's job is done.
3. Update any relevant memory pointer (optional — only if one exists) if decisions here supersede or extend it.

## Notes for Claude

- **The translator (A) gates everything.** A mutation it misses desyncs copies silently, so grow the
  convergence test with every editor feature.
- **`sceneStore` is derived:** never sync it. Recompute connector paths and text sizes on each copy.
- **Spans lib, app, backend and the infra repo:** build both libs after every lib change, and keep
  infra in its own PRs (infra commit trailers differ).
- **Supersession edges:** when 0055–0058 move to Accepted, ADR 0054's upload batching (§2) and ADR
  0053's role for open diagrams are superseded in part. Add those reciprocal edges then, not before.
- **Phase B ships to one user across devices plus agents first** (next week's agent MVP), before D
  opens it to other people.
