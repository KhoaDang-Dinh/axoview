#!/usr/bin/env node
/**
 * Syncs the public docs vector index with the manual this image ships
 * (src/ai/docsIndexer.js). Run by the docs-index PostSync Job after each
 * release; configuration comes from axoview-runtime-config:
 *   AWS_REGION, AI_DOCS_VECTOR_BUCKET, AI_DOCS_VECTOR_INDEX, AI_EMBED_MODEL_ID
 *
 * Prints one line, `axoview_docs_index result=ok|skipped|failed ...`, for the
 * CloudWatch dashboard, and always exits 0: the API falls back to keyword
 * search when the index is missing or stale, so a failed index must not fail
 * the release.
 */
import { MANUAL_CHUNKS, MANUAL_VERSION } from '../ai/rag.js';
import { createEmbedder } from '../ai/embeddings.js';
import { createVectorIndex } from '../ai/vectorIndex.js';
import { syncManualIndex } from '../ai/docsIndexer.js';

export async function runIndexManual(env = process.env, { log = console.log, createIndex = createVectorIndex, createEmbed = createEmbedder } = {}) {
  const region = env.AWS_REGION;
  const bucket = env.AI_DOCS_VECTOR_BUCKET;
  const indexName = env.AI_DOCS_VECTOR_INDEX;
  if (!region || !bucket || !indexName) {
    log('axoview_docs_index result=skipped reason=not_configured');
    return 'skipped';
  }
  const started = Date.now();
  try {
    const counts = await syncManualIndex({
      chunks: MANUAL_CHUNKS,
      embed: createEmbed({ region, ...(env.AI_EMBED_MODEL_ID ? { modelId: env.AI_EMBED_MODEL_ID } : {}) }),
      index: createIndex({ region, bucket, index: indexName })
    });
    log(`axoview_docs_index result=ok index=${bucket}/${indexName} manual=${MANUAL_VERSION}` +
      ` added=${counts.added} updated=${counts.updated} removed=${counts.removed} unchanged=${counts.unchanged}` +
      ` ms=${Date.now() - started}`);
    return 'ok';
  } catch (error) {
    // The AWS error type only (AccessDeniedException, ...): never a body.
    const reason = String(error?.awsType || error?.name || 'error').replace(/[^A-Za-z0-9_.-]/g, '');
    log(`axoview_docs_index result=failed index=${bucket}/${indexName} manual=${MANUAL_VERSION} reason=${reason}` +
      `${error?.status ? ` status=${error.status}` : ''}`);
    return 'failed';
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runIndexManual();
}
