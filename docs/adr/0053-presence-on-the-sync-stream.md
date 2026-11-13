# ADR 0053 — Presence on the Sync Stream

**Status:** Accepted
**Date:** 2026-11-06
**Supersedes:** none
**Superseded by:** none

## Context

Server storage streams workspace changes to every open tab over `GET /api/sync/events`
(Server-Sent Events; the queue and cursor in
[`syncCursor.js`](../../packages/axoview-backend/src/syncCursor.js), the stream in
[`server.js`](../../packages/axoview-backend/server.js)). The stream says what changed, not who
is watching. [ADR 0054](0054-local-drafts-and-batched-uploads.md) uploads edits in batches while
nobody else has the workspace open and at once when somebody does, so the app needs to know
whether another browser is there, and to learn it within seconds when one arrives.

A tab of the same browser is not "somebody else" for this purpose: tabs of one browser share edits
over the tab channel
([`tabChannel.ts`](../../packages/axoview-app/src/services/sync/tabChannel.ts)) without the
server.

## Decision

1. **Presence rides the existing change stream**, as change events of `kind: 'presence'`, through
   the same per-workspace queue as diagram changes. No new endpoint, table or connection.
2. **Two random ids, request headers only on the stream request:**
   - `X-Axoview-Device`: one per page load (already sent on writes; `deviceId.ts`).
   - `X-Axoview-Browser`: one per browser profile, shared by its tabs through `localStorage`
     ([`browserId.ts`](../../packages/axoview-app/src/services/sync/browserId.ts)).
   Neither identifies the user; both are validated against the device-id pattern. A stream
   without both announces nothing (older apps, curl).
3. **Four actions:**

   | Action | Published when | By |
   |---|---|---|
   | `join` | a fresh stream opens (no `Last-Event-ID`) | that stream |
   | `renew` | a stream reconnects (with `Last-Event-ID`), about every 5 minutes | that stream |
   | `here` | a stream sees a `join` from **another** browser (once per joining tab) | each other browser's stream |
   | `leave` | the client closes the stream | that stream |

   A stream the server ends (its maximum age, a shutdown) publishes no `leave`: the tab
   reconnects at once, so presence does not flap on deploys or the 5-minute cycle. `renew` is not
   answered.
4. **The client keeps other browsers only**
   ([`presence.ts`](../../packages/axoview-app/src/services/sync/presence.ts), a Zustand store):
   its own browser's tabs are ignored, `leave` removes a tab, and a tab not heard from for
   `PRESENCE_TTL_MS` (6 minutes, past the 5-minute renewal) counts as gone. Without a stream (sync
   off, the Worker deployment) the client assumes it is alone.
5. **Presence never changes what is on screen:** `planSyncReaction` ignores it, and the app's own
   echo is dropped by device id like any other change.
6. **`SYNC_PRESENCE=off`** stops the announcements; clients then always batch.

## Consequences

**Positive:**
- A browser learns about another within about a second of it opening the workspace (its `join`),
  and the newcomer learns about the browsers already there from their `here`.
- No new infrastructure: on AWS it reuses the DynamoDB change log and cursor.

**Negative / risks:**
- **Cost:** one change-log write per stream open (about every 5 minutes per tab), one per close,
  and one `here` per other browser when a tab joins. Each also wakes every stream of the
  workspace. Small next to the saves it lets [ADR 0054](0054-local-drafts-and-batched-uploads.md)
  skip, but it grows with tabs × browsers.
- **Old clients refresh their file tree on each presence event** (they treat unknown kinds as
  tree changes) until they reload onto this version.
- **Stale up to the TTL:** a browser that vanished without a `leave` (crash, lost network) still
  counts for up to 6 minutes. That only makes uploads immediate for a while, the safe direction.
- **Agent sessions are not announced.** An external MCP client that reads the server does not
  make an editing browser upload faster.

  > TODO: decide whether an MCP read of a diagram should first ask open browsers to flush (for
  > example a presence-style `flush` event), or whether up to 30 s of staleness is acceptable for
  > agents. The in-app assistant is unaffected: it sends the page from the browser.

## Implementation notes (non-binding)

- Server: `announce()` and the `answered` set in the `/api/sync/events` handler; `leave` is
  decided by `!res.writableEnded && !shuttingDown` at `req` close.
- Client: `connectRealtimeSync` sends both headers; `useRealtimeSync` routes presence to the store
  and clears it when the stream closes for good.

## Acceptance criteria

- **Server test:** a new browser joins, the browser already there answers once, a second tab of
  the same browser is not answered by its own browser, a closed tab leaves
  ([`server.sync.spec.js`](../../packages/axoview-backend/src/__tests__/server.sync.spec.js)).
- **Server test:** a server-ended stream is no `leave`; its reconnect is a `renew`; a stream
  without both ids and `SYNC_PRESENCE=off` announce nothing.
- **Unit test:** own-browser tabs are not company; TTL expiry; a renewal keeps a tab; one tab of a
  browser leaving does not hide its other tab
  ([`presence.test.ts`](../../packages/axoview-app/src/services/sync/__tests__/presence.test.ts)).
- **Browser test:** a second browser opening the workspace makes the first upload its next edit
  at once (`tests-docker/batched-upload.spec.ts`).

## Addendum 2026-11-13

[ADR 0054](0054-local-drafts-and-batched-uploads.md) no longer holds uploads while one browser is
alone (its addendum 2026-11-13): every change uploads at once. Presence still drives the "who is
here" UI ([ADR 0058](0058-multiplayer-presence-ui.md)); it no longer changes how often a browser
uploads.

