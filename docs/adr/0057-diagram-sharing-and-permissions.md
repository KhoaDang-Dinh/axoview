# ADR 0057 — Diagram Sharing and Permissions

**Status:** Accepted: the email field and the three permission levels shipped (2026-11-10; see the
addenda below). Realtime co-editing waits for [ADR 0055](0055-multiplayer-operation-protocol.md)/[0056](0056-realtime-service-on-eks.md).
**Date:** 2026-11-09
**Supersedes:** none
**Superseded by:** none

## Context

**Today a diagram belongs to exactly one workspace, and a workspace is one person.** Server
storage derives the workspace from the signed-in user (`syncWorkspaceId`: `req.user.sub`, or
`_shared` without sign-in, in [`server.js`](../../packages/axoview-backend/server.js)). The AWS
adapter partitions everything under `WORKSPACE#<id>`.

Sharing exists in two forms that are not live collaboration:
- **Public links:** read-only snapshots behind a share UUID (`shareDiagram`,
  `GET /api/public/diagrams/:uuid`).
- **Drive-native sharing:** for diagrams stored in Google Drive
  ([ADR 0042](0042-drive-native-sharing-and-readonly-preview.md)).

Multiplayer ([ADR 0055](0055-multiplayer-operation-protocol.md),
[ADR 0056](0056-realtime-service-on-eks.md)) needs more than one person, and their agents, to
open and edit the same server diagram, with access checked on every request and every socket.

## Decision

1. **The diagram keeps its home; access is a list on the diagram.** A diagram stays stored under
   its owner's workspace partition, so there is no data migration. A membership list grants others
   access:
   ```
   PK WORKSPACE#<owner>  SK MEMBER#<diagramId>#<sub>   role, invitedBy, createdAt
   PK USER#<sub>         SK SHARED#<diagramId>         owner, role   (the "shared with me" index)
   ```
   Both items are written in one transaction when access is granted or changed. That's rare, so
   the doubled write cost is negligible.
2. **Three roles:**

   | Role | Read | Edit (ops) | Manage members | Delete |
   |---|---|---|---|---|
   | `owner` | yes | yes | yes | yes |
   | `editor` | yes | yes | no | no |
   | `viewer` | yes, live | no | no | no |

   There is exactly one owner, the workspace's user.
3. **One authorisation function, used everywhere.** `canAccess(sub, diagramId) → role | null`
   gates the REST routes (load, save, rename, export) and the realtime socket.
   - **Join and batches:** joining requires `viewer`; every batch requires `editor`.
   - **Changes take effect at once:** the realtime service applies access changes immediately.
     A downgraded participant's socket switches to read-only; a removed one is disconnected.
4. **Agents act for a person, never above them.** An agent participant carries the identity of the
   person who started it and a role no higher than that person's (an agent of a viewer is
   read-only). It has its own participant id and rate limits
   ([ADR 0052](0052-ai-assistant-boundaries.md) boundaries apply).
5. **Adding people: one email field under Share** (owner decision, 2026-11-09; a pet project, so
   the simplest flow).
   - **The field:** the owner types an email address in the share popover and presses Add.
   - **The lookup:** the backend finds the account with that email.
     - **If one exists**, that person becomes an `editor` at once, and the diagram appears in their
       "Shared with me" the next time their explorer lists diagrams (live, when their sync stream
       is open).
     - **If none does,** nothing is stored and no email is sent.
   - **Feedback is a pop-up message** (the app's notification toasts, `notificationStore` /
     `NotificationStack`):
     - **Green (`success`):** "Shared with <email>".
     - **Red (`error`):** for every failure:
       - "No Axoview account uses that email";
       - "Already shared with <email>";
       - "You can't share a diagram with yourself";
       - "Couldn't share: try again" (network or server error).

     The field keeps the typed email after a red message, so it can be corrected, and clears after
     a green one.
   - **No other invite machinery:** no pending invites, no invitation emails, no accept step.
   - **Managing access:** the field lists the current people, with a remove button each.
   - **Verified emails only:** only an account whose email is verified matches. Otherwise someone
     could register an unverified account with another person's address and receive what was meant
     for them. This is the same rule as account linking.
   - **Accepted trade-off:** the "no account" answer tells the owner whether an address has an
     account. That's acceptable for this project. Lookups are limited to signed-in owners and
     rate-limited (for example 20 a minute).
   - **Emails stay private:** an email is shown only to the owner who typed it, never to other
     members.
6. **Unchanged:**
   - **Public share links** stay anonymous and read-only.
   - **Drive diagrams** keep Drive-native sharing.
   - **Deployments without sign-in** (`_shared`): everyone is an editor of every diagram, as today.
7. **The REST surface:**
   - **Members:** `GET/PUT/DELETE /api/diagrams/:id/members` (owner only).
   - **Shared with me:** `GET /api/shared-with-me`.
   - **Diagram listings:** carry the caller's role, so the UI can mark shared diagrams and hide
     actions the role can't take.

## Consequences

**Positive:**
- **No migration:** existing diagrams and workspaces are untouched, and sharing is additive.
- **One choke point** for every access decision (REST and realtime).
- **Agents can never exceed the person behind them.**

**Negative / risks:**
- **"Shared with me" is a second index** that has to stay consistent with the membership list
  (hence the transaction).
- **Adding by email needs a lookup against Cognito** (find a user by verified email), so the backend
  needs a small privileged path for it. No email is ever sent.
- **The file explorer gains a second root** ("Shared with me"), a UX surface to design
  ([ADR 0058](0058-multiplayer-presence-ui.md) covers presence; the explorer change is a build
  dependency).

> TODO: whether ownership can be transferred, and whether team workspaces come later.

## Implementation notes (non-binding)

- **Where it lives:** `canAccess` in the backend routes layer. The adapters expose
  `getMembership(sub, diagramId)` and a "shared with me" listing.
- **The fs (Docker) adapter:** a `members.json` per diagram; deployments without sign-in skip it.
- **The share popover:** the server-storage share popover (`AppToolbar` share menu) gains the email
  field and the list of people below the existing link controls. A role picker can come later;
  everyone added is an `editor` for now.
- **The lookup:** Cognito `ListUsers` with an `email = "<address>"` filter, keeping only users whose
  `email_verified` is true. It runs in the backend with the pool's admin permission.

## Acceptance criteria

- **Unit tests:**
  - a role matrix covering every route and every socket message;
  - an agent of a viewer is read-only;
  - an email that belongs to no account, or to an unverified one, adds nobody and stores nothing;
  - adding the same person twice stores nothing new and answers "already shared" (red);
  - only the owner may add or remove.
- **Integration test:** removing an editor disconnects their open socket within one second, and
  their next REST save is refused.
- **Docker-tier e2e:**
  - the owner adds a second user by email under Share and gets a green "Shared with" message;
  - that user sees the diagram under "Shared with me" and edits live;
  - removing them takes it away;
  - an unknown email, and the same email added again, each show a red message.

## Addendum 2026-11-10: what shipped first

The owner asked for the email field under the share link, the green/red pop-ups and 1-second saves,
on today's storage and sync, ahead of the realtime service.

1. **Storage:** the membership list and the "shared with me" index live as two JSON objects in each
   side's own workspace (`sharing/members/<diagramId>` and `sharing/inbox`, through the storage
   adapter: S3 objects on AWS, files on fs), not as the DynamoDB items in §1. Every change is
   read-modify-write. Two owners sharing with one person in the same instant could drop one inbox
   entry; sharing again repairs it. The DynamoDB layout stays the target for the realtime phase.
2. **Access:** a request for `/api/diagrams/:id` from someone the diagram was shared with runs
   against the owner's workspace. Rename, move, trash, delete and the public link are owner-only
   (`403 owner-only`). Membership answers are cached for 10 s per API process, so a removal takes
   effect at once on the process that made it and within 10 s elsewhere.
3. **Live updates:** without the sequencer, editing stays whole-document with "latest save wins".
   Each save is published to the sync stream of everyone who has the diagram, and their open tab
   reloads it.
   - **Saves:** the app saves 1 s after the last edit (down from 2 s). A shared diagram uploads at
     once instead of batching.
   - **Measured:** a dropped icon reached the other person's open tab 1.8 s later, including the
     drag.
4. **Lookup:** Cognito `ListUsers` with an exact `email` filter, keeping verified, enabled
   accounts. The API role has `cognito-idp:ListUsers` on its own pool only (infra_website,
   `modules/identity/app_user_lookup.tf`).
5. **Not yet:** the realtime socket's access checks (§3), which come with ADR 0056. (The roles
   followed the same day: next addendum.)

## Addendum 2026-11-10 (2): three permission levels

The owner replaced §2's roles the same day:

| Level | Role | What it allows | Who may hold it |
|---|---|---|---|
| Read only | `viewer` | Opening it, in the existing read-only viewer (`/display/<id>`, the one the public link uses). Every write is refused. | people and agents |
| Change needs approval | `proposer` | Reading. Each save is stored as a proposal that the owner or a Full admin approves or rejects. | agents (the data model allows people too; the app offers it to agents only, to avoid a UI redesign for now) |
| Full admin | `admin` | Everything the owner can do: edit, rename, trash, delete, publish the link, add and remove people and change their levels. Only moving it between the owner's own folders stays with the owner. | people only |

- **Agents:** never Full admin, enforced on add and on every level change (§4's "never above their
  person" is still the rule for the person behind them).
- **The owner:** stays the owner. The diagram lives in their workspace and no one can remove them.
- **Proposals:**
  - **Storage:** kept in the owner's workspace (`sharing/proposals/<id>` and one document each).
  - **Approving:** saves the proposed document like any save, so everyone who has the diagram gets
    it.
  - **Stale proposals:** one made before the diagram last changed is marked stale. Approving it
    needs an explicit "Apply anyway" (`force`), because the whole document replaces those changes.
  - **In the app:** a "N to approve" chip in the toolbar opens Approve and Reject.
- **Agent accounts don't exist yet.** When they do, they are members with `kind: "agent"`. The API
  already enforces their levels, and the same proposal flow serves them.

