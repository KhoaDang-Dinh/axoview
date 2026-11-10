# ADR 0052 — Additive AI assistant and MCP access

**Status:** Accepted design baseline (2026-10-29); implementation is gated.

Axoview retains existing toolbar, canvas, explorer, sharing and Cognito. Add only a draggable AI bubble, expandable chat, down-arrow minimize, and a small **+ inside chat header**. Mount outside Cognito sign-in gate and canvas clipping. Guest, signed-in and view-only contexts have independent, server-enforced permissions. A logged-in viewer is still read-only.

Built-in Bedrock and external remote MCP use shared authorized diagram services, but external ChatGPT/Codex, Claude/Claude Code and Gemini/Gemini CLI operate their own models. Group UI choices by OpenAI, Anthropic, Google; grants are **per client**, never automatically shared.

Keep /api/sync/events diagram-change SSE separate from agent activity SSE. HTTP commands create/cancel/approve runs; SSE observes durable state. Direct current-diagram analysis precedes RAG; read-only MCP precedes approval/version-gated writes.

All Phase 0 feature flags are false by default. No AI UI, model invocation, MCP endpoint, OAuth server, vector index, SQS or AWS resource is deployed. Existing SPA Cognito auth is not full MCP OAuth; plan separate OAuth metadata, consent and CloudFront discovery routing in Stage 5. The static / landing page is distinct from /app.

Rationale: additive delivery, strong share isolation, limited costs, flag rollback and compatibility with GitOps and canary.

Details: [AI implementation contracts](../ai/README.md).

## Addendum — 2026-11-04: diagram primitives, recommend before write

**Decision.** The diagram operations an agent may use are defined once, in
axoview-lib (`src/agent`, exported as `diagramAgent` from the Node-safe
standalone bundle): a small semantic vocabulary (`add_node`, `rename_node`,
`set_notes`, `remove_node`, `connect`, `disconnect`, `group`, `add_note`) that
names items the way a person does, never tiles, anchors or colours.

- `describeDiagram` turns one page into bounded data for a model: names, icons,
  connections, rectangle membership and page text. Never notes, links or
  styling.
- `planOperations` checks proposed operations against the live page without
  changing it, in order (a later step sees what an earlier one adds), and turns
  each into a step with a reason it does not apply, or how to do it by hand.
- `applyOperations` performs the ready steps on a copy and refuses to return a
  model the schema rejects. **It is not wired to any UI or API.**

The assistant only **recommends**: with `AI_DIAGRAM_CONTEXT_ENABLED`, the user
may tick "Include this page", the API passes the description to the model as
nonce-marked data (guardrail-checked, never stored), the model may end its reply
with a `suggestions` block, the API keeps only operations that pass its
validator, and the app shows them as a checklist the user carries out.

**Why.** Recommending first proves the vocabulary, the page description and the
prompt on real diagrams while a wrong suggestion costs nothing. Writes later
reuse the same three functions behind approval, undo and version checks; the
MCP write tools expose the same vocabulary rather than a second one.

**Contract.** The API checks suggestions with a dependency-free copy of the
vocabulary's shape rules; `packages/axoview-backend/src/ai/__fixtures__/suggestions.contract.json`
is asserted by both test suites so the two cannot drift. Answers about using
Axoview come from the user manual ([docs/ai/rag.md](../ai/rag.md)).

## Addendum — 2026-11-10: approve, then apply (the in-app assistant)

**Decision.** The first write. The owner set the permission model
([ADR 0057 addendum 3](0057-diagram-sharing-and-permissions.md)): an agent works on its person's
account, its person sets once what it may do, and only that person approves its changes.

- **Where:** with `AI_AGENT_WRITE_ENABLED` (off by default), server storage and diagram context, the
  chat shows "Nova may": *Read only: suggest, never change* (the default) or *Changes need my
  approval*. The setting is the account's (`GET`/`PUT /api/agent`).
- **How:** under approval, each ready step in the checklist gets **Approve**, and there is
  **Approve all**.
  - **Applying:** the app hands the operations to the editor (`AxoviewRef.applyAgentOperations`).
    It runs `applyOperations` on the live model and lands the result as **one undoable change**,
    stamped with its page. One Undo takes the whole approval back. The scene is rebuilt, so new
    connectors are routed at once.
  - **Saving:** the change is saved like any edit. It goes through the person's own save, so the
    sharing rules and the version checks apply unchanged.
  - **After approving:** the steps left are re-checked against the changed page. A step that no
    longer applies is not made, and the chat says why.
- **Never above the person:** on a read-only view (a public link, a Drive file, a diagram shared
  as Read only) there is nothing to approve. The chat says Nova is "Read only here, like you".
- **Still not wired:** model tool calls that write by themselves, and the MCP write tools. When
  outside agents get MCP sign-in, their changes go to the person as stored proposals (ADR 0057
  addendum 3), never straight to the diagram.

**Why.** The vocabulary, the page description and the checks had been proven by recommending
(the addendum above). Approving one step at a time keeps the person in charge. Applying through
the editor means approved changes get undo, saving and sharing for free.

## Addendum — 2026-11-04: the manual as public RAG for every AI

**Decision.** The user manual is public reference material, available to any AI
three ways from one source (`docs/manual`):

1. **The assistant** retrieves it by keyword and vector search fused by rank
   (Cohere Embed Multilingual v3 and S3 Vectors in the environment's region).
2. **Any MCP client** can search and read it at `/api/mcp`, with no sign-in. The
   endpoint has two read-only tools, follows MCP 2026-07-28, and also answers
   legacy `initialize` clients.
3. **Any AI or crawler** can read `/llms.txt`, `/llms-full.txt` and
   `/docs/manual/*.md`, built with the app.

**Boundary.** This anonymous MCP surface exposes only the shipped public corpus.
It never touches diagrams, accounts or a model, and the query text is never
logged. Workspace MCP stays behind OAuth as designed above.

Paid work (embedding a query) is capped per pod per day. Past the cap, search is
keyword-only. The vector side fails open to keyword search. Index entries carry
keys, not text, so a stale or tampered index cannot change what is returned.
Writing to the index is a separate Job role; the API can only query it.
