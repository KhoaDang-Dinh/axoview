# AI SSE and run contract (not yet implemented)

Commands: POST /api/ai/runs (idempotency key) returns 202 with runId; GET /api/ai/runs/:id returns durable snapshot; GET /api/ai/runs/:id/events provides text/event-stream; POST cancel and future approve are separately authorized commands.

Event examples:
```text
id: 41
event: tool.completed
data: {"runId":"r123","seq":41,"tool":"inspect_topology"}
id: 42
event: approval.required
data: {"runId":"r123","seq":42,"proposalId":"p456"}
```
Event types: run.started, run.queued, context.loaded, retrieval.started/completed, tool.started/completed/failed, message.delta/completed, approval.required, run.paused/resumed/completed/failed/cancelled. Persist milestone state and final messages; token deltas can be ephemeral. Sequence per run, replay with Last-Event-ID, deduplicate at least-once events, provide snapshot fallback when history compacted.

Use authenticated fetch streaming (Cognito bearer) consistent with existing realtimeSync.ts, but **never overload** /api/sync/events. Scope SSE subscription to principal or narrow run capability. Heartbeat and test proxy buffering, CloudFront/ALB idle limits, backpressure, disconnect/restart, rolling EKS deployments and terminal-state recovery. Long waiting approvals persist paused state, release worker. MCP Streamable HTTP is independent from app-specific event stream.
