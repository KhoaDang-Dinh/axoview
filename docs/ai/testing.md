# Phase 0 and progression checks

Phase 0: feature branches exist; contracts committed; /api/config returns all false by default and only literal true enables flags; frontend defaults absent/partial AI response to false; existing diagram/auth/share endpoints untouched; **no AWS resources deployed**. Existing lint, unit, build and E2E CI must pass before merge.

Stage 1: bubble on guest login, owner editor and public share. Drag vs click threshold, viewport bounds, minimize, mobile, focus/keyboard, overlay stacking; original editor operations still work; + only inside chat with OpenAI/Anthropic/Google groups and six client names. Flag off shows nothing; mock responses only.

Next: verify guest quotas and isolation; Bedrock permission/cost; SSE replay and pod restart; revoke share and OAuth grant; Drive authorization; RAG stale results; agent approval/version safety; GitOps dev -> canary -> prod.

Validation commands: npm ci; npm run lint; npm test; npm run build; npm run test:e2e. No live runtime was tested in Phase 0.
