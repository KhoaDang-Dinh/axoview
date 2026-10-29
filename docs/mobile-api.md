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
device saved first. The web app resolves it as "latest save wins": it reloads
the version (`GET`) and saves again. Do the same, or offer the user the choice.

## 4. Realtime sync

```http
GET /api/sync/events
Authorization: Bearer <access token>
Accept: text/event-stream
Last-Event-ID: <last id received, when reconnecting>
```

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

- Ignore changes whose `origin` is your own device id.
- The server pings every 15 s and ends each stream after about 5 minutes.
  Reconnect with `Last-Event-ID`; also after 45 s of silence.
- Close the stream while the app is in the background, and treat returning to
  the foreground as a `resync`.
- React Native's built-in `fetch` cannot read a streaming body. Use
  `expo/fetch` (streaming), or `react-native-sse`, which supports the
  `Authorization` header.
