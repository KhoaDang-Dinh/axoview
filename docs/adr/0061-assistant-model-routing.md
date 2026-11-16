# ADR 0061 — Model Routing for the Assistant

**Status:** Proposed
**Date:** 2026-11-11
**Supersedes:** none
**Superseded by:** none

## Context

The assistant answers every message with one configured Amazon Nova model
(`AI_BEDROCK_MODEL_ID`, Nova Lite by default; [chat.js](../../packages/axoview-backend/src/ai/chat.js)).
A plain how-to question does not need more. The harder work does: suggesting changes to a shared
page, and using tools in the agent loop ([ADR 0060](0060-assistant-agent-loop.md)).

On 2026-11-11 the owner asked for model routing and first chose Amazon Bedrock's Intelligent Prompt
Routing. It does not fit this deployment:
- **Region:** AWS does not list `ap-southeast-1`, where we run.
- **Language:** it is tuned for English prompts only.
- **Unknowns:** its documentation does not say how it behaves with guardrails or tool calls, and
  both are on every message here.

The owner then chose our own rules.

Outside agents are unaffected: they bring their own model through the workspace MCP server
([ADR 0059](0059-agent-sign-in-and-workspace-mcp.md)).

## Decision

1. **Two tiers, chosen per message when `AI_MODEL_ROUTING_ENABLED` is true**
   ([modelRouting.js](../../packages/axoview-backend/src/ai/modelRouting.js)).
   - **Fast:** the configured model.
   - **Strong:** Nova Pro called the same way as the configured model (the same inference profile
     prefix), or `AI_BEDROCK_STRONG_MODEL_ID`.
2. **The rules use only what the endpoint already knows before any model call**, so routing costs
   nothing, and works in any language and region. First match wins:

   | Rule | When | Tier |
   |---|---|---|
   | `page` | the person shared the open page | strong |
   | `tools` | the agent loop is on and can read the person's diagrams | strong |
   | `long` | a question over 600 characters, or 8 or more earlier messages sent with it | strong |
   | `plain` | everything else | fast |

3. **A failing strong model never costs the answer.** If the strong call fails for any reason other
   than a safety block (not granted, throttled, down), the fast model answers that message, and the
   log records `fallback`.
4. **A setup that cannot route never stops chat.** If the strong model ID is invalid, or the
   configured model is already Nova Pro, routing is off with a warning and the configured model
   answers everything.
5. **Nothing else depends on the tier.** The quota still counts one message, whichever tier answers.
   The guardrail checks, the history, the suggestions, the approvals and the reply's shape are
   identical on both.
6. **Observable.** With routing on, the `ai.request` log line gains `model` (`fast` or `strong`) and
   `route` (the rule, or `fallback`). With routing off the line is unchanged.

## Consequences

**Positive:**
- **Cost and speed:** plain questions stay on the cheap, fast model. The stronger model is spent
  where a small one is weakest.
- **Safe to switch on:** off by default, and neither a wrong setting nor a failing strong model
  can break chat.

**Negative / risks:**
- **Cost per message:** a strong message costs more, but counts the same against the daily quota.
  If the split leans strong, the quota or its weighting needs revisiting.
- **The agent loop and `tools`:** where the agent loop runs with server storage, the `tools` rule
  sends every message to the strong model. That is deliberate until tool use is measured on Nova
  Lite; it may be relaxed after.
- **The rules are ours to tune.** The thresholds are a first guess; the log's split is what tunes
  them.

## Implementation notes (non-binding)

- **Infra:** the API's IAM grant covers the configured model only. The infra switch
  `ai_model_routing_enabled` (`DEV_`/`PROD_AI_MODEL_ROUTING_ENABLED`) adds the same grant for the
  strong model and publishes its ID, which sets `AI_MODEL_ROUTING_ENABLED` and
  `AI_BEDROCK_STRONG_MODEL_ID` for the API. Without the grant every strong call falls back.
- **Before switching on:** check that `apac.amazon.nova-pro-v1:0` is offered from the deployment's
  region: `aws bedrock get-inference-profile --region <region> --inference-profile-identifier apac.amazon.nova-pro-v1:0`.

## Acceptance criteria

- **Unit tests** (`modelRouting.spec.js`): each rule and its boundary; the strong model for each
  kind of configured ID; every setup problem is reported, not thrown.
- **Chat tests** (`chat.router.spec.js`):
  - routing off: the configured model answers everything and the log line is unchanged;
  - plain goes to fast, a shared page to strong, and the log says which;
  - a long question and a long conversation go to strong;
  - a failing strong model falls back and still passes the guardrail; a failing fast model is
    still an error with no second attempt;
  - the strong model's answer goes through the output guardrail;
  - a setup that cannot route leaves chat working;
  - with the agent loop, workspace tools select the strong agent model.
- **Before Accepted (dev, real Nova):** the same question set with routing on and off; compare
  quality, latency, tokens and the fast/strong split.
