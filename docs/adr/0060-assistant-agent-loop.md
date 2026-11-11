# ADR 0060 — The Assistant's Agent Loop (Strands)

**Status:** Proposed
**Date:** 2026-11-11
**Supersedes:** none
**Superseded by:** none

## Context

Today the assistant (Nova) answers each message with one Bedrock call
([chat.js](../../packages/axoview-backend/src/ai/chat.js)). The top manual sections and, if shared,
the open page go in with the question, and suggested changes come back as a JSON block
([suggestions.js](../../packages/axoview-backend/src/ai/suggestions.js)).

That single call cannot:
- search the manual again in other words;
- read a whole section;
- look at another of the person's diagrams.

Outside agents already have tools through the workspace MCP server
([ADR 0059](0059-agent-sign-in-and-workspace-mcp.md)).

On 2026-11-10 the owner compared Bedrock AgentCore, Strands and LangGraph, then asked for Strands
with RAG and MCP:
- **AgentCore:** a second place to host and run agents, and we already have EKS and our own sign-in.
- **LangGraph:** its strength is pausing mid-run for a person. Our approvals already happen outside
  the run ([ADR 0057 addendum 3](0057-diagram-sharing-and-permissions.md)).

So the gap is only a tool-calling loop inside the existing API.

## Decision

1. **A Strands Agents (TypeScript SDK) loop runs each message when `AI_NOVA_AGENT_ENABLED` is
   true** ([novaAgent.js](../../packages/axoview-backend/src/ai/novaAgent.js)).
   - **Model:** Amazon Nova through the SDK's `BedrockModel`, with the API's IAM role.
   - **Limits:** at most 6 model turns and 24,000 tokens per message, inside the per-user daily
     quota, which still counts messages.
   - **Unchanged:** the request, the history, the reply shape (reply, sources, suggestions) and
     the single-call path when the flag is off.
2. **Tools:**

   | Tool | Source | Offered |
   |---|---|---|
   | `search_manual`, `get_manual_section` | The manual search (keyword + vector, [docsSearch.js](../../packages/axoview-backend/src/ai/docsSearch.js)) and the shipped corpus | always |
   | `list_diagrams`, `read_diagram` | [workspaceReader.js](../../packages/axoview-backend/src/ai/workspaceReader.js), shared with the workspace MCP server: the person's diagrams and those shared with them | with server storage |
   | `suggest_changes` | The `diagramAgent` vocabulary, validated like the suggestion block | only when the person shared the open page |

   The top manual sections still go in with the question, so a one-turn answer is as good as before.
3. **RAG stays our own search, used as a tool.** It is not moved to a Bedrock Knowledge Base or to
   the SDK's own vector store: ours already combines keyword and vector search, falls back to
   keyword-only, and only ever returns sections of the manual this release ships.
4. **MCP means one set of tools for every agent.** Nova and the workspace MCP server read through
   the same code in the API, with the same rights. Nova does not call our MCP endpoint over HTTP,
   which would add a loopback hop and a token to mint. It uses no outside MCP servers either.
5. **The same safety for tool results.** Text that a user wrote or that was retrieved is screened
   for prompt injection and checked by the Bedrock guardrail before Nova reads it, and it is marked
   as data. Nova never changes a diagram: its suggestions go to the existing checklist and the
   person's approval.

## Consequences

**Positive:**
- **Answers:** Nova can search again, open sections and read other diagrams, so it gives better
  answers to questions that need more than the first three sections.
- **One tool surface:** every agent, inside or outside, uses one set of tools and one approval path.

**Negative / risks:**
- **Cost and speed:** a message costs 2–4 Nova calls instead of 1, and answers are slower. Neither
  is measured yet on Nova.
- **Unproven:** Nova Lite's tool-use quality is untested; that is why this ADR is Proposed and the
  flag is off.
- **Dependencies:** `@strands-agents/sdk` 1.24 and its required add-ons (MCP client,
  OpenTelemetry API, zod) and `@aws-sdk/client-bedrock-runtime` 3.1165. The shared `@aws-sdk/core`
  moves to 3.980.2; the other AWS clients stay at 3.1152.

## Acceptance criteria

- **Unit tests** (`novaAgent.spec.js`, with a scripted model in place of Bedrock):
  - which tools are offered, and history passed through;
  - manual sections come back marked as data and become the citable sources;
  - a section with an injection or a guardrail hit is withheld;
  - the workspace tools act as the person and never beyond;
  - invalid operations are reported back to the model;
  - the turn limit stops a model that keeps calling tools.
- **Chat test:** with the flag on, tools produce the suggestions and sources and the single-call path
  is unused.
- **Before Accepted (dev, real Nova):** the manual-search evaluation and a short agent question set
  run with the flag on and off; quality, latency and tokens per message are compared.
