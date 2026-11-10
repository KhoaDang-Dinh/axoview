# Mobile app API

How a mobile app (React Native / Expo) signs in and uses the Axoview API. The
mobile app uses the same API, user pool and workspace as the web app: a person
sees the same diagrams on both, and realtime sync works across them.

The infrastructure side (the Cognito client, its redirect scheme, the build
settings) lives in `infra_website`, `docs/mobile-app.md`.

## 1. Discover the configuration

The app only needs the site's base URL (`https://<domain>`; dev:
`https://dev.<domain>`). Everything else comes from the public config endpoint:

```http
GET /api/config
```

```json
{
  "authMode": "cognito",
  "serverStorage": true,
  "sharing": true,
  "publicBaseUrl": "https://example.com",
  "cognito": {
    "domain": "https://axoview-prod-123456789012.auth.ap-southeast-1.amazoncognito.com",
    "clientId": "<web client: not for the app>",
    "providers": ["Google"],
    "mobile": {
      "clientId": "<mobile client id>",
      "redirectUri": "axoview://auth/callback",
      "logoutUri": "axoview://auth/logout"
    }
  }
}
```

- `authMode` other than `cognito`, or `cognito.mobile` null: the deployment has
  no mobile sign-in. Show the app as unavailable rather than falling back.
- Use `cognito.mobile.clientId`, never `cognito.clientId` (that one only allows
  the web redirect).
- `providers`: one "Continue with …" button each, besides email.

## 2. Sign in (authorization code + PKCE)

Cognito's hosted sign-in in the system browser, returning to the app's custom
scheme. The mobile client is public (no secret) and only allows the code flow
with PKCE.

| | |
|---|---|
| Authorization endpoint | `{domain}/oauth2/authorize` |
| Token endpoint | `{domain}/oauth2/token` |
| Revocation endpoint | `{domain}/oauth2/revoke` |
| Scopes | `openid email profile` |
| Redirect | `cognito.mobile.redirectUri` (`axoview://auth/callback`; dev builds `axoview-dev://auth/callback`) |

With `expo-auth-session`:

```ts
import * as AuthSession from 'expo-auth-session';

const discovery = {
  authorizationEndpoint: `${cognito.domain}/oauth2/authorize`,
  tokenEndpoint: `${cognito.domain}/oauth2/token`,
  revocationEndpoint: `${cognito.domain}/oauth2/revoke`,
};

const request = new AuthSession.AuthRequest({
  clientId: cognito.mobile.clientId,
  redirectUri: cognito.mobile.redirectUri,
  scopes: ['openid', 'email', 'profile'],
  usePKCE: true,
  // Optional: straight to Google instead of Cognito's page.
  extraParams: provider ? { identity_provider: provider } : undefined,
});

const result = await request.promptAsync(discovery);
if (result.type === 'success') {
  const tokens = await AuthSession.exchangeCodeAsync(
    {
      clientId: cognito.mobile.clientId,
      code: result.params.code,
      redirectUri: cognito.mobile.redirectUri,
      extraParams: { code_verifier: request.codeVerifier! },
    },
    discovery,
  );
  // tokens.accessToken (60 min), tokens.refreshToken (90 days)
}
```

The first Google sign-in for an email that already has an email account can
fail once with "Already found an entry for username" (Cognito links the two
accounts on that attempt). Start the same sign-in again once; the web app does
the same.

**Do not** call `/api/auth/callback`, `/api/auth/refresh` or `/api/auth/logout`.
They are the web app's cookie-based flow and only accept the web client.

### Tokens

- Keep the refresh token in the platform's secure storage (`expo-secure-store`:
  Keychain / Keystore), never in AsyncStorage.
- Keep the access token in memory. It lasts 60 minutes.
- Refresh before expiry, or after a `401`:

  ```http
  POST {domain}/oauth2/token
  Content-Type: application/x-www-form-urlencoded

  grant_type=refresh_token&client_id=<mobile client id>&refresh_token=<token>
  ```

  A failed refresh (`invalid_grant`) means the session ended: sign in again.

### Sign out

1. `POST {domain}/oauth2/revoke` with `token=<refresh token>&client_id=<mobile client id>`.
2. Delete the stored tokens.
3. Optional: open `{domain}/logout?client_id=<mobile client id>&logout_uri=<cognito.mobile.logoutUri>`
   to also end the hosted sign-in session, so the next sign-in asks again.

## 3. Calling the API

Every request under `/api/` except `/api/config`, `/api/public/*` and the web
auth routes needs:

```http
Authorization: Bearer <access token>
```

On writes (POST, PUT, PATCH, DELETE), also send:

```http
X-Axoview-Device: <this install's id>
```

Use a random id per install, 8–64 characters of `A-Z a-z 0-9 _ -`, kept in
storage. The realtime sync stream tags each change with it, so the app can
ignore its own changes.

- Bodies are JSON, up to 10 MB.
- Errors are JSON: `{ "error": "<message>", "code": "<CODE>" }` (`code` only on
  some).
- No `Origin` header is needed. Native requests have none, and the API accepts
  that.

| Status | Meaning | Do |
|---|---|---|
| 401 | Missing, expired or invalid access token | Refresh once and retry; if that fails, sign in |
| 404 | Not found (deleted on another device) | Drop it locally |
| 409 `VERSION_CONFLICT` | Saved since you loaded it | See "Versions" |
| 428 `IF_MATCH_REQUIRED` | Saved without `If-Match` | Load it first (to get the ETag) |
| 413 | Body over 10 MB | — |
| 503 | Storage off, or the pod is shutting down (`Retry-After`) | Retry after a second |

### Endpoints

Diagrams:

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/diagrams` | — | `[{ id, name, lastModified, folderId, deletedAt, version }]` (all, including trashed: `deletedAt` set) |
| `GET /api/diagrams/{id}` | — | the diagram document; header `ETag: "<version>"` |
| `POST /api/diagrams` | diagram document, optional `folderId` | `201 { success, id }`; `ETag` |
| `PUT /api/diagrams/{id}` | whole diagram document; header `If-Match: "<version>"` | `{ success, id }`; new `ETag` |
| `PATCH /api/diagrams/{id}` | `{ "name": "…" }` to rename; `{ "deletedAt": "<ISO time>" }` to trash; `{ "deletedAt": null }` to restore | `{ success }` |
| `PATCH /api/diagrams/{id}/move` | `{ "targetFolderId": "<id>" \| null }` | `{ success }` |
| `DELETE /api/diagrams/{id}` | — | `{ success }` (permanent; also removes its share link) |

Folders and layout:

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/folders` | optional `?parentId=` | `[{ id, name, parentId }]` |
| `POST /api/folders` | `{ name, parentId? }` | `201 { success, id }` |
| `PUT /api/folders/{id}` | `{ name }` | `{ success }` |
| `PATCH /api/folders/{id}/move` | `{ targetFolderId }` | `{ success }` |
| `DELETE /api/folders/{id}` | — | `{ success }` |
| `GET /api/tree-manifest` / `PUT` | the file tree's ordering | `{ folders: [...] }` / `{ success }` |

Sharing:

| Method and path | Answer |
|---|---|
| `POST /api/diagrams/{id}/share` | `{ uuid, url, sharedAt }`: a read-only public snapshot |
| `DELETE /api/diagrams/{id}/share` | `{ success }` |
| `GET /api/public/diagrams/{uuid}` | the snapshot (no sign-in) |

People a diagram is shared with ([ADR 0057](adr/0057-diagram-sharing-and-permissions.md); only when
`/api/config` says `"sharing": true`; for the owner and Full admins, anyone else gets `404`):

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/diagrams/{id}/members` | — | `{ members: [{ sub, email, role, addedAt }] }` |
| `POST /api/diagrams/{id}/members` | `{ "email": "…", "role": "viewer" \| "admin" }` (default `viewer`) | `201 { member }`; or an error with a `reason`: `no-account` (404), `already-shared` (409), `self` (422), `invalid-email` / `invalid-role` (400), `rate-limited` (429, over 20 a minute) |
| `PATCH /api/diagrams/{id}/members/{sub}` | `{ "role": "viewer" \| "admin" }` | `{ member }` |
| `DELETE /api/diagrams/{id}/members/{sub}` | — | `{ removed }` |

Permission levels (`role`), for people only:

| Level | `role` | May |
|---|---|---|
| Read only | `viewer` | load it (the web app opens it in the read-only viewer); every write is `403 view-only` |
| Full admin | `admin` | everything the owner can, except moving it between the owner's folders (`403 owner-folders`) |

- **Who can be added:** by email, an account whose email is verified.
- **On their side:** a diagram shared with someone appears in their `GET /api/diagrams` with
  `shared: { role, ownerEmail }`, and is loaded at its usual `/api/diagrams/{id}`.
- **Live:**
  - adding, changing or removing a person sends a `diagram` `create`, `update` or `delete` change to
    their sync stream;
  - every save goes to everyone who has the diagram.
- **Headers:** `GET`/`PUT /api/diagrams/{id}` on a diagram other people have answers
  `X-Axoview-Shared: by-you | with-you` and `X-Axoview-Role: owner | viewer | admin`.
  The web app then uploads each save at once instead of batching.

AI agents are not members: an agent works on its person's account, and that person sets once what
it may do (ADR 0057 addendum 3; any signed-in account, server storage):

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/agent` | — | `{ level: "viewer" \| "proposer" }`; `viewer` (Read only) until set |
| `PUT /api/agent` | `{ "level": "viewer" \| "proposer" }` | `{ level }`; `invalid-level` (400) for anything else |

On a diagram the person may only view, the agent is Read only whatever the level says.

Changes an agent made through the API under "Changes need my approval" wait for its person alone,
while they may change the diagram (owner or Full admin; anyone else gets `404`). Nothing makes them
yet: they arrive with outside agents' MCP sign-in (ADR 0052).

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/diagrams/{id}/proposals` | — | `{ proposals: [{ id, by: { sub, agent }, createdAt, summary, stale }] }`: this person's agents' waiting ones |
| `POST /api/diagrams/{id}/proposals/{pid}/approve` | `{ "force": true }` to approve a stale one | `{ proposal }`: the document is saved like any save; `409 stale` when the diagram changed since |
| `POST /api/diagrams/{id}/proposals/{pid}/reject` | — | `{ proposal }` |

Deciding one sends `kind: "proposal"` to that person's sync stream.

### The diagram document

The same JSON the web editor saves: `title`, `items`, `views`, `icons`,
`colors`, `requiredPacks`, plus server fields (`id`, `created`,
`lastModified`, `folderId`, `name`). A mobile app that only shows diagrams can
read it as is. **An app that edits must round-trip every field it does not
understand**: a `PUT` replaces the whole document, so a dropped field is
deleted for the web app too.

### Versions

Each diagram has a version, sent as `ETag: "<n>"` on `GET`, `POST` and `PUT`.
Save with `If-Match: "<n>"` from the last load or save. On `409`, another
device saved first; the body's `currentVersion`, when present, is the version
to save against. The web app resolves it as "latest save wins": it saves again
against that version (re-reading it with `GET` only when the 409 does not name
it). Do the same, or offer the user the choice. A rename, trash or restore
(`PATCH`) also returns the new version.

Write responses carry the document's `lastModified`, and a `PUT` whose content
equals what is stored answers `{ "unchanged": true }`: nothing is written and
no other device is told.

## 4. Realtime sync

```http
GET /api/sync/events
Authorization: Bearer <access token>
Accept: text/event-stream
Last-Event-ID: <last id received, when reconnecting>
X-Axoview-Device: <this install's id>
X-Axoview-Browser: <this install's id>
```

The two ids are optional. With both, the stream announces this app as
present (ADR 0053); use the same id for both on a phone.

A Server-Sent Events stream of every change to the workspace, from any device:

```text
event: ready
id: 41
data: {"seq":41}

event: change
id: 42
data: {"seq":42,"kind":"diagram","action":"save","id":"diagram_…","version":7,"origin":"<device id>","at":"…"}

: ping
```

| `kind` / `action` | Do |
|---|---|
| `diagram` `save` | if that diagram is open and `version` is newer than yours, reload it (unless the user is editing it) |
| `diagram` `create` / `move` / `delete`, `update` with `name` or `deleted` | refresh the list |
| `folder` *, `tree` | refresh the folder tree |
| `resync` | changes were missed: refresh everything shown |
| `presence` `join` / `renew` / `here` / `leave` | another app has the workspace open (`origin`, `browser`); nothing to refresh |

- Every change arrives, in order. A stream that is a few changes behind (several
  saves inside one poll, a reconnect with `Last-Event-ID`) is sent each of them
  from the server's change queue, kept for an hour, up to 100 changes. Only
  further behind than that, or ahead of the server, is it sent one `resync`.
- If the open diagram is deleted, or moved to the trash, close it: you get
  `delete`, or `update` with `deleted: true`.
- Ignore changes whose `origin` is your own device id. Make the id unique per
  app instance (the web app makes one per page load, so a duplicated tab gets
  its own).
- The server pings every 15 s and ends each stream after about 5 minutes.
  Reconnect with `Last-Event-ID`; also after 45 s of silence.
- Close the stream while the app is in the background, and treat returning to
  the foreground as a `resync`.
- Presence: while another browser or app is present, the web app uploads each
  edit within about 2 s; alone, it uploads at most every 30 s (ADR 0054). An app
  that shows a diagram live should therefore keep its stream open with both ids,
  so editors know it is watching.
- React Native's built-in `fetch` cannot read a streaming body. Use
  `expo/fetch` (streaming), or `react-native-sse`, which supports the
  `Authorization` header.
