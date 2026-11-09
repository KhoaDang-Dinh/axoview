# ADR 0058 — Multiplayer Presence UI: Participants, Cursors, Selections

**Status:** Proposed
**Date:** 2026-11-09
**Supersedes:** none
**Superseded by:** none

## Context

With [ADR 0055](0055-multiplayer-operation-protocol.md)–[0057](0057-diagram-sharing-and-permissions.md),
several people and agents edit one diagram live. They need to see who is here, where others are
looking, and what each is touching, or they will collide.

Today's presence ([ADR 0053](0053-presence-on-the-sync-stream.md)) only counts other browsers per
workspace, to decide upload batching. It has no identity, no position and no UI.

Surfaces that exist:
- the toolbar share popover (`AppToolbar`, `share-*` hooks);
- the status area (`StatusCluster`);
- the lib's own local cursor (`components/Cursor/Cursor.tsx`).

There is no layer that draws other participants.

## Decision

1. **Awareness is ephemeral.** Each participant sends `awareness` messages over the realtime socket
   ([ADR 0056](0056-realtime-service-on-eks.md)). The service relays them and never journals them.
   - **Message:**
     ```ts
     { actor, name, color, kind: 'person' | 'agent', view, cursor?: {x, y}, selection?: string[], intent?: string }
     ```
   - **Rate:** throttled to about 20 per second while active, with one heartbeat every 15 s while
     idle.
   - **Leaving:** a participant not heard from for 30 s disappears.
2. **Positions are in the model's tile space,** not screen pixels, so cursors land on the same spot
   whatever each viewer's zoom, pan, view rotation
   ([ADR 0049](0049-view-rotation-camera-and-projection-model.md)) or 2D or isometric mode.
3. **A participants bar sits next to the Share control.**
   - **What it shows:** avatars with initials and a stable colour per participant, people first,
     then agents with a bot badge. Overflow collapses into "+N".
   - **Following:** clicking an avatar follows that participant's page and viewport until the user
     pans or presses Escape.
   - **Lone users** (no other participants) see nothing new.
4. **On the canvas:** a new lib layer, `RemoteParticipantsLayer`, draws:
   - other participants' cursors with a name tag;
   - their selection outlines in their colour;
   - an agent's current `intent` as a soft highlight with a one-line label (for example "adding
     database tier").

   **It never affects hit-testing:** pointer events pass through, so local selection and the
   two-way panel ↔ canvas sync ([ux-principles §4.1](../guidelines/ux-principles.md#41-two-way-panel--canvas-sync))
   stay exactly as they are.
5. **Only on the active page:** participants on another page show in the bar with that page's
   name, not on the canvas. Following them switches page.
6. **Roles:**
   - **Viewer:** a viewer's cursor and selection are shown like anyone's, but every edit control is
     disabled for them, with a "View only" chip
     ([ux-principles §11](../guidelines/ux-principles.md#11-whole-experience-coherence): the
     edit/view split).
   - **Present mode:** remote cursors are hidden for the presenter's audience.
7. **The status line moves from saving to syncing.** In a multiplayer session the old save status
   ("Saving…", "Saved in this browser") becomes:
   - **"Live":** connected and durable;
   - **"Syncing…":** waiting for the durability watermark;
   - **"Offline: N changes waiting":** unaccepted batches queued.

## Consequences

**Positive:**
- Collisions become visible before they happen, agent work is legible, and following makes pairing
  and reviews easy.
- No cost to lone users and no change to hit-testing or local selection.

**Negative / risks:**
- **A new canvas layer** in a renderer that is perf-sensitive (WebGL/Canvas2D substrates, ADR
  0038). It must stay cheap with 20+ participants.
- **Awareness traffic** grows with participants squared on busy diagrams (relay fan-out). It is
  bounded by the throttle.

> TODO: whether names come from the identity provider or a user-set display name, and whether
> agents get user-chosen names.

## Implementation notes (non-binding)

- **The layer:** `RemoteParticipantsLayer` beside `SceneLayer`, fed by a `useParticipantsStore`
  (Zustand) that the app fills from the socket.
- **Colours:** a small fixed palette from ADR 0039's standard palette, assigned by hashing the
  participant id.

## Acceptance criteria

- **Unit tests:**
  - tile-space cursor positions map to the same model point under rotation and 2D mode;
  - the throttle and the 30 s expiry;
  - pointer events pass through the layer.
- **Perf gate:** with 20 simulated participants moving, frame time stays within the existing perf
  harness budget ([ADR 0020](0020-engine-perf-harness-and-measurement-protocol.md)).
- **Docker-tier e2e:**
  - two browsers see each other's avatar, cursor and selection;
  - following switches page;
  - a viewer's edit controls are disabled.
