# Remote MCP + chat-header connector button

UI: no changes to original editor elements. Only the floating chat bubble is new outside the window. A small **+** is visible **inside** the expanded chat window header. Click opens provider groups:
- OpenAI: ChatGPT / Codex
- Anthropic: Claude / Claude Code
- Google: Gemini / Gemini CLI

Choose client -> client-specific setup -> external client initiates MCP OAuth -> Axoview-hosted authorization/consent -> client completes. A browser redirect cannot force a third-party app to install a connector. Offer copyable remote URL and setup instructions where direct installation links are unsupported. Keep grants separate for six clients.

Endpoints: `/api/mcp`, the public manual (below), and `/api/mcp/workspace`, a person's diagrams behind OAuth (next section).

## Workspace tools (live; `AI_MCP_ENABLED`)

[ADR 0059](../adr/0059-agent-sign-in-and-workspace-mcp.md). An agent works as its person after they approve it on Axoview's consent page. Clients are public (Claude, Claude Code, CLIs) or sign their token requests with a key they publish (`private_key_jwt`: ChatGPT; ADR 0059 addendum 2026-11-13). A proposal is announced live in the person's open Axoview tabs, naming the agent, and an approved change is announced to their other devices and to the people the diagram is shared with (ADR 0059 addendum 2026-11-13 (2)). The client discovers sign-in from the `401`'s `WWW-Authenticate` (`resource_metadata`) and Axoview's OAuth server (issuer `/api/oauth`: CIMD or DCR clients, PKCE S256, `resource` required).

| Tool | Scope | Returns |
|---|---|---|
| `list_diagrams` | `diagrams:read` | the person's diagrams and those shared with them: id, name, access (owner, admin, viewer), whether the agent may propose |
| `read_diagram` | `diagrams:read` | `id`, optional `page`: the page's description (items, icons, connections, groups, text) and the list of pages |
| `propose_changes` | `diagrams:propose` | `id`, optional `page`, 1-12 `operations` (the `diagramAgent` vocabulary), optional `note`: a pending proposal. Nothing changes until the person approves it in Axoview |
| `get_proposal` | `diagrams:read` | `id`, `proposal`: pending, approved (with how many steps were made) or rejected. Approved is reported only once the diagram holding the change is stored |

Without `diagrams:propose`, `propose_changes` answers `403` with `error="insufficient_scope"`. On a diagram shared with the person as Read only it is a tool error. Claude Code: `claude mcp add --transport http axoview <base>/api/mcp/workspace`, then `/mcp` to sign in.

Authorization: Cognito identifies the user, but existing SPA auth does not alone implement MCP OAuth requirements. Plan protected-resource metadata and authorization-server discovery, client registration compatibility, code/PKCE, consent, scopes/audiences, token expiry/revocation. CloudFront currently forwards /api/*; `/.well-known/*` needs explicit routing design. Require `diagrams:read`, `diagrams:search`, future `diagrams:write` plus fresh resource checks per tool. No anonymous workspace MCP. Validate every supported client independently in dev.

## Public manual tools (live; `AI_MCP_DOCS_ENABLED`)

`packages/axoview-backend/src/ai/mcp.js` serves the user manual to any MCP client with no sign-in, because everything it can reach is public: the manual sections this image ships. It cannot see diagrams, accounts or the assistant, and it does not call a model.

| Tool | Input | Returns |
|---|---|---|
| `search_manual` | `query` (1-300 characters, any language), `limit` 1-5 | sections with id, title, public URL (`/docs/manual/<page>.md#<section>`) and text, as text and `structuredContent` |
| `get_manual_section` | `id` | one section |

Both are annotated read-only, idempotent and closed-world.

**Protocol.** MCP 2026-07-28, stateless, JSON responses:
- `server/discover` is implemented.
- Per-request `_meta` must carry the protocol version and client capabilities.
- `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` (Base64 sentinel decoded) must match the body; a mismatch is `400` with `-32020`.
- An unsupported version is `400` with `-32022` listing the supported ones.
- An unknown method is `404` with `-32601`.
- `GET` and `DELETE` are `405`.

The server is dual-era: a legacy client (2025-11-25, 2025-06-18, 2025-03-26) that opens with `initialize` gets the same tools, and no session id is minted. The app's Origin allowlist applies (`403` for a foreign browser origin).

**Cost.** Each search embeds the query (Bedrock, Cohere) and queries S3 Vectors only while this pod's daily budget lasts (`AI_MCP_DAILY_VECTOR_LIMIT`, default 2,000); after that, search is keyword-only and free until UTC midnight. The query text is never logged. One `mcp.request` JSON line per request, errors included, records method, result, tool, outcome (hit, empty, invalid), result count, search mode and latency ([observability.md](observability.md)).

**Where.** The Express API (EKS, Docker). The Cloudflare Worker does not mount it.

Static copies for tools that read the web rather than speak MCP: `/llms.txt`, `/llms-full.txt` and `/docs/manual/*.md` (`scripts/build-public-docs.mjs`).
