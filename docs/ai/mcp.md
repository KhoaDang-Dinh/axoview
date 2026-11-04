# Remote MCP + chat-header connector button

UI: no changes to original editor elements. Only the floating chat bubble is new outside the window. A small **+** is visible **inside** the expanded chat window header. Click opens provider groups:
- OpenAI: ChatGPT / Codex
- Anthropic: Claude / Claude Code
- Google: Gemini / Gemini CLI

Choose client -> client-specific setup -> external client initiates MCP OAuth -> Axoview-hosted authorization/consent -> client completes. A browser redirect cannot force a third-party app to install a connector. Offer copyable remote URL and setup instructions where direct installation links are unsupported. Keep grants separate for six clients.

Endpoint: `/api/mcp`. **Live today: the public manual only** (below). Workspace tools come later behind OAuth; read-only first: list_diagrams, get_diagram, inspect_topology, get_shared_diagram, get_diagram_version. Later search_diagrams and approval-gated writes.

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

**Cost.** Each search embeds the query (Bedrock, Cohere) and queries S3 Vectors only while this pod's daily budget lasts (`AI_MCP_DAILY_VECTOR_LIMIT`, default 2,000); after that, search is keyword-only and free until UTC midnight. The query text is never logged. One `mcp.request` JSON line records method, tool, result count, search mode and latency.

**Where.** The Express API (EKS, Docker). The Cloudflare Worker does not mount it.

Static copies for tools that read the web rather than speak MCP: `/llms.txt`, `/llms-full.txt` and `/docs/manual/*.md` (`scripts/build-public-docs.mjs`).
