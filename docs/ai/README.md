# Axoview AI — Phase 0 design baseline (2026-10-29)

Status: planned, not deployed. AI is disabled by default. No current UI or data behavior changes.

## Goal
Add a draggable AI bubble on /app, with chat overlay, down-arrow minimize, and a **+** in the chat header only. Existing toolbar, account menu, canvas and file explorer remain unchanged. Guest login screen, authenticated editor, and read-only views must be supported. The static marketing root / is a separate build target.

## Implementation gates
| Stage | Deliverable | Release gate |
|---|---|---|
| 0 | Contracts, disabled capability config, infrastructure safety plan | Old editor unchanged; config tests pass |
| 1 | Mock chat UI, bubble, + menu | Drag/click/keyboard/mobile; guest, login, public share E2E |
| 2 | Bedrock general chat, quotas, history | User isolation, guest abuse limits |
| 3 | HTTP run commands, SSE and durable status | Reconnection, idempotency, cancellation |
| 4 | Diagram context | Authorized owner and exact shared snapshot; no leakage |
| 5 | Remote MCP + OAuth | External client compatibility, read-only, revoke |
| 6 | Public docs and private RAG | Current ACL recheck after retrieval |
| 7 | Agent tools, approval-gated writes | Proposal/version bound approvals; denied in view-only |
| 8 | Canary production rollout | Security, cost, rollback and load gates |

## Contracts
- [Architecture](architecture.md)
- [Authorization](authorization.md)
- [Events/SSE](events.md)
- [MCP](mcp.md)
- [Release tests](testing.md)

`GET /api/config` publishes `ai` with chatEnabled, guestEnabled, diagramContextEnabled, mcpEnabled, ragEnabled, agentWriteEnabled; all default **false** and require exact server-side string `true` to enable. These advertise UI capabilities only: every future AI route must separately enforce flags and permissions.

Owners: `axoview` = UI, Express AI API, diagram tools, MCP, tests; `infra_website` = Bedrock IAM, OAuth edge routing, vector/worker resources, alerts, GitOps promotion. No AI service is active at Phase 0.

## Stage 1 mock UI implementation (2026-10-29)

React `AssistantProvider` is mounted outside the Cognito sign-in gate. `AssistantWidget` renders a portal into document.body, outside the canvas clipping stack. A draggable 56px bubble opens a mock chat; minimize returns to the bubble. Its + menu groups the three providers and six clients. `/app/ai/connect/:clientId` is an informational setup page, not an OAuth permission grant. Chat messages stay in-memory and reset on identity change. No requests reach models.

Dev demo: configure `AI_CHAT_ENABLED=true` and `AI_GUEST_ENABLED=true` locally on the **backend serving /api/config**, then restart it and refresh /app. These flags are **disabled by default in production**; they expose the mock shell only. The setup page remains informative. Do not enable without verifying the guest/login/share UI.
