# AI observability: the log contract CloudWatch reads

The API writes one JSON line per AI event to stdout. Container Insights ships
it to `/aws/containerinsights/<cluster>/application`, where the infra repo turns
it into metrics, alarms and a dashboard section
(`infra_website/modules/observability/logging.tf`, `alarms.tf`, `dashboard.tf`).
Metric filters match **words**, so the values below are a closed vocabulary:
renaming one silently zeroes a metric. Change them here and in the infra
filters together.

No line ever carries a prompt, an answer, a page description, a suggested edit,
a search query, a Cognito subject or a client address. Numbers are clamped and
names outside the vocabulary collapse to `other`, so a caller cannot write into
the log.

| Event | Written by | One line per | Fields |
|---|---|---|---|
| `ai.request` | `src/ai/observability.js` `emitAiTelemetry` | chat message, at its end | `stage` (input, retrieval, model, output, quota, storage, completed), `result` (ok, blocked, rejected, error), `latencyMs`, `inputTokens`, `outputTokens`, `retrievedDocuments` |
| `ai.agent` | `emitAgentTelemetry` | **agent turn**: a chat message sent with a diagram page, where the model may propose edits | `outcome` (below), `suggestions` (valid edits returned, max 8), `dropped` (proposed edits that failed validation), `sources` (manual sections cited), `latencyMs` |
| `mcp.request` | `emitMcpTelemetry` | MCP request (`/api/mcp`), errors included | `method` (server/discover, initialize, ping, tools/list, tools/call, other), `result` (ok, rejected = 4xx, error = 5xx), `code` (JSON-RPC error code); for a successful `tools/call`: `tool`, `outcome` (below), `results`, `mode` (hybrid, keyword) |

`ai.agent` outcome:
- `suggested`: at least one valid suggestion reached the user's checklist.
- `malformed`: the model proposed edits and every one failed the contract (`suggestions.js`). A rising share is the agent's quality alarm: a model or prompt change broke the operation format.
- `none`: an answer without edits (for example "the page looks complete").

`mcp.request` outcome (`tools/call`):
- `hit`: results returned.
- `empty`: the search found nothing. Agents asking what the manual does not cover show up here.
- `invalid`: the tool answered with an error the model can recover from (for example an unknown section id). Not `error`: filters match words, and in an `mcp.request` line `error` means a failed request (5xx) only.

What the browser does with a suggestion (applied or skipped) is not logged:
the checklist runs in the app, and nothing reaches the API.
