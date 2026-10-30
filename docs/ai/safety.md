# Phase 2 AI safety baseline (draft, not production-certified)

The Axoview assistant is a privileged server API. Safety is defense-in-depth:
**verified identity > resource authorization > request quotas > input policy >
bounded public retrieval > retrieval checks > model > output policy > redacted
telemetry**. A prompt filter alone never creates a security boundary.

## Implemented on this branch
- Signed-in Cognito caller required at every AI route; no unverified user ID from prompts or JSON, and no anonymous Bedrock billing.
- Exact allowlist for AWS region/model and feature flag disabled by default; quota reservations in DynamoDB and bounded history/output.
- Existing Bedrock Guardrail must be configured with `AI_GUARDRAIL_ID` and `AI_GUARDRAIL_VERSION`; the API returns 503 without it rather than silently invoking a model.
- `ApplyGuardrail(INPUT)` before a call, on every retrieved passage, and `ApplyGuardrail(OUTPUT)` after a response. Prompt-attack tripwire for obvious instruction spoofing; it is not a general injection detector.
- Public-only, locally curated documentation retrieval and source IDs in the response. No private workspaces, external URLs, arbitrary user-uploaded text, embeddings or vector store are reachable in the RAG layer yet.
- Structured logs record only latency, stage/result, token counts, request UUID, retrieval count and timestamp. Never prompt text, model answer, diagram content or the Cognito subject.

## Security limitations and release blockers
- Bedrock Guardrails are probabilistic; tune prompt-attack policy, content filters, sensitive-information policy, denied topics and optional contextual-grounding measures, with adversarial evaluation.
- There is **no private diagram RAG** yet. Implement a separate tenant-authorized retrieval interface with permission rechecking at final context assembly and test revoked-share/Drive access.
- The current client has a single active in-memory conversation, and no full history switch UI; the backend retains a rolling 12-message window.
- Prevent prompt-injection via allowlisted tool schemas, strict separation of retrieved data from system instructions, no model-directed auth decisions. With no tools or private data attached this phase has a smaller blast radius.
- Add actual CloudWatch metrics/dashboard/alarms, AWS Budgets and per-model cost estimates. Logs are not dashboards; request quotas aren't currency budgets.
- A multi-pod, concurrent chat needs reservation/idempotency and shared in-flight limits beyond current daily quotas. Unexpected Bedrock failures remain fail-closed.
- Add and verify DynamoDB TTL, deletion and data retention policy before enabling production.
- Run full CI, model-region compatibility, credential/guardrail permission checks, red-team probes, cross-account retrieval isolation, 429 load tests and rollout rollback tests.

**Production activation remains prohibited until those gates are satisfied.**
