# Yjs collaboration

Each open cloud diagram has one Y.Doc. Stable entity IDs identify nested items,
views and connectors; scalar fields merge independently. Label/title/content
strings use Y.Text. Yjs owns document content and selective undo. Account logout
and document lifecycle messages stay on the existing native tab channel; legacy
whole-document checkpoint broadcasts are suppressed for active Yjs sessions.

## Transport and saving

- WebRTC data channels use `stun:stun.l.google.com:19302` and
  `stun:stun.cloudflare.com:3478`. Authenticated HTTP/SSE exchanges signaling.
  There is no dependency on a public signaling service or TURN subscription.
- Signals are separate requests, so an ICE candidate can arrive before the
  offer or answer it belongs to; it is kept until that description is set. An
  attempt that has not connected after 12 seconds is dropped and retried on the
  next `hello` (every 15 seconds).
- SSE remains connected alongside WebRTC. Peers behind restrictive NAT, blocked
  UDP, or unavailable STUN continue through HTTP uploads plus SSE downloads.
  SSE is one-way: writes always use authenticated HTTP.
- Local edits reach peers immediately and upload in short batches (60 ms normally,
  250 ms during a burst). IndexedDB retains the Y.Doc for offline recovery.
- The server acknowledges only after persisting a journal entry. DynamoDB uses an
  atomic sequence/update/deduplication transaction. Large deltas use immutable S3
  objects referenced by the journal. Filesystem deployments use an atomic local
  journal and support one API process.
- Full JSON plus Yjs checkpoints are assembled on the server `AUTOSAVE_DELAY_MS`
  after the last edit (default 1.5 seconds), or at most 15 seconds into
  continuous activity. The same setting is the app's autosave delay: the
  backend reads it once (`src/autosaveDelay.js`, 250 to 30000 ms) and tells
  the app through `/api/config` (`autosaveDelayMs`). Deployments set it with
  the GitHub variable `DEV_AUTOSAVE_DELAY_MS` / `PROD_AUTOSAVE_DELAY_MS`. Explicit save, diagram
  switching and logout flush pending uploads and checkpoint immediately.
  Browser termination is best effort; IndexedDB and acknowledged journal entries
  are the recovery mechanism. Network failure cannot guarantee a final upload.
- Snapshot writes use the existing conditional diagram version. A journal row
  is pruned only after a successful checkpoint covering it. Redis caches are
  checked against the durable version; Redis loss does not lose acknowledged edits.
- Redis Pub/Sub wakes workspace SSE streams across pods immediately, including
  existing agent proposal/change notifications. Durable cursor replay remains
  available when Pub/Sub disconnects. A periodic state-vector reconciliation
  repairs missed transport updates.

This intentionally saves deltas and periodically reassembles a snapshot, rather
than replacing the whole diagram on each pointer move. Durable journal writes
still incur DynamoDB requests; throttling checkpoints does not mean keeping the
only copy of edits in Redis.

## Compatibility and controls

`COLLABORATION_ENABLED=off` disables new frontend sessions via `/api/config`.
Existing journaled diagrams remain readable and whole-document writes are
converted to deltas. Express server storage enables the capability by default;
Worker/Drive/session-only deployments retain their existing paths.

`REDIS_URL` is an optional TLS connection URL. Without it, storage and SSE still
work, with durable cursor polling instead of cross-pod push. Production receives
it through a Kubernetes Secret populated from SSM SecureString by infrastructure.

Every collaboration read uses normal diagram membership; only owners/admins may
write or signal. Peers recheck access every 15 seconds and close when access is
removed/downgraded. WebRTC endpoints necessarily reveal peer network addresses
to participating editors. Public share links do not join collaborative rooms.

Document generations isolate recreated IDs and their IndexedDB/tab/peer state.
Native diagram/agent writes enter the same Yjs journal. Metadata such as folders,
trash state, timestamps and share identifiers is not owned by the CRDT.

## Approving an agent's proposal in a live session

Approval is still a save that must succeed before the agent is told "approved"
(ADR 0059). In a live session the app first asks the server for a snapshot, so
the approval is checked against the version holding every edit so far. The
server then writes the approved change into the shared document. The editor
receives it as that document's update, like every other device, and does not
apply it a second time locally (two concurrent edits of the same text would
double it). It is therefore not on the approver's own undo stack.

Yjs is loaded on demand when a server diagram opens
(`services/sync/collaborationRegistry.ts` answers "is this diagram live?"
without it), which keeps it out of the app's first chunk.

## Validation and rollout

Build both app and backend images together, then deploy the infrastructure and
application to dev before production. The backend Docker lockfile uses
`--install-links` so the shared collaboration package is copied into the image.

The tests cover independent-field/character merges, concurrent insertion and
deletion, replay, restart-before-snapshot recovery, failed durable writes,
membership enforcement, two-device updates, SSE-only concurrent editing,
selective undo, and a WebRTC data channel opening and carrying an edit on
both storage kinds. The AI button test checks the animated 3px border, adaptive help
bubble and reduced-motion preference.

Run the agent Playwright suite against both `fs` and simulated `aws` storage.
A real Redis failover and AWS AZ outage drill remain deployment validation, not
something a local simulated AWS adapter proves.
