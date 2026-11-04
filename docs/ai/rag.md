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

BM25 (k1 1.2, b 0.75) with light stemming; the title and keywords count twice.
In-process and deterministic: no embedding model, no vector store, no extra AWS
cost. Retrieval stays public-only: nothing from a user's diagrams or workspace
is in this corpus.

## Evaluation (no model involved)

`__tests__/rag.eval.spec.js`:

- **Regression set** (33 questions, written with the keywords): each answer must
  be in the top 3, and at least 80% first.
- **Held-out set** (20 questions, written after the keywords, never tuned
  against): at least 80% in the top 3. Baseline at introduction: 17/20 top 3,
  9/20 first.
- An off-topic question retrieves nothing.

The held-out misses show where lexical search stops ("diagram is too big, I
cannot see everything" does not reach *Zooming*). Add embeddings (Cohere Embed
Multilingual v3 in ap-southeast-1, S3 Vectors) and rank with reciprocal rank
fusion when the held-out gate fails or the manual grows past a few hundred
sections; keep BM25 as one of the two rankings.

## Editing the manual

1. Edit `docs/manual/<page>.md` following its README's rules.
2. `npm run ai:manual --workspace=packages/axoview-backend`.
3. Add a question for a new task to the regression set; run the backend tests.
