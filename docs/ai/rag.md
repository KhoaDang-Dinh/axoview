# Manual retrieval (public RAG)

The assistant answers "how do I…" questions from the user manual
([`docs/manual`](../manual/README.md)), not from the model's memory of other
diagram tools.

```text
docs/manual/*.md ──npm run ai:manual──▶ src/ai/corpus/manual.json (in the image)
                                              │
message ─▶ BM25 over title + section keywords + text ─▶ top 3 sections
        ─▶ guardrail on each section ─▶ prompt as "[source:<id>] <title>\n<text>"
        ─▶ reply cites [source ids]; the API returns { id, title } for each
```

## Chunks

One chunk per `##` section (`packages/axoview-backend/src/ai/manual.js`). A
section over 900 characters is split at paragraph boundaries (`<id>-2`, …).
Every chunk has:

| Field | Example |
|---|---|
| `id` | `connectors-rerouting-a-connector` (page + heading; must match `^[a-z0-9_-]+$`) |
| `title` | `Connectors › Rerouting a connector` |
| `text` | the section as plain text (no Markdown emphasis; tables as `a — b` rows) |
| `source` | `docs/manual/connectors.md#rerouting-a-connector` |
| `audience` | `public`, the only audience retrieval returns today |
| `keywords` | from `<!-- keywords: … -->` under the heading: words users type that the text does not |
| `hash` | content hash; the corpus `version` hashes them all |

`corpus/manual.json` is generated and committed. `manual.spec.js` rebuilds it
from the Markdown and fails when they differ, so a manual edit without
`npm run ai:manual` cannot merge. It also rejects a chunk that leans on
another section ("as above") because retrieved alone it means nothing.

## Ranking

Two rankings, fused by reciprocal rank fusion (`src/ai/docsSearch.js`, k = 60):

- **Keyword:** BM25 (k1 1.2, b 0.75) with light stemming; the title and keywords
  count twice. In-process, deterministic, free. It catches exact UI terms.
- **Vector:** the question embedded with Cohere Embed Multilingual v3
  (`search_query`, 1024 floats, Bedrock in ap-southeast-1, where Titan Text
  Embeddings V2 is not offered), matched in an S3 Vectors index of the same
  sections (`search_document`). It catches other wording and other languages.
  Matches farther than `AI_DOCS_MAX_DISTANCE` (cosine distance, default 0.6)
  count as unrelated, so an off-topic question still retrieves nothing.

The vector side is optional and fails open: with no index configured
(`AI_DOCS_VECTOR_BUCKET`, `AI_DOCS_VECTOR_INDEX`), or on any Bedrock or
S3 Vectors error, search is keyword-only and reports `mode: keyword`. Index
entries are keys only (section id plus `{ audience, hash }` metadata); the text
always comes from the corpus the image ships, so an entry left by another
release cannot inject text. Retrieval stays public-only: nothing from a user's
diagrams or workspace is in this corpus.

## The vector index

Terraform creates one S3 Vectors bucket and index per environment
(infra `modules/environment/docs_search.tf`). The **docs-index** PostSync Job runs
`node src/cli/index-manual.js` from the API image after each release, with its
own role:
- it re-embeds only the sections whose hash changed and deletes the ones that
  left the manual, so a release that leaves the manual alone costs nothing;
- it prints `axoview_docs_index result=ok|skipped|failed …`;
- it always exits 0, because the API's keyword fallback covers a missing or
  stale index and a failed index must not fail a release.

The API's role may only query the index.

## Who reads it

| Reader | How |
|---|---|
| The Axoview assistant | the fused search above, 3 sections per message |
| Any MCP client | `search_manual` / `get_manual_section` at `/api/mcp` ([mcp.md](mcp.md)) |
| Any AI or crawler | `/llms.txt`, `/llms-full.txt`, `/docs/manual/*.md`, built with the app |

## Evaluation (no model involved)

`__tests__/rag.eval.spec.js`:

- **Regression set** (35 questions, written with the keywords): each answer must
  be in the top 3, and at least 80% first.
- **Held-out set** (20 questions, written after the keywords, never tuned
  against): at least 80% in the top 3. Baseline at introduction: 17/20 top 3,
  9/20 first.
- An off-topic question retrieves nothing.

These run against the keyword ranking, so CI needs no AWS. The held-out misses
show where keyword search stops ("diagram is too big, I cannot see everything"
does not reach *Zooming*); `docsVectors.spec.js` checks that the fused search
reaches it when the vector side ranks it. To measure the real vector side,
run `kubectl -n axoview exec deploy/axoview-api -- node src/cli/eval-docs-search.js`
in dev after the docs-index Job (same questions,
`src/ai/__fixtures__/retrieval-questions.json`; one embedding call each) and
record the result here before changing `AI_DOCS_MAX_DISTANCE`.

## Editing the manual

1. Edit `docs/manual/<page>.md` following its README's rules.
2. `npm run ai:manual --workspace=packages/axoview-backend`.
3. Add a question for a new task to the regression set; run the backend tests.
