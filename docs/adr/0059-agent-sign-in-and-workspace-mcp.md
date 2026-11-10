# ADR 0059 — Agent Sign-in and the Workspace MCP Server

**Status:** Accepted
**Date:** 2026-11-10
**Supersedes:** none
**Superseded by:** none

## Context

The owner decided on 2026-11-10 that an AI agent has no account of its own. It works on its person's
account, and that person is its one admin ([ADR 0057 addendum 3](0057-diagram-sharing-and-permissions.md)).
The in-app assistant already follows this: its person approves each suggested step in the chat
([ADR 0052 addendum 2026-11-10](0052-ai-assistant-boundaries.md)).

Outside agents had no way in. [ADR 0052](0052-ai-assistant-boundaries.md) planned remote MCP behind
OAuth: grants per client, never shared, and approval-gated writes. Only the public manual was served
(`/api/mcp`, [docs/ai/mcp.md](../ai/mcp.md)).

The owner chose the scope:
- **Tools:** read and propose; no direct writes.
- **Sign-in:** full MCP OAuth, so ChatGPT and Claude connectors work as well as CLIs.
- **First client to validate:** Claude Code.

The MCP authorization spec (2026-07-28) sets the shape. Clients identify themselves with Client ID
Metadata Documents (CIMD) or, deprecated, Dynamic Client Registration (DCR). PKCE uses S256. Tokens
are bound to the resource (RFC 8707). Responses carry `iss` (RFC 9207). Discovery goes through
protected resource metadata (RFC 9728) and authorization server metadata (RFC 8414).

Cognito cannot be that authorization server: it has no CIMD, no DCR and no resource indicators.

## Decision

1. **Axoview is the authorization server**, issuer `<base>/api/oauth`
   ([oauth/router.js](../../packages/axoview-backend/src/oauth/router.js)).
   - **The person:** signs in with their usual Cognito session and approves the client on a consent
     page in the app (`/app/oauth/consent?request=<id>`).
   - **Endpoints:** `authorize`, `token` (`authorization_code` with PKCE S256; `refresh_token`,
     rotated on every use), `register` (DCR, public clients only, 30 an hour per IP) and `revoke`.
   - **Discovery:** the metadata is served at all three discovery URLs, and advertises
     `client_id_metadata_document_supported` and `authorization_response_iss_parameter_supported`.
2. **Clients** ([oauth/clientMetadata.js](../../packages/axoview-backend/src/oauth/clientMetadata.js)):
   - **Metadata document (CIMD):** a `client_id` that is an https URL with a path is fetched inside
     an SSRF fence and cached for its max-age, between 1 minute and 1 day. The fence: https on port
     443, no IP literals, and every resolved address checked at connect time (no private, loopback,
     link-local, CGNAT or multicast address). No redirects, 5 s, 16 KB.
   - **DCR:** registered clients get `dcr_<hex>` ids.
   - **Redirect URIs:** https, or http on a loopback address. They are matched exactly, except that a
     loopback redirect may use any port (RFC 8252). Nothing redirects before the client and its
     redirect URI check out.
3. **What the client may do is a grant per person and client.** A grant records the scopes the
   person allowed (`diagrams:read` always; `diagrams:propose` if they leave it ticked), the client's
   name and where it signs in from.
   - **Managing grants:** in the assistant, under + → Connected apps
     (`GET`/`PATCH`/`DELETE /api/oauth/grants`).
   - **Tokens follow their grant:** a token works only while its grant exists, so Disconnect ends
     every token the client holds. Narrowing a grant narrows its tokens within 10 s.
4. **Tokens are opaque and stored hashed.** Access tokens last 1 hour, refresh tokens 30 days, codes
   2 minutes and are used once; a consent request lasts 10 minutes.
   - **Storage:** small JSON objects in one system workspace (`_oauth`), through the storage adapter,
     so every API pod sees the same state with no new AWS resource
     ([oauth/store.js](../../packages/axoview-backend/src/oauth/store.js)).
   - **Audience:** each token is bound to the workspace MCP resource, and a token for any other
     resource is refused. A Cognito session is never accepted as an MCP token.
5. **The workspace MCP server** is `POST /api/mcp/workspace`, stateless and dual-era like the manual
   server; both share [ai/mcpProtocol.js](../../packages/axoview-backend/src/ai/mcpProtocol.js).
   Without a valid token it answers `401` with `WWW-Authenticate: Bearer resource_metadata=…, scope=…`.
   Its tools ([ai/workspaceMcp.js](../../packages/axoview-backend/src/ai/workspaceMcp.js)):

   | Tool | Does |
   |---|---|
   | `list_diagrams` | The person's diagrams and those shared with them, with their access and whether the agent may propose |
   | `read_diagram` | One page through `describeDiagram`: names, icons, connections, groups and text; never tiles, styling, links or notes |
   | `propose_changes` | Up to 12 operations (the `diagramAgent` vocabulary), stored as a proposal for the person |
   | `get_proposal` | Pending, approved (and how many steps were made) or rejected |

   - **Content:** every tool result labels diagram content as user-authored data, never
     instructions.
   - **The page description:** the API's `describeDiagram` is a dependency-free copy of axoview-lib's.
     [`__fixtures__/describe.contract.json`](../../packages/axoview-backend/src/ai/__fixtures__/describe.contract.json)
     is asserted by both test suites, the same pattern as the suggestion contract.
6. **Never above the person.**
   - **Without the `diagrams:propose` scope:** proposing answers `403 insufficient_scope`, checked
     before any diagram is looked up.
   - **On a diagram shared with the person as Read only:** proposing is refused.
   - **What it reads:** an agent reads only what its person can open.
7. **A proposal holds operations, not a document.** It waits for its person alone, in the owner's
   workspace with `by: { sub, agent }`, at most 20 waiting per person and diagram. On the open
   diagram the person sees "N to approve".
   - **Checked against the page as it is now:** a step that no longer fits says why.
   - **Approve:** carries out the steps that fit through the editor, as one undoable change saved
     like any edit (the in-chat path, ADR 0052 addendum 2026-11-10). It then records the decision
     with the number of steps made.
   - **Overwriting:** approving can never overwrite changes made since the proposal. This replaces
     ADR 0057 addendum 2's whole-document proposals and their "Apply anyway".
8. **Off unless `AI_MCP_ENABLED` is true and sharing is available** (accounts and server storage).
   The infra switch is `AI_AGENTS`: on for dev and off for prod by default. CloudFront and the
   Docker image's nginx send `/.well-known/oauth-*` and `/.well-known/openid-configuration/*` to
   the API.

## Consequences

**Positive:**
- **Clients:** any spec-following MCP client can connect. The official TypeScript SDK (1.32) went
  the whole way against the real server: DCR, consent, token, tools, proposal, approval and a
  step-up on `403`.
- **Approvals:** one path for every agent, the in-app assistant and outside ones alike. The person
  approves, the editor makes the change, Undo takes it back, and the save carries their own rights.
- **Infrastructure:** no new AWS resources and no secrets to rotate, because the tokens are opaque.

**Negative / risks:**
- **Self-registration:** DCR clients name themselves. The consent page says it cannot confirm who
  made them, and shows where the browser goes back to, with a warning for an app on the same
  computer.
- **Storage reads:** every MCP call reads its token and grant from storage (the grant is cached for
  10 s). That is fine at this scale; a busy deployment would want a cache in front.
- **Leftovers:** expired requests, codes and tokens are deleted only when next read. Never-read
  leftovers stay in the bucket until a sweep is written.
- **Approving needs the diagram open:** proposals wait until the person opens it.

## Implementation notes (non-binding)

- **Global auth gate:** the routes that skip it are `OAUTH_PUBLIC_PATHS` in `server.js`. The
  consent and grants calls keep the Cognito session.
- **App:** `components/ai/AgentConsentPage.tsx` (sign-in returns to it through `RETURN_PATH`),
  `components/ai/ConnectedApps.tsx`, `components/ProposalPrompt.tsx` and `services/agentConnections.ts`.
- **Tests:** `server.agents.spec.js` (real server and the whole flow), `oauth/__tests__/clientMetadata.spec.js`,
  `describeDiagram.spec.js` (contract), `ProposalPrompt.test.tsx`, `AgentConsentPage.test.tsx`
  and the e2e `share-people.spec.ts`.

## Acceptance criteria

- **Unit tests:**
  - CIMD validation and the SSRF address fence;
  - loopback any-port redirect matching;
  - PKCE;
  - the resource match;
  - the describe contract against both describers.
- **Server tests:**
  - discovery at every URL;
  - consent, then token, `list`, `read` and `propose`, then the person approving and `get_proposal`
    showing it;
  - a read-only grant and a Read only diagram are both refused;
  - an unregistered redirect is shown an error, not followed;
  - a wrong resource is `invalid_target`;
  - refresh rotation;
  - a narrowed grant gives `403` and a disconnect gives `401`;
  - a Cognito token is refused;
  - everything is `404` with `AI_MCP_ENABLED` off.
- **Manual verification:**
  - the official MCP SDK client and a real browser go through consent, propose four steps (one
    not applicable), see "Approve the 3 that fit" and approve;
  - the saved diagram gains the item and two connectors;
  - `get_proposal` reports "3 of 4".
