# Remote MCP + chat-header connector button

UI: no changes to original editor elements. Only the floating chat bubble is new outside the window. A small **+** is visible **inside** the expanded chat window header. Click opens provider groups:
- OpenAI: ChatGPT / Codex
- Anthropic: Claude / Claude Code
- Google: Gemini / Gemini CLI

Choose client -> client-specific setup -> external client initiates MCP OAuth -> Axoview-hosted authorization/consent -> client completes. A browser redirect cannot force a third-party app to install a connector. Offer copyable remote URL and setup instructions where direct installation links are unsupported. Keep grants separate for six clients.

Proposed URL: https://axoview.app/api/mcp (NOT ACTIVE). Use official SDK Streamable HTTP. Read-only tools first: list_diagrams, get_diagram, inspect_topology, get_shared_diagram, get_diagram_version. Later search_diagrams and approval-gated writes.

Authorization: Cognito identifies the user, but existing SPA auth does not alone implement MCP OAuth requirements. Plan protected-resource metadata and authorization-server discovery, client registration compatibility, code/PKCE, consent, scopes/audiences, token expiry/revocation. CloudFront currently forwards /api/*; `/.well-known/*` needs explicit routing design. Require `diagrams:read`, `diagrams:search`, future `diagrams:write` plus fresh resource checks per tool. No anonymous workspace MCP. Validate every supported client independently in dev.
