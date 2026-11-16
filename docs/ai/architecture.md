# AI architecture and implementation boundaries

Current source: React SPA under /app, static marketing /; `App.tsx` wraps `EditorShell` in `CognitoSessionProvider`, which replaces editor with sign-in. Backend Express `server.js` and framework-neutral `src/routes.js` (also Cloudflare Worker). Existing /api/sync/events is diagram synchronization SSE. Private diagrams use S3/DynamoDB and optimistic versions; server snapshots and Drive previews have distinct access paths.

Target:
```text
Chat bubble -> POST /api/ai/runs -> auth + authorized context -> Bedrock / RAG / tools
            <- GET /api/ai/runs/:id/events (SSE, independent of /api/sync/events)
External ChatGPT/Codex, Claude/Claude Code, Gemini/Gemini CLI
            -> remote Streamable HTTP /api/mcp -> OAuth -> same authorized tools
```

Place `AssistantProvider` outside the Cognito sign-in gate and canvas clipping context. Put **+** exclusively inside expanded chat header. Keep provider grouped visually: OpenAI, Anthropic, Google; do not merge authorization grants. No changes to original toolbar or other UI.

Create Node-specific AI modules under `packages/axoview-backend/src/ai/`, not framework-neutral routes.js. Direct current-diagram structured context first; add vector indexing only for large corpus and cross-diagram search. External MCP clients use their own models, not Axoview Bedrock inference.

Future API: POST /api/ai/guest/messages; POST /api/ai/runs; GET /api/ai/runs/:id; GET /api/ai/runs/:id/events; POST /api/ai/runs/:id/cancel; POST /api/ai/runs/:id/approve (write stage); POST /api/mcp (MCP stage). Run state/milestone events in DynamoDB; optional SQS worker for durable agents; object storage for large outputs. AI streams observe, not execute, work.

Phase 0 implements no AI API, MCP endpoint, OAuth server, model IAM, vector database or queue. Use additive expand/migrate/contract rollout and flag-off rollback.
