# ADR 0056 — Realtime Service on EKS: Sequencer, Journal, Checkpoints

**Status:** Proposed
**Date:** 2026-11-09
**Supersedes:** none
**Superseded by:** none

## Context

[ADR 0055](0055-multiplayer-operation-protocol.md) needs one authority per open diagram that orders
batches, checks them, and pushes them to every participant with low latency. The owner chose AWS
EKS behind the existing CloudFront distribution and ALB (2026-11-09).

What exists:
- **API pods:** stateless, two replicas plus an HPA (`deploy/k8s/base/workload.yaml` in the infra
  repo), with cookie stickiness only during a canary.
- **Sync stream:** `GET /api/sync/events` polls the change cursor in DynamoDB once a second per
  stream (`SYNC_POLL_MS`), and carries workspace-level changes and presence
  ([ADR 0053](0053-presence-on-the-sync-stream.md)).
- **Storage:** diagrams live in S3 (immutable versioned objects) and DynamoDB (metadata and the
  `SYNC#` change log), in the workspace adapter
  ([`adapters/aws.js`](../../packages/axoview-backend/src/adapters/aws.js)).

Figma publishes the same shape on the same services:
- **State** in memory per document.
- **Journal** in DynamoDB, batched about every 0.5 s.
- **Checkpoints** in S3 every 30–60 s.
- **A lock** so one instance owns a file.

Its stated goal is under 1 s of possible loss.

## Decision

1. **Separate realtime service.**
   - **Same image, different role:** a `realtime` Deployment from the same backend image with a
     different entrypoint and environment.
   - **Routing:** an ALB target group on `/api/realtime/*`. CloudFront forwards WebSocket upgrades
     on that path, uncached.
   - **API pods unchanged:** they keep serving REST and the workspace sync stream.
2. **One owner per diagram, by lease.**
   - **The lease:** a DynamoDB item `DIAGRAM#<id>` / `LEASE` holds the owner pod's address and an
     expiry of about 10 s, renewed about every 3 s, taken with a conditional write.
   - **Connecting:** a client may reach any realtime pod. A pod that isn't the owner forwards the
     socket to the owner over the cluster network.
   - **Taking over:** when an owner dies, the next connection takes the expired lease and rebuilds
     state from checkpoint plus journal.
   - **MVP sizing:** one replica, with the lease giving clean takeover. Forwarding enables N
     replicas later, without a protocol change.
3. **Ordering is in memory; durability follows.**
   - **The owner applies a batch** (ADR 0055 `applyBatch`, the same code as the client), assigns
     the next sequence number, acknowledges `ordered` to the sender and broadcasts it to the
     others. There is no database in this path.
   - **Journal:** batches since the last write go to DynamoDB about every 500 ms
     (`DIAGRAM#<id>` / `OP#<15-digit seq>`, expiring once a checkpoint covers them).
   - **Durability watermark:** after each journal write the owner broadcasts it. Clients keep
     their batches until the watermark passes them, and re-send unacknowledged ones on reconnect.
     `opId` makes the re-send idempotent, so an owner crash loses nothing a client still holds.
4. **Checkpoints are immutable and cached.**
   - **Writing:** every 1,000 ops or 60 s, the owner writes the materialised diagram to S3 at
     `realtime/<diagram>/<seq>-<random>.json`. The existing document object is updated at the same
     moment, so REST, export and share links see the same content.
   - **Serving:** a CloudFront behaviour serves `realtime/*` from the data bucket with a long cache
     lifetime. Access is by a **signed URL** in the join message, short-lived, with query strings
     left out of the cache key. One cached object then serves every participant.
5. **Joining:**
   1. The client opens the socket with its token (authorised per [ADR 0057](0057-diagram-sharing-and-permissions.md)).
   2. The owner answers with the latest checkpoint's sequence number and signed URL, and the
      current head.
   3. In parallel, the client fetches the checkpoint from CloudFront, receives the journal tail
      over the socket, and buffers live batches. It applies them in order with no gaps.
   4. A client that was briefly away just asks for "batches since N".
6. **Liveness:**
   - **Heartbeats** every 15 s each way keep the ALB and CloudFront idle timeouts at bay.
   - **Drain on deploy:** a pod in shutdown drains its sockets and releases its leases, so clients
     reconnect and the next owner takes over.
7. **Self-host (Docker):** the realtime service runs in the backend process, with the journal as an
   append-only file and checkpoints as files. **The Worker target has no realtime service.**
8. **Latency targets,** measured and trended in CI and in CloudWatch:
   - `ordered` acknowledgement p95 under 20 ms within the region;
   - broadcast to another participant p95 under 50 ms within the region;
   - durability watermark lag p95 under 1 s.

## Consequences

**Positive:**
- **No database round trip per edit.** Sockets replace once-a-second polling for open diagrams.
- **Joining is cheap even in bursts:** a cached checkpoint plus a short tail.
- **Fewer S3 writes:** one checkpoint per 1,000 ops or 60 s instead of one object per save.

**Negative / risks:**
- **A stateful service to run:** leases, forwarding, draining and takeover, all needing failure
  tests.
- **One owner per diagram is a single point of ordering.** Very hot diagrams are bounded by one
  pod's CPU.
- **Far-away participants pay their round trip to the region.** Multi-region is out of scope.
- **The signed-URL key pair has to be created, stored and rotated.**

**Timeouts (2026-11-09, infra repo `modules/edge/edge.tf`):** the distribution's origin read
timeout is 30 s and the ALB idle timeout 60 s (the same budget the SSE stream lives within today),
so a 15 s heartbeat fits under both.

> TODO: confirm in staging that CloudFront holds an idle WebSocket open under those settings.

## Implementation notes (non-binding)

- **WebSocket library:** `ws` on Node, with a binary encoding (MessagePack or Protobuf) after the
  MVP.
- **Wire messages:** `hello`, `batch`, `ordered`, `refused`, `broadcast`, `durable`, `since`,
  `awareness` (ADR 0058), `ping`.
- **Metrics:** reuse the agent telemetry pattern (counts and latencies, no content) for CloudWatch
  dashboards and alarms.

## Acceptance criteria

- **Failure tests:**
  - an owner killed mid-burst loses no acknowledged batch that a client still holds;
  - a duplicate `opId` is applied once;
  - a pod that isn't the owner forwards correctly;
  - a lease expires and is taken over.
- **Latency bench:** 1, 5 and 20 participants. Report p50, p95 and p99 against the targets above,
  plus join latency during a 20-client burst.
- **Docker-tier e2e:** two browsers and a scripted agent converge on one diagram through nginx.
