/**
 * Text embeddings with Cohere Embed Multilingual v3 on Bedrock (1024 floats).
 * Available in ap-southeast-1, where Titan Text Embeddings V2 is not; the
 * multilingual model also matches questions asked in the app's other UI
 * languages against the English manual.
 *
 * Documents are embedded as `search_document` and questions as `search_query`:
 * Cohere v3 needs the two kinds kept apart to rank well.
 */
import { createAwsJsonClient } from './awsJson.js';

export const DEFAULT_EMBED_MODEL_ID = 'cohere.embed-multilingual-v3';
export const EMBED_DIMENSION = 1024;
const MODEL_RE = /^cohere\.embed-(?:multilingual|english)-v3$/;
const BATCH = 96;          // Cohere v3: texts per call
const MAX_CHARS = 2048;    // Cohere v3: characters per text

export function createEmbedder({ region, modelId = DEFAULT_EMBED_MODEL_ID, fetchImpl, credentials, call } = {}) {
  if (!MODEL_RE.test(modelId || '')) throw new Error('Use a Cohere Embed v3 model ID (cohere.embed-multilingual-v3)');
  const invoke = call || createAwsJsonClient({
    region, service: 'bedrock', hostname: `bedrock-runtime.${region}.amazonaws.com`, fetchImpl, credentials
  });
  const path = `/model/${encodeURIComponent(modelId)}/invoke`;

  /** embed(texts, 'search_document' | 'search_query') -> number[][] in the same order. */
  return async function embed(texts, inputType) {
    if (inputType !== 'search_document' && inputType !== 'search_query') throw new Error('Unknown embedding input type');
    const out = [];
    for (let start = 0; start < texts.length; start += BATCH) {
      const batch = texts.slice(start, start + BATCH).map((text) => String(text).slice(0, MAX_CHARS));
      const result = await invoke(path, { texts: batch, input_type: inputType, truncate: 'END' });
      // Without embedding_types the response is a plain array per text; with
      // them, an object keyed by type. Accept both.
      const embeddings = Array.isArray(result?.embeddings) ? result.embeddings : result?.embeddings?.float;
      if (!Array.isArray(embeddings) || embeddings.length !== batch.length ||
          embeddings.some((vector) => !Array.isArray(vector) || vector.length !== EMBED_DIMENSION)) {
        throw Object.assign(new Error('Unexpected embedding response'), { status: 502 });
      }
      out.push(...embeddings);
    }
    return out;
  };
}
