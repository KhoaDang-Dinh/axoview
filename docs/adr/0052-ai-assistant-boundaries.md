# ADR 0052 — Additive AI assistant and MCP access

Status: Accepted design baseline (2026-10-29); implementation is gated.

Axoview retains existing toolbar, canvas, explorer, sharing and Cognito. Add only a draggable AI bubble, expandable chat, down-arrow minimize, and a small **+ inside chat header**. Mount outside Cognito sign-in gate and canvas clipping. Guest, signed-in and view-only contexts have independent, server-enforced permissions. A logged-in viewer is still read-only.

Built-in Bedrock and external remote MCP use shared authorized diagram services, but external ChatGPT/Codex, Claude/Claude Code and Gemini/Gemini CLI operate their own models. Group UI choices by OpenAI, Anthropic, Google; grants are **per client**, never automatically shared.

Keep /api/sync/events diagram-change SSE separate from agent activity SSE. HTTP commands create/cancel/approve runs; SSE observes durable state. Direct current-diagram analysis precedes RAG; read-only MCP precedes approval/version-gated writes.

All Phase 0 feature flags are false by default. No AI UI, model invocation, MCP endpoint, OAuth server, vector index, SQS or AWS resource is deployed. Existing SPA Cognito auth is not full MCP OAuth; plan separate OAuth metadata, consent and CloudFront discovery routing in Stage 5. The static / landing page is distinct from /app.

Rationale: additive delivery, strong share isolation, limited costs, flag rollback and compatibility with GitOps and canary.

Details: [AI implementation contracts](../ai/README.md).
