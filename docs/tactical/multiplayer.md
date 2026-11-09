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
- [ ] **Unit (lib, `src/sync/__tests__/`):**
  - op schema accepts and refuses the right shapes;
  - the translator round-trips every mutation family (place, move, connect, style, text, labels,
    layers, pages, paste, delete);
  - `applyBatch` is pure and deterministic (same input, same hash);
  - structural refusals carry reasons; batches are atomic (one refusal, nothing applied);
  - fractional `order`: inserts between, at both ends, and when two participants insert concurrently;
  - per-participant undo skips properties someone else changed since.
- [ ] **Convergence suite in CI:** a fixed seed, 5 and 20 participants, 10k ops, run on every PR
  that touches the lib

### B. Realtime service (backend, single region, one replica)
- [ ] WebSocket endpoint, `hello`/`since` join, broadcast, refusals
- [ ] Lease, takeover, drain on shutdown; forwarding by a pod that isn't the owner (tested at N=2)
- [ ] Journal batching, durability watermark, re-send with `opId` idempotency
- [ ] Checkpoints to S3, signed URLs, keeping the REST document in step
- [ ] Self-host: in-process with file journal and checkpoints
- [ ] Failure tests and the latency bench (ADR 0056 acceptance)
- [ ] **Unit (backend, `src/__tests__/realtime*.spec.js`):**
  - sequencer ordering and refusals;
  - lease taken, renewed, expired and taken over (fake clock);
  - journal batching and the durability watermark;
  - a duplicate `opId` is applied once;
  - checkpoint cadence and signed-URL expiry;
  - the fs journal round-trips for self-host.
- [ ] **Server integration (real WebSockets, like `server.sync.spec.js`):**
  - join from a checkpoint plus the tail;
  - `since N` catch-up;
  - an owner killed mid-burst loses nothing a client still holds;
  - forwarding by a pod that isn't the owner;
  - heartbeats; draining on shutdown.
- [ ] **Latency bench (CI artifact):** p50, p95 and p99 for ack and broadcast at 1, 5 and 20
  participants, plus the durability lag, compared against the ADR 0056 targets

### C. Client sync (app)
- [ ] Sync client: optimistic apply, held-back sets, rollback on refusal, offline queue
- [ ] Per-participant undo in multiplayer sessions
- [ ] Retire whole-document autosave and the #51 batching in server mode; the live status line
- [ ] Agent runner (server-side) and the in-browser harness submit batches
- [ ] **Unit (app):**
  - the sync client applies optimistically and holds back incoming sets on its own unaccepted paths;
  - a refusal rolls back;
  - the offline queue survives a reload (IndexedDB mocked);
  - the status line shows "Live", "Syncing…" and "Offline: N changes waiting";
  - an agent batch is refused whole and the agent re-plans.
- [ ] **E2E, Docker tier (`tests-docker/multiplayer-sync.spec.ts`):**
  - one user in two browsers plus a scripted agent converge on one diagram;
  - an edit in one shows in the other within the latency target;
  - undo in one doesn't revert the other's edit;
  - going offline queues edits, and reconnecting syncs them.

### D. Sharing and permissions
- [ ] Membership items, the "shared with me" index, `canAccess` on every route and socket
- [ ] Email field under Share: an existing verified account becomes an editor at once. A green pop-up on success; red for no account, already shared, yourself, or an error. A people list with remove; the "Shared with me" explorer root
- [ ] Live downgrade and removal of open sockets
- [ ] **Unit (backend):**
  - the role matrix for every REST route and socket message;
  - adding by email: an existing verified account becomes an editor; no account, an unverified
    account, already shared, or yourself is refused and stores nothing;
  - only the owner may add or remove;
  - the lookup is rate-limited;
  - an agent of a viewer is read-only.
- [ ] **Unit (app):** the Share email field:
  - a green pop-up and a cleared field on success;
  - a red pop-up with the email kept for each failure (no account, already shared, yourself,
    network);
  - the people list removes.
- [ ] **E2E, dev tier (`tests/share-people.spec.ts`, scripted API via `helpers/mockApi.ts`):** every
  pop-up colour and message, and the list updating, without a backend.
- [ ] **E2E, Docker tier (`tests-docker/sharing.spec.ts`, two signed-in users):**
  - adding by email is green, and the diagram appears in the second user's "Shared with me";
  - the second user edits live;
  - an unknown or repeated email is red;
  - removal takes the diagram away and closes their socket.

### E. Presence UI
- [ ] Awareness messages, the participants store, the participants bar, follow mode
- [ ] `RemoteParticipantsLayer` (cursors, selections, agent intent), under the perf gate
- [ ] **Unit (lib and app):**
  - tile-space cursor positions map to the same model point under rotation and 2D mode;
  - awareness throttling and the 30 s expiry;
  - the layer lets pointer events through;
  - avatar order (people, then agents) and "+N" overflow;
  - follow mode stops on pan or Escape.
- [ ] **Perf gate:** 20 simulated participants moving stay inside the perf harness budget
  (ADR 0020).
- [ ] **E2E, Docker tier (`tests-docker/presence.spec.ts`):**
  - two browsers see each other's avatar, cursor and selection;
  - following switches page;
  - a viewer's edit controls are disabled, with the "View only" chip.

### F. Infra (infra repo, `infra_website`)
Kubernetes (`deploy/k8s/base/`):
- [ ] An `axoview-realtime` Deployment from the same image (`ROLE=realtime`), with a Service, a
  PodDisruptionBudget and a service account. One replica and no HPA in the MVP: the lease, not
  replica count, decides ownership.
- [ ] Draining: a `preStop` hook plus `terminationGracePeriodSeconds` long enough to release leases
  and close sockets cleanly (the API pods have neither today).
- [ ] The smoke test (`smoke-test.yaml`) gains a WebSocket handshake to `/api/realtime/` after each
  deploy.

Edge (`modules/edge/edge.tf`):
- [ ] A `realtime_pods` target group (IP targets, `/healthz`, a longer deregistration delay than
  the API's 30 s so sockets can drain) and an ALB listener rule `/api/realtime/*` with priority
  over `/api/*`.
- [ ] A CloudFront `ordered_cache_behavior` for `/api/realtime/*` ahead of `/api/*`: caching off,
  compression off, all viewer headers forwarded (the WebSocket upgrade headers), like today's
  `/api/sync/*`.
- [ ] A data-bucket origin with origin access control, plus a `realtime/*` behaviour:
  - long cache lifetime;
  - query strings left out of the cache key;
  - `trusted_key_groups` (signed URLs), with an `aws_cloudfront_public_key` and an
    `aws_cloudfront_key_group`.
- [ ] Optional: a WAF rate rule on `/api/realtime/*` upgrades per IP (connection storms).

Data (`modules/data/data_services.tf`):
- [ ] A data-bucket policy statement letting the CloudFront distribution read `realtime/*` only.
- [ ] A lifecycle rule on `realtime/`: expire superseded checkpoints, and their noncurrent versions
  (versioning is on), after N days.
- [ ] DynamoDB needs no schema change: the journal, lease and membership items live in the existing
  table, and the TTL on `expiresAt` already expires journal items.

IAM and secrets:
- [ ] The realtime service account: the same DynamoDB and S3 actions as the API (data module
  policy), scoped to the same table and bucket.
- [ ] The API pod role gains `cognito-idp:ListUsers` on the user pool, for adding people by email.
  Today only the pre sign-up trigger's role has it.
- [ ] The CloudFront signing key follows the Google client-secret pattern:
  - the private key lives in GitHub secrets;
  - the shared-infra apply copies it into Secrets Manager;
  - on destroy, the secret is kept or erased (your choice);
  - the public key and key group are in Terraform;
  - the private key never enters Terraform state.

Observability (`modules/observability/`):
- [ ] Metrics with counts and latencies only, no content: acknowledgement and broadcast p95,
  durability lag, open sockets, lease takeovers, refused batches, adds by email.
- [ ] Alarms:
  - durability lag p95 above 1 s for 5 minutes;
  - acknowledgement p95 above 20 ms;
  - a burst of lease takeovers.
- [ ] A dashboard section beside "Agents".

Pipeline and reuse:
- [ ] The deploy workflow rolls the realtime Deployment with the API, plan-guard lists the new
  protected resources, and `adopt/registry.sh` plus `candidates.jq` gain checks for the new types
  that can already exist by name (key group, public key, listener rule, target group), so reruns
  adopt instead of failing.
- [ ] **Infra checks:**
  - the plan shows `/api/realtime/*` uncached and before `/api/*`;
  - an unsigned `realtime/*` fetch is 403, and a signed one is a cache hit on the second fetch;
  - the post-deploy WebSocket smoke test passes;
  - the alarms fire on a synthetic latency breach.

## Test conventions

- **Unit tests:** next to the code (`__tests__/`), under each package's Jest config. For the
  backend: `npm test --workspace=axoview-backend`.
- **Server-backed browser tests:** Docker tier (`packages/axoview-e2e/tests-docker/`): DOM only, no
  bridge, `data-axoview-id` hooks. Two-user specs need two signed-in identities: add a test-only
  sign-in fixture before D's specs.
- **UI-only browser tests:** dev tier with the scripted API (`helpers/mockApi.ts`).
- **Before a group is ticked:** its unit tests, the convergence suite and its e2e specs pass in CI,
  and the Docker smoke and regression runs stay green.

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
