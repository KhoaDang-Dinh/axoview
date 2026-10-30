# Phase 2 — Bedrock Nova authenticated chat

Status: feature branch, not a production release. This slice implements ordinary synchronous general chat only. No diagram read, RAG, external MCP OAuth, agent tools, SSE, or write operations.

## Endpoint
- POST /api/ai/messages with `{ message, conversationId? }` -> `{ conversationId, reply, usage, requestsRemainingToday }`
- GET /api/ai/conversations -> up to 30 recent chat summaries
- GET /api/ai/conversations/:id -> bounded recent transcript

Every route requires a **verified Cognito access token** (global Express auth middleware and req.user.sub), even if AUTH_MODE=none would otherwise make the rest of Axoview accessible. Guest inference is deliberately unavailable, regardless of AI_GUEST_ENABLED. Existing Phase 1 guest preview remains mock-only. Do not enable AI_GUEST_ENABLED in production.

Storage: reuse the environment's PAY_PER_REQUEST DynamoDB table, partitioned as AI#USER#<verified Cognito sub> (CHAT#<uuid>) and quota rows AI#QUOTA#<sub>, AI#QUOTA#GLOBAL. Conditional updates reserve 1 user and global request per response, before invoking a model. Daily caps default to 20/user and 250/global. Reservations are conservative (a model/service failure can consume quota). TTL 30 days; DynamoDB TTL is eventual, so query results older than expiry need a later hard-deletion plan. Current chat is truncated to 12 latest user/assistant messages (history is **not** a complete transcript archive). No request-body logging.

Region is configured separately (`AI_BEDROCK_REGION` or AWS_REGION); only approved `amazon.nova-*-v1:0` model IDs. Inference maxTokens=384; model response text truncated at 6,000 characters; prompts capped at 2,000 characters. Signed Converse requests via existing AWS SDK v3 credential chain. The IAM grant is not added by default.

## Deployment order
1. Apply infrastructure PR to **dev only** with `ai_nova_enabled=true`; verify the chosen Nova model is actually available in that region/account. No static AWS keys.
2. Ensure API runtime ConfigMap gets `AI_CHAT_ENABLED=true`, `AI_GUEST_ENABLED=false`, `AI_BEDROCK_MODEL_ID=amazon.nova-lite-v1:0`, `AI_USER_DAILY_LIMIT=20`, `AI_GLOBAL_DAILY_LIMIT=250` via SSM/bootstrap GitOps contract. Do not assume Terraform variables automatically become container env.
3. Ship app PR to dev and run integration checks with valid Cognito sessions, deliberately invalid tokens, 429 quotas, two-user isolation, Bedrock AccessDenied, and service outage.
4. Check model costs/CloudWatch billing; cap spending via AWS Budgets (request ceiling is **not** a monetary hard cap). Rollback by setting AI_CHAT_ENABLED=false.
5. Only promote after dev acceptance; keep production AI disabled pending privacy/retention signoff and cost alarms.

## Missing before production-ready
- DynamoDB TTL attribute enablement and data deletion/retention policy.
- Robust request-size/token-cost budgets, per-IP guest abuse mitigation and AWS budget monitoring.
- Client-side history loading and conversation switching (backend endpoints exist).
- Distributed idempotency and in-flight per-user concurrency caps.
- Formal Bedrock availability verification, production observations, CI and security testing.
- Streamed responses and durable jobs are Phase 3.
