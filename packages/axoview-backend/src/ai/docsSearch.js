/**
 * Manual search shared by the assistant (chat.js) and the public MCP endpoint
 * (mcp.js): keyword ranking (BM25, rag.js) fused with vector ranking (Cohere
 * embeddings in S3 Vectors) by reciprocal rank fusion.
 *
 * Keywords catch exact UI terms ("Ctrl+Z", "Export Project (.zip)"); vectors
 * catch questions phrased in other words or other languages ("the diagram is
 * too big to see" -> Zooming). Fusing ranks, not scores, needs no calibration
 * between the two.
 *
 * The vector side is optional and fails open: without an index configured, or
 * when Bedrock or S3 Vectors errors, the search is keyword-only and says so
 * (`mode`). Results are always sections of the corpus this image ships, so an
 * index entry from another release can never inject text.
 */
import { PUBLIC_KNOWLEDGE, rankKnowledge } from './rag.js';
import { createEmbedder } from './embeddings.js';
import { createVectorIndex } from './vectorIndex.js';

export const RRF_K = 60;
const CANDIDATES = 10;
// Cosine distance (1 - similarity) above which a vector match is treated as
// unrelated. Cohere v3 puts related text roughly 0.3-0.6 apart; tune with
// AI_DOCS_MAX_DISTANCE against the retrieval evaluation (docs/ai/rag.md).
export const DEFAULT_MAX_DISTANCE = 0.6;

/** rankings: arrays of ids, best first -> [{ id, score }] by reciprocal rank fusion. */
export function fuseRankings(rankings, k = RRF_K) {
  const scores = new Map();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1)));
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/**
 * search(query, { limit }) -> { items: [{ id, title, text, source }], mode: 'hybrid' | 'keyword', vectorError? }
 */
export function createDocsSearch({
  corpus = PUBLIC_KNOWLEDGE,
  embed = null,
  index = null,
  maxDistance = DEFAULT_MAX_DISTANCE,
  log = console
} = {}) {
  const byId = new Map(corpus.map((chunk) => [chunk.id, chunk]));
  const audiences = [...new Set(corpus.map((chunk) => chunk.audience))];

  async function vectorRanking(query) {
    const [vector] = await embed([query], 'search_query');
    const matches = await index.query(vector, {
      topK: CANDIDATES,
      filter: audiences.length === 1 ? { audience: audiences[0] } : { audience: { $in: audiences } }
    });
    return matches
      .filter((match) => byId.has(match.key) && typeof match.distance === 'number' && match.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .map((match) => match.key);
  }

  return async function search(query, { limit = 3 } = {}) {
    const keyword = rankKnowledge(query, corpus).slice(0, CANDIDATES).map(({ item }) => item.id);
    let vector = [];
    let mode = 'keyword';
    let vectorError;
    if (embed && index && String(query).trim()) {
      try {
        vector = await vectorRanking(query);
        mode = 'hybrid';
      } catch (error) {
        vectorError = String(error?.awsType || error?.name || 'error');
        log.warn?.('[ai] docs vector search unavailable, keyword only: %s', vectorError);
      }
    }
    const items = fuseRankings([keyword, vector])
      .slice(0, Math.max(0, Math.min(10, limit)))
      .map(({ id }) => byId.get(id))
      .map(({ id, title, text, source }) => ({ id, title, text, source }));
    return { items, mode, ...(vectorError ? { vectorError } : {}) };
  };
}

/** The search this deployment is configured for (keyword-only without an index). */
export function docsSearchFromEnv(env = process.env, options = {}) {
  const region = env.AI_BEDROCK_REGION || env.AWS_REGION;
  const bucket = env.AI_DOCS_VECTOR_BUCKET;
  const indexName = env.AI_DOCS_VECTOR_INDEX;
  if (!region || !bucket || !indexName) return createDocsSearch(options);
  try {
    const maxDistance = Number(env.AI_DOCS_MAX_DISTANCE);
    return createDocsSearch({
      ...options,
      embed: createEmbedder({ region, ...(env.AI_EMBED_MODEL_ID ? { modelId: env.AI_EMBED_MODEL_ID } : {}) }),
      index: createVectorIndex({ region, bucket, index: indexName }),
      ...(maxDistance > 0 && maxDistance <= 2 ? { maxDistance } : {})
    });
  } catch (error) {
    (options.log || console).error('[ai] docs vector search disabled, invalid configuration: %s', error?.message);
    return createDocsSearch(options);
  }
}
